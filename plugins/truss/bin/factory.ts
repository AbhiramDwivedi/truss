// truss ADR-0009 Decision 1: the factory CLI. Run as `node <plugin>/bin/factory.ts <command> [flags]`. Every command
// prints one JSON object on one line; exit 0 = done, 1 = a gate or expectation refused, 2 = usage or I/O error
// ({"error": "..."}). Node built-ins and ../hooks/register.ts only.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync, appendFileSync, closeSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { goalOf, RUN_GOAL } from '../hooks/intake.ts'
import { fencedBlock, qcFails, qcK, localTime, parsePlan, planVerdict, unbannered } from '../hooks/register.ts'
import type { QcFile } from '../hooks/register.ts'
import { budgetsOf, lint as knowledgeLint, migrate as knowledgeMigrate, rulesIndex as knowledgeRulesIndex } from './knowledge.ts'
import type { KCfg, LintResult } from './knowledge.ts'
import type { Catalog } from '../retro/catalog.ts'

// retro/ is loaded lazily, so a plugin copy without it still runs every other command; a command that needs it says so.
let retroMods: { cat: typeof import('../retro/catalog.ts'); ex: typeof import('../retro/extract.ts') } | undefined
try {
  retroMods = { cat: await import('../retro/catalog.ts'), ex: await import('../retro/extract.ts') }
} catch {
  retroMods = undefined
}
const retro = (): NonNullable<typeof retroMods> => {
  if (retroMods === undefined) throw new Error('retro/ is not in this plugin copy')
  return retroMods
}

// ==== core ====

// ADR-0037: the shared helpers live in store.ts and are re-exported here, so existing imports keep working.
import { CliError, StoreBusy, usage, refuse, flat, str, need, listOf, isObj, readText, readJson, parseLabel, repoPathOf, configOf, packageName, declares, withLock, writeJsonAtomic, commonDir } from './store.ts'
import type { Flags, Obj } from './store.ts'
export { CliError, usage, refuse, flat, str, need, listOf, isObj, readText, readJson, parseLabel, repoPathOf, configOf }
export type { Flags, Obj }
import { INBOX_COMMANDS, approvalProof, blockingFor, confirmApproval, escalate, onPlanApprove } from './inbox.ts'
import { COST_COMMANDS, budgetVerdict, crewCost } from './cost.ts'
import { QUEUE_COMMANDS } from './queue.ts'
import { WORKTYPE_COMMANDS, profilesOf, workTypeErrors } from './worktypes.ts'
import { ltcCrewGate, ltcPlan, ltcPlanGate } from './guard.ts'
import { ledgerAppend } from './ledger.ts'

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')

// Flags as `--key value` or `--key=value` (the `=` form is the safe one for a value that starts with `--`); a flag with no value
// is true; a repeated flag becomes a list.
function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw usage(`unexpected argument: ${a}`)
    const eq = a.indexOf('=')
    const key = eq < 0 ? a.slice(2) : a.slice(2, eq)
    const next = argv[i + 1]
    const value: string | boolean = eq >= 0 ? a.slice(eq + 1) : next === undefined || next.startsWith('--') ? true : (i++, next)
    const old = flags[key]
    flags[key] = old === undefined ? value : [...(Array.isArray(old) ? old : [String(old)]), String(value)]
  }
  return flags
}
// Runs git in `cwd` and returns status, trimmed stdout and stderr.
function run(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.error) throw usage(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
function gitOrFail(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (r.status !== 0) throw usage(`git ${args.join(' ')} failed: ${r.err || r.out}`)
  return r.out
}

function repoOf(f: Flags): string {
  const given = str(f, 'repo')
  if (given !== undefined && given !== '') return flat(given)
  const r = run(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (r.status !== 0) throw usage('no --repo and the cwd is not in a git repository')
  return flat(r.out)
}
// ADR-0027 F-67 item 2: every command but start refuses a relative --dir, since a relative one resolves against
// whatever cwd ran it. start (and start --resume) resolve it themselves through startDirOf, as ADR-0019 item 18 left them.
const startDirOf = (f: Flags): string => flat(need(f, 'dir'))
const dirOf = (f: Flags): string => {
  const d = need(f, 'dir')
  if (!path.isAbsolute(d)) throw usage(`--dir must be an absolute path, got ${d}`)
  return flat(d)
}

// The plan object from D/plan.json (usage error when missing or unreadable).
export function loadPlan(dir: string): Obj {
  const plan = readJson(`${dir}/plan.json`)
  if (!isObj(plan) || !Array.isArray(plan.crews)) throw usage(`${dir}/plan.json is not a plan`)
  return plan
}
// Writes the plan object back to D/plan.json, 2-space JSON with a trailing newline.
export function savePlan(dir: string, plan: Obj): void {
  writeJsonAtomic(`${dir}/plan.json`, plan)
}
// Re-reads plan.json under the plan lock, lets `change` edit that fresh copy, and saves it, so a write never drops another
// command's edit (owns-extend, start, approve, mark-merged and the merge gate all write the plan).
function patchPlan(dir: string, change: (plan: Obj) => void): Obj {
  return withLock(dir, 'plan', (): Obj => {
    const plan = loadPlan(dir)
    change(plan)
    savePlan(dir, plan)
    return plan
  })
}

// The repo's merge mode and target branch, and where they came from, as `settings` prints them.
export function settingsOf(repo: string): { merge: string; target: string; source: string } {
  let cfg: Obj = {}
  const p = `${repo}/.claude/truss.json`
  if (existsSync(p)) {
    const v = readJson(p)
    if (isObj(v)) cfg = v
  }
  const hasMerge = typeof cfg.merge === 'string' && cfg.merge !== ''
  const hasTarget = typeof cfg.target === 'string' && cfg.target !== ''
  const target = hasTarget ? cfg.target : run(repo, ['branch', '--show-current']).out
  return { merge: hasMerge ? cfg.merge : 'sequential', target, source: hasMerge && hasTarget ? '.claude/truss.json' : hasMerge || hasTarget ? 'mixed' : 'default' }
}
const intOr = (v: unknown, dflt: number, min: number): number => (Number.isInteger(v) && (v as number) >= min ? (v as number) : dflt)

// The knowledge step's doc keys (ADR-0033) as stage.js args: only the ones set to a valid path. adrDir falls back to `adr`, the
// ADR directory key init already writes.
function docKeysOf(repo: string): { featureMap?: string; adrDir?: string } {
  const cfg = configOf(repo)
  const featureMap = repoPathOf(cfg.featureMap)
  const adrDir = repoPathOf(cfg.adrDir) ?? repoPathOf(cfg.adr)
  return { ...(featureMap === undefined ? {} : { featureMap }), ...(adrDir === undefined ? {} : { adrDir }) }
}
// ADR-0035: the path-scoped knowledge keys of truss.json, each a valid repo path or its default.
export function knowledgeCfgOf(repo: string): KCfg {
  return knowledgeCfgFrom(configOf(repo))
}
function knowledgeCfgFrom(cfg: Obj): KCfg {
  return {
    featureMap: repoPathOf(cfg.featureMap) ?? 'docs/features.md',
    productDecisions: repoPathOf(cfg.productDecisions) ?? 'docs/knowledge/product-decisions.md',
    knowledgeDir: repoPathOf(cfg.knowledgeDir) ?? 'docs/knowledge',
    rulesDir: repoPathOf(cfg.rulesDir) ?? '.claude/rules',
    agentsIndex: repoPathOf(cfg.agentsIndex) ?? 'AGENTS.md',
    budgets: budgetsOf(cfg.knowledgeBudgets),
  }
}
// The stage args (and plan-args) that carry the knowledge layout, next to featureMap: a path key set to a valid path in truss.json
// always (stage.js and the lint must use the same path even before the file exists), a default one only when its file or dir
// exists; `rules` ([{path, paths}]) only when there are rule files; in the stage args, `knowledgeBudgets` (all six, defaults filled
// in) whenever truss.json sets it.
function knowledgeArgsOf(repo: string, withRules: boolean): Obj {
  const k = knowledgeCfgOf(repo)
  const cfg = configOf(repo)
  const out: Obj = {}
  for (const key of ['productDecisions', 'agentsIndex', 'rulesDir', 'knowledgeDir'] as const) {
    if (repoPathOf(cfg[key]) !== undefined || existsSync(`${repo}/${k[key]}`)) out[key] = k[key]
  }
  if (withRules && isObj(cfg.knowledgeBudgets)) out.knowledgeBudgets = k.budgets
  if (withRules && out.rulesDir !== undefined) {
    try {
      const rules = knowledgeRulesIndex(repo, k).rules
      if (rules.length > 0) out.rules = rules
    } catch {
      // not a git repo or git failed: the crew runs without the rules list
    }
  }
  return out
}

// The crew worktree path <repo>/.claude/worktrees/truss-<slug>.
export function crewWorktree(repo: string, slug: string): string {
  return `${repo}/.claude/worktrees/truss-${slug}`
}
// `git merge-base <target> HEAD` in the worktree: the target head last merged into the crew branch.
export function baseOf(worktree: string, target: string): string {
  return gitOrFail(worktree, ['merge-base', target, 'HEAD'])
}

// Appends {"v":1,"ts":now,...obj} as one line to D/events.jsonl.
export function appendEvent(dir: string, obj: Obj): void {
  appendFileSync(`${dir}/events.jsonl`, JSON.stringify({ v: 1, ts: new Date().toISOString(), ...obj }) + '\n')
}
// Appends `- HH:MM | <what | why> | none | followed` (local time, localTime from the hooks) to D/decisions.md; text is "what | why".
export function appendDecision(dir: string, text: string): void {
  appendDecisionLine(dir, `- ${localTime(Date.now())} | ${text} | none | followed`)
}
// The one append step appendDecision and `decide` share (ADR-0027 F-73): a newline guard, then the line and its newline.
function appendDecisionLine(dir: string, line: string): void {
  const p = `${dir}/decisions.md`
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  appendFileSync(p, `${old === '' || old.endsWith('\n') ? '' : '\n'}${line}\n`)
}
// The roles table from <plugin>/workflows/roles.json.
export function readRoles(plugin: string): Obj {
  const v = readJson(`${plugin}/workflows/roles.json`)
  if (!isObj(v)) throw usage('roles.json is not an object')
  return v
}

export type RunAgent = { agentId: string; label: string; phase: string | undefined; hasResult: boolean; result: unknown; meta: Obj | undefined; transcript: string }
export type WfRun = { id: string; dir: string; journal: Obj[]; agents: RunAgent[] }
const jsonLines = (p: string): Obj[] =>
  readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').flatMap((l) => {
    try {
      const v = JSON.parse(l)
      return isObj(v) ? [v] : []
    } catch {
      return []
    }
  })
// One Workflow run dir read: its journal lines and, per `started` line, the agent's label, last result, meta file and transcript path.
export function runOf(runDir: string): WfRun {
  const dir = flat(runDir)
  const journalPath = `${dir}/journal.jsonl`
  const journal = existsSync(journalPath) ? jsonLines(journalPath) : []
  const agents: RunAgent[] = []
  for (const line of journal) {
    if (line.type !== 'started' || typeof line.agentId !== 'string' || typeof line.label !== 'string') continue
    const results = journal.filter((l) => l.type === 'result' && l.agentId === line.agentId)
    const metaPath = `${dir}/agent-${line.agentId}.meta.json`
    agents.push({
      agentId: line.agentId, label: line.label, phase: typeof line.phase === 'string' ? line.phase : undefined,
      hasResult: results.length > 0, result: results.length > 0 ? results[results.length - 1].result : undefined,
      meta: existsSync(metaPath) ? readJson(metaPath) : undefined, transcript: `${dir}/agent-${line.agentId}.jsonl`,
    })
  }
  return { id: path.basename(dir), dir, journal, agents }
}
// Every run dir under the transcripts root (sorted by name), each read with runOf.
export function runsOf(transcriptsDir: string): WfRun[] {
  const root = flat(transcriptsDir)
  if (!existsSync(root)) return []
  return readdirSync(root).sort().filter((n) => statSync(`${root}/${n}`).isDirectory()).map((n) => runOf(`${root}/${n}`))
}

// First and last record timestamp, the model, the request effort and the tool uses of an agent transcript.
export function transcriptFacts(agentJsonl: string): { firstTs: string | undefined; lastTs: string | undefined; model: string | undefined; effort: string | undefined; tools: { name: string; input: Obj }[] } {
  const facts = { firstTs: undefined as string | undefined, lastTs: undefined as string | undefined, model: undefined as string | undefined, effort: undefined as string | undefined, tools: [] as { name: string; input: Obj }[] }
  if (!existsSync(agentJsonl)) return facts
  for (const rec of jsonLines(agentJsonl)) {
    if (typeof rec.timestamp === 'string') {
      facts.firstTs ??= rec.timestamp
      facts.lastTs = rec.timestamp
    }
    const effort = rec.message?.output_config?.effort ?? rec.output_config?.effort
    if (typeof effort === 'string') facts.effort = effort
    if (rec.type === 'assistant' && isObj(rec.message)) {
      if (typeof rec.message.model === 'string') facts.model = rec.message.model
      if (Array.isArray(rec.message.content)) for (const c of rec.message.content) if (isObj(c) && c.type === 'tool_use') facts.tools.push({ name: String(c.name), input: isObj(c.input) ? c.input : {} })
    }
  }
  return facts
}

// The newest mtime (ms) over a run's journal.jsonl and every agent-*.jsonl; 0 when none.
export function newestMtime(runDir: string): number {
  const dir = flat(runDir)
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const n of readdirSync(dir)) if (n === 'journal.jsonl' || (n.startsWith('agent-') && n.endsWith('.jsonl'))) newest = Math.max(newest, statSync(`${dir}/${n}`).mtimeMs)
  return newest
}
// 30 minutes: a run with nothing newer than this is not live (ADR-0009 "start, stale runs", rule 3).
export const STALE_MS = 1800000
// Rule 3: live unless the crew's newest factory spawn (ISO string or ms) and the run's newest mtime are both more than STALE_MS before `now`.
export function isLive(spawnTs: string | number, runDir: string | undefined, now: number): boolean {
  const spawn = typeof spawnTs === 'number' ? spawnTs : Date.parse(spawnTs)
  const newest = runDir === undefined ? 0 : newestMtime(runDir)
  return !(now - spawn > STALE_MS && now - newest > STALE_MS)
}

// The crew's report files D/reports/<slug>/*.md as QcFile[] ({name with .md, text, mtimeMs}), sorted by name.
export function reportsOf(dir: string, slug: string): QcFile[] {
  const d = `${dir}/reports/${slug}`
  if (!existsSync(d)) return []
  return readdirSync(d).filter((n) => n.endsWith('.md')).sort().map((name) => ({ name, text: readFileSync(`${d}/${name}`, 'utf8'), mtimeMs: statSync(`${d}/${name}`).mtimeMs }))
}
// The k of the crew's newest logged re-plan, decision line `re-planned: <slug> from qc-<k>`, or undefined when none.
export function replannedFrom(log: string, slug: string): number | undefined {
  let k: number | undefined
  for (const m of log.matchAll(/^- [^|]*\|\s*re-planned: ([A-Za-z0-9._-]+) from qc-(\d+)\b/gm)) if (m[1] === slug) k = Number(m[2])
  return k
}
// The crew's QC files that count toward its spend: a logged re-plan starts a fresh count, so only -qc-<k> and later count.
export function countedQc(dir: string, slug: string, files: readonly QcFile[]): QcFile[] {
  const p = `${dir}/decisions.md`
  const k = existsSync(p) ? replannedFrom(readFileSync(p, 'utf8'), slug) : undefined
  return k === undefined ? [...files] : files.filter((f) => qcK(f.name) >= k)
}
// The first non-empty line of a report text, trimmed ('' when none), past a BOM and one leading
// "[harness:" paragraph, as stage.js's unbannered and the QC count read the same reply.
const firstLine = (text: string): string => unbannered(text.replace(/^﻿/, '').replace(/\r/g, '')).split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
// The crew's ux report files `<slug>-ux.md` and `<slug>-ux-<n>.md` (interim `.run<k>.md` files never match), with their label number.
const uxReports = (slug: string, files: readonly QcFile[]): (QcFile & { n: number })[] =>
  files.flatMap((f) => {
    const m = /^(.*)-ux(?:-(\d+))?\.md$/.exec(f.name)
    return m !== null && m[1] === slug ? [{ ...f, n: m[2] === undefined ? 1 : Number(m[2]) }] : []
  })
// ADR-0022: the crew's UX: REWORK reports that count toward its spend. They follow the since rule of qcFails, and a logged
// re-plan from qc-<k> counts only those modified at or after <slug>-qc-<k>.md (the bare <slug>-qc.md for k 1), as countedQc does.
export function uxReworks(dir: string, slug: string, files: readonly QcFile[], since = 0): number {
  const p = `${dir}/decisions.md`
  const k = existsSync(p) ? replannedFrom(readFileSync(p, 'utf8'), slug) : undefined
  let from = since
  if (k !== undefined) {
    const qc = files.find((f) => f.name === (k <= 1 ? `${slug}-qc.md` : `${slug}-qc-${k}.md`))
    // a re-plan whose QC file is gone resets the count: no ux report counts
    if (qc === undefined) return 0
    from = Math.max(from, qc.mtimeMs)
  }
  return uxReports(slug, files).filter((f) => f.mtimeMs >= from && firstLine(f.text).startsWith('UX: REWORK')).length
}
// The crew's repair spend: its QC FAIL reports plus its UX: REWORK reports (client ruling: stress-test rounds add nothing).
export function spentOf(dir: string, slug: string, since = 0): number {
  const files = reportsOf(dir, slug)
  return qcFails(slug, countedQc(dir, slug, files), since) + uxReworks(dir, slug, files, since)
}
// ADR-0022: the crew's newest direction, {label, text} of its highest-numbered ux report whose first non-empty line is
// UX: DIRECTION, or null when it has none.
export function directionOf(dir: string, slug: string): { label: string; text: string } | null {
  const dirs = uxReports(slug, reportsOf(dir, slug)).filter((f) => /^UX: DIRECTION\b/.test(firstLine(f.text)))
  if (dirs.length === 0) return null
  const top = dirs.reduce((a, b) => (b.n > a.n ? b : a))
  // the reply as stage.js keeps it (replyOf): no BOM, no harness banner, no CR, trimmed
  return { label: top.name.replace(/\.md$/, ''), text: unbannered(top.text.replace(/^﻿/, '').replace(/\r/g, '')).trim() }
}
// {role: next free label number} from the crew's report files: `<slug>-qc.md` and `-qc-2.md` give {"qc": 3}.
export function labelFromOf(dir: string, slug: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of reportsOf(dir, slug)) {
    if (/\.run\d+\.md$/.test(f.name)) continue
    const p =parseLabel(f.name.replace(/\.md$/, ''))
    if (p !== undefined && p.slug === slug) out[p.role] = Math.max(out[p.role] ?? 1, p.n + 1)
  }
  return out
}
// The crew's newest `by: "factory"` spawn line in D/events.jsonl, or undefined when it has none.
export function factorySpawned(dir: string, slug: string): Obj | undefined {
  const p = `${dir}/events.jsonl`
  if (!existsSync(p)) return undefined
  const lines = jsonLines(p).filter((e) => e.event === 'spawn' && e.crew === slug && e.by === 'factory')
  return lines[lines.length - 1]
}

// The roles table copied for args, with `--type role=agentType` laid on the roles marked typeFromProject: true; resolver follows the role its typeFromProject names.
// The roles table's model and effort for a role; every spawn event carries both, never null (a stage.js agent() call always sets them).
export function roleDefaults(roles: Obj, role: string): { model: string; effort: string } {
  const r = isObj(roles[role]) ? roles[role] : {}
  return { model: typeof r.model === 'string' ? r.model : 'sonnet', effort: typeof r.effort === 'string' ? r.effort : 'medium' }
}
function rolesWithTypes(plugin: string, types: string[], cfgRoles?: unknown): Obj {
  const roles = readRoles(plugin)
  // ADR-0021 Decision 3: truss.json `roles.build` sets builder (and resolver, which follows it), `roles.test` sets tester; --type wins below.
  if (isObj(cfgRoles)) {
    for (const [key, role] of [['build', 'builder'], ['test', 'tester']] as const) {
      const v = cfgRoles[key]
      if (typeof v === 'string' && v !== '' && isObj(roles[role]) && roles[role].typeFromProject === true) roles[role].agentType = v
    }
    // ADR-0022 U2: `roles.ux` lays on the ux row directly; the ux role has no typeFromProject, so --type ux=... stays refused below.
    if (typeof cfgRoles.ux === 'string' && cfgRoles.ux !== '' && isObj(roles.ux)) roles.ux.agentType = cfgRoles.ux
  }
  for (const t of types) {
    const eq = t.indexOf('=')
    if (eq <= 0 || eq === t.length - 1) throw usage(`--type needs role=agentType, got ${t}`)
    const role = t.slice(0, eq)
    if (!isObj(roles[role])) throw usage(`--type: unknown role ${role}`)
    if (roles[role].typeFromProject !== true) throw usage(`--type: role ${role} does not take a project agent type`)
    roles[role].agentType = t.slice(eq + 1)
  }
  for (const r of Object.values(roles)) if (isObj(r) && typeof r.typeFromProject === 'string' && isObj(roles[r.typeFromProject])) r.agentType = roles[r.typeFromProject].agentType
  return roles
}
// ADR-0026 item 50: start --model <role>=<opus|sonnet>, repeatable, sets roles.<role>.model in `roles` and returns the map,
// which crewEntry lays on members.<role>.model where ## Members gives that role. It is the one way to change a model.
const MODEL_USAGE = 'start --model needs <role>=<opus|sonnet> for a role of the roles table; it sets roles.<role>.model and the ## Members entry, so never edit the args file'
function modelsOf(f: Flags, roles: Obj): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of listOf(f, 'model')) {
    const eq = t.indexOf('=')
    const role = eq > 0 ? t.slice(0, eq) : ''
    const model = eq > 0 ? t.slice(eq + 1).toLowerCase() : ''
    if (role === '' || !isObj(roles[role])) throw usage(`${MODEL_USAGE}; got ${t}${role === '' ? '' : ` (unknown role ${role})`}`)
    if (model !== 'opus' && model !== 'sonnet') throw usage(`${MODEL_USAGE}; got ${t}`)
    if (out[role] !== undefined && out[role] !== model) throw usage(`${MODEL_USAGE}; --model gives ${role} both ${out[role]} and ${model}`)
    out[role] = model
    roles[role].model = model
  }
  return out
}
// Copies <plugin>/workflows/<script> byte for byte to <scriptsDir>/truss-<script> and returns that path; without scriptsDir returns the plugin path.
function scriptPathFor(plugin: string, script: string, scriptsDir: string | undefined): string {
  const src = `${plugin}/workflows/${script}`
  if (scriptsDir === undefined) return src
  if (!existsSync(src)) throw usage(`${src} does not exist`)
  mkdirSync(scriptsDir, { recursive: true })
  const to = `${flat(scriptsDir)}/truss-${script}`
  copyFileSync(src, to)
  return to
}
// The architecture doc as an absolute path (the key `architecture` of truss.json, repo-relative, default docs/architecture.md).
const archPath = (repo: string, rel: unknown): string => path.isAbsolute(String(rel)) ? flat(String(rel)) : `${repo}/${typeof rel === 'string' && rel !== '' ? rel : 'docs/architecture.md'}`

function cmdSettings(f: Flags): Obj {
  return settingsOf(repoOf(f))
}

function cmdPlanArgs(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const brief = readText(need(f, 'brief-file'))
  const fix = str(f, 'fix')
  if (fix !== undefined) readText(fix)
  excludeScratch(repo)
  const cfg = configOf(repo)
  // review 10: the product-owner plan review reads the feature map, so the key (default docs/features.md) goes along when that file exists
  const featureMap = docKeysOf(repo).featureMap ?? 'docs/features.md'
  return {
    truss: {
      kind: 'plan', dir, repo, plugin: PLUGIN, schema: `${PLUGIN}/docs/plan.schema.json`, architecture: archPath(repo, cfg.architecture),
      maxParallelCrews: intOr(cfg.maxParallelCrews, 4, 1), reworkAllowance: intOr(cfg.reworkAllowance, 2, 0), roles: rolesWithTypes(PLUGIN, [], cfg.roles),
      scriptPath: scriptPathFor(PLUGIN, 'plan.js', str(f, 'scripts-dir')), personas: buildPersonas(repo).personas, workTypes: profilesOf(cfg).profiles,
      ...(existsSync(`${repo}/${featureMap}`) ? { featureMap } : {}),
      ...knowledgeArgsOf(repo, false),
    },
    brief,
  }
}

// The result text of the agent labelled `label` in a run: the last `result` journal line; a schema result is its `report` field.
function cmdPlanWrite(f: Flags): Obj {
  const dir = dirOf(f)
  const run_ = runOf(need(f, 'transcript'))
  const label = need(f, 'label')
  const ids = new Set(run_.journal.filter((l) => l.type === 'started' && l.label === label).map((l) => l.agentId))
  const results = run_.journal.filter((l) => l.type === 'result' && ids.has(l.agentId))
  if (results.length === 0) throw usage(`no result for an agent labelled ${label} in ${run_.dir}`)
  const raw = results[results.length - 1].result
  const message = typeof raw === 'string' ? raw : isObj(raw) && typeof raw.report === 'string' ? raw.report : JSON.stringify(raw)
  const no = (reason: string): never => { throw refuse({ written: false, reason }) }
  // The structured result fields `planJson` (a JSON string or the plan object) and `planMd` win when they hold a plan / text;
  // the report's fenced blocks are the fallback (a designer's report may hold placeholder blocks while the fields hold the plan).
  let fieldJson: string | undefined
  if (isObj(raw) && raw.planJson !== undefined) {
    const s = typeof raw.planJson === 'string' ? raw.planJson : isObj(raw.planJson) ? JSON.stringify(raw.planJson) : undefined
    if (s !== undefined && parsePlan(s) !== undefined) fieldJson = s
  }
  const fieldMd = isObj(raw) && typeof raw.planMd === 'string' && raw.planMd.trim() !== '' ? raw.planMd : undefined
  const json = fieldJson ?? fencedBlock(message, '````json plan.json')
  const md = fieldMd ?? fencedBlock(message, '````markdown plan.md')
  if (json === undefined || md === undefined) no(json === undefined ? 'no plan.json block' : 'no plan.md block')
  if (parsePlan(json as string) === undefined) no('the plan.json block is not a plan')
  const carried = JSON.parse((json as string).startsWith('﻿') ? (json as string).slice(1) : (json as string))
  if (!isObj(carried)) no('the plan.json block is not an object')
  const keepExisting = (): void => {
    if (!existsSync(`${dir}/plan.json`)) return
    let existing
    try {
      existing = parsePlan(readFileSync(`${dir}/plan.json`, 'utf8'))
    } catch {
      return no('kept the existing plan: it could not be read')
    }
    if (existing === undefined) no('kept the existing plan: it is not a readable plan')
    else if (existing.approvedAt !== null) no('kept the existing plan: it is approved')
  }
  keepExisting()
  // contract-025 section 3 (A2): the designer's and checkers' LONG-TERM-COST lines go to the guard; rev is sha12 of the designer's result.
  // Run before the plan is written, so a guard that throws leaves no plan for approve to pass unguarded (fail closed).
  const texts = run_.journal
    .filter((l) => l.type === 'started' && typeof l.label === 'string' && /^truss-(designer|checker)/.test(l.label))
    .flatMap((l) => {
      const r = run_.journal.filter((x) => x.type === 'result' && x.agentId === l.agentId).pop()?.result
      return r === undefined ? [] : [typeof r === 'string' ? r : isObj(r) && typeof r.report === 'string' ? r.report : JSON.stringify(r)]
    })
  const longTermCosts = ltcPlan(repoOf(f), dir, texts, createHash('sha256').update(message).digest('hex').slice(0, 12)).ids
  // under the plan lock, re-checking the existing plan: an owns-extend or approve that landed since the first check is not overwritten
  withLock(dir, 'plan', () => {
    keepExisting()
    savePlan(dir, { ...carried, approvedAt: null })
  })
  writeFileSync(`${dir}/plan.md`, md as string)
  const left = retirePlanRun(f, dir, run_.id)
  const drafts = writePersonaDrafts(dir, message)
  return { written: true, longTermCosts, ...(left.length > 0 ? { leftWorktrees: left } : {}), ...(drafts.personas.length > 0 ? { personas: drafts.personas } : {}), ...(drafts.problems.length > 0 ? { personaProblems: drafts.problems } : {}) }
}

// The `PERSONA: <name>` lines of a design engineer's report, each followed by its whole file in one fenced block. A block that is
// malformed (the name is not kebab-case, no fence follows, the fence never closes, the file would not install) is a problem, not a draft.
export function personaDrafts(report: string): { drafts: { name: string; text: string }[]; problems: string[] } {
  const lines = report.replace(/\r\n?/g, '\n').split('\n')
  const drafts: { name: string; text: string }[] = []
  const problems: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^PERSONA:\s*`?([^`\s]*)`?\s*$/.exec(lines[i] as string)
    if (m === null) continue
    const name = m[1] as string
    let j = i + 1
    while (j < lines.length && (lines[j] as string).trim() === '') j++
    const open = /^(`{3,}|~{3,})/.exec(lines[j] ?? '')
    if (open === null) {
      problems.push(`PERSONA: ${name || '(no name)'} has no fenced block after it; not written`)
      continue
    }
    const fence = open[1] as string
    let k = j + 1
    while (k < lines.length && !((lines[k] as string).trim().startsWith(fence[0] as string) && /^(`+|~+)$/.test((lines[k] as string).trim()) && (lines[k] as string).trim().length >= fence.length)) k++
    if (k >= lines.length) {
      problems.push(`PERSONA: ${name || '(no name)'} has a fenced block that never closes; not written`)
      continue
    }
    i = k
    const text = lines.slice(j + 1, k).join('\n') + '\n'
    const fault = !PERSONA_KEBAB.test(name) ? 'the persona name must be kebab-case (lowercase letters, digits, hyphens)' : personaFault(name, parsePersonaFile(text))
    if (fault !== undefined) problems.push(`PERSONA: ${name || '(no name)'} is malformed: ${fault}; not written`)
    else drafts.push({ name, text })
  }
  return { drafts, problems }
}
// Writes each draft of the report to <dir>/personas/<name>.md (a later draft of the same name wins); lists them with their paths.
function writePersonaDrafts(dir: string, report: string): { personas: { name: string; path: string }[]; problems: string[] } {
  const { drafts, problems } = personaDrafts(report)
  const personas: { name: string; path: string }[] = []
  if (drafts.length > 0) mkdirSync(`${dir}/personas`, { recursive: true })
  for (const d of drafts) {
    const p = `${dir}/personas/${d.name}.md`
    writeFileSync(p, d.text)
    if (!personas.some((x) => x.name === d.name)) personas.push({ name: d.name, path: p })
  }
  return { personas, problems }
}

// The plan run's worktrees (worktree-<run>-<n>) are done once its plan is written: each is retired, its tip archived when the target
// lacks it. Best effort: a failure leaves the worktree for the report, never fails plan-write.
function retirePlanRun(f: Flags, dir: string, runId: string): { path: string; branch: string; why: string }[] {
  const left: { path: string; branch: string; why: string }[] = []
  try {
    const repo = repoOf(f)
    const wts = worktreesOf(repo)
    const x: RetireCtx = { dir, repo, target: settingsOf(repo).target, mainTop: wts[0]?.path ?? repo }
    const idRe = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const branchRe = new RegExp(`^worktree-${idRe}-\\d+$`)
    const o = { crew: 'plan', run: runId, why: 'merged' as RetireWhy }
    for (const w of wts) {
      if (w.branch === undefined || !branchRe.test(w.branch) || path.basename(w.path) !== w.branch.slice('worktree-'.length)) continue
      const kept = retireWorktree(x, w, o)
      if (kept !== undefined) left.push({ path: w.path, branch: w.branch, why: kept })
    }
    const heads = run(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
    const out = new Set(worktreesOf(repo).map((w) => w.branch))
    for (const b of heads.status === 0 ? heads.out.split('\n') : []) if (branchRe.test(b) && !out.has(b)) retireBranch(x, b, { ...o, worktree: null })
  } catch {
    // no repo or settings: nothing retired
  }
  return left
}

const WORK_TYPES = ['feature', 'bugfix', 'migration', 'dependency', 'docs', 'refactor']
const SLUG = /^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$/

function cmdPlanCheck(f: Flags): Obj {
  const plan = loadPlan(dirOf(f))
  const errors: string[] = []
  const crews: Obj[] = plan.crews.filter(isObj)
  const name = (c: Obj): string => (typeof c.slug === 'string' ? c.slug : '?')
  // contract-025 section 2: a crew's workType is version 4 only and checked against the profiles of the repo's config (the built-ins with no repo)
  const unattended = existsSync(`${dirOf(f)}/unattended.json`)
  let repoCfg: Obj = {}
  let repoDir: string | undefined
  try {
    repoDir = repoOf(f)
  } catch {
    // no --repo and the cwd is not in a git repository: the built-in profiles
  }
  // a malformed .claude/truss.json is a usage error here, never a silent fall back to the built-ins
  if (repoDir !== undefined) repoCfg = configOf(repoDir)
  const profiles = profilesOf(repoCfg)
  const addOnce = (e: string): void => {
    if (!errors.includes(e)) errors.push(e)
  }
  if (plan.version !== 2 && plan.version !== 3 && plan.version !== 4) errors.push('plan: version must be 2, 3 or 4')
  const goalIds: string[] = []
  if (plan.version === 2 || plan.version === 3 || plan.version === 4) {
    // plan.schema.json: top-level goals and a crew's goal are version 3 only.
    if (plan.goals !== undefined) {
      if (plan.version === 2) errors.push('plan: goals is version 3 only')
      else if (!Array.isArray(plan.goals) || plan.goals.length === 0) errors.push('plan: goals must be a non-empty array')
      else {
        plan.goals.forEach((g: unknown, i: number) => {
          if (!isObj(g)) { errors.push(`plan: goals[${i}] must be an object`); return }
          const id = typeof g.id === 'string' ? g.id : '?'
          if (typeof g.id !== 'string' || !SLUG.test(g.id) || g.id.length > 100) errors.push(`plan: goals[${i}] id does not match the slug pattern`)
          else if (g.id === RUN_GOAL) errors.push(`plan: goals[${i}] id ${RUN_GOAL} is reserved for the run's first goal`)
          else if (goalIds.includes(g.id)) errors.push(`plan: goals[${i}] id ${id} is not unique`)
          else goalIds.push(g.id)
          if (typeof g.goal !== 'string' || g.goal === '') errors.push(`plan: goals[${i}] (${id}) goal must be a non-empty string`)
          if (typeof g.addedAt !== 'string') errors.push(`plan: goals[${i}] (${id}) addedAt must be a date-time string`)
          if (g.approval !== 'auto' && g.approval !== 'client') errors.push(`plan: goals[${i}] (${id}) approval must be auto or client`)
          if (g.approvedAt !== null && typeof g.approvedAt !== 'string') errors.push(`plan: goals[${i}] (${id}) approvedAt must be a date-time string or null`)
          else if (g.approval === 'auto' && g.approvedAt === null) errors.push(`plan: goals[${i}] (${id}) approvedAt must be a string on an auto goal`)
          if (Object.hasOwn(g, 'goalCheck') && (typeof g.goalCheck !== 'string' || g.goalCheck.trim() === '')) errors.push(`plan: goals[${i}] (${id}) goalCheck must be a non-empty string`)
        })
      }
    }
  }
  // ADR-0044: approval no longer follows stage 0; it is client when a client trigger, a long-term cost or the brief says so
  if (plan.approval !== 'auto' && plan.approval !== 'client') errors.push('plan: approval must be auto or client')
  // ADR-0044: the goal-wide check the program manager runs after the goal's last merge; optional at every version
  if (Object.hasOwn(plan, 'goalCheck') && (typeof plan.goalCheck !== 'string' || plan.goalCheck.trim() === '')) errors.push('plan: goalCheck must be a non-empty string')
  for (const c of crews) {
    const s = name(c)
    if (typeof c.slug !== 'string' || !SLUG.test(c.slug)) errors.push(`${s}: slug does not match the slug pattern`)
    else if (c.slug === 'truss') errors.push(`${s}: truss is a reserved slug`)
    if (c.goal !== undefined) {
      if (plan.version === 2) errors.push(`${s}: goal is version 3 only`)
      else if (plan.version >= 3 && (typeof c.goal !== 'string' || (c.goal !== RUN_GOAL && !goalIds.includes(c.goal)))) errors.push(`${s}: goal ${JSON.stringify(c.goal)} is neither ${RUN_GOAL} nor a goal in the plan's goals`)
    }
    // ADR-0031 item 7: process, qc and red are version 4 only; qc and red belong to a lean crew; estAgents limits per size
    const hasProc = Object.hasOwn(c, 'process')
    const hasQc = Object.hasOwn(c, 'qc')
    const hasRed = Object.hasOwn(c, 'red')
    if (plan.version === 4) {
      if (hasProc && c.process !== 'solo' && c.process !== 'lean' && c.process !== 'full') errors.push(`${s}: process must be solo, lean or full`)
      const lean = c.process === 'lean'
      for (const [k, has] of [['qc', hasQc], ['red', hasRed]] as const) {
        if (lean) {
          if (typeof c[k] !== 'boolean') errors.push(`${s}: ${k} must be a boolean on a lean crew`)
        } else if (has) errors.push(`${s}: ${k} is lean only`)
      }
      const est = c.estAgents
      if (typeof est === 'number') {
        if (c.process === 'solo' && est > 1) errors.push(`${s}: estAgents ${est} is above 1 for a solo crew`)
        if (lean && est > 3) errors.push(`${s}: estAgents ${est} is above 3 for a lean crew`)
        else if (lean && est > 2 && c.qc !== true) errors.push(`${s}: estAgents ${est} is above 2 for a lean crew without qc`)
      }
    } else {
      if (hasProc) errors.push(`${s}: process is version 4 only`)
      if (hasQc) errors.push(`${s}: qc is version 4 only`)
      if (hasRed) errors.push(`${s}: red is version 4 only`)
    }
    if (Object.hasOwn(c, 'workType') && plan.version !== 4) errors.push(`${s}: workType is version 4 only`)
    // contract-025: when D/unattended.json exists every crew needs a workType, whatever the plan version
    if (plan.version !== 4 && unattended && !Object.hasOwn(c, 'workType')) errors.push(`${s}: workType is required in an unattended run; unattended runs need a version 4 plan with workType`)
    if (plan.version === 4) {
      if (Object.hasOwn(c, 'workType') && !WORK_TYPES.includes(c.workType)) errors.push(`${s}: workType must be one of ${WORK_TYPES.slice(0, -1).join(', ')} or ${WORK_TYPES[WORK_TYPES.length - 1]}`)
      else if (!Object.hasOwn(c, 'workType') && unattended) errors.push(`${s}: workType is required in an unattended run`)
      for (const e of workTypeErrors(plan, c, profiles.profiles, { unattended })) addOnce(e)
    }
    if (Object.hasOwn(c, 'ux') && typeof c.ux !== 'boolean') errors.push(`${s}: ux must be a boolean`)
    // a ## UX section that contradicts plan.json ux (ux false but the section asks for UX; ux true but the section says none)
    if (typeof c.ux === 'boolean' && typeof c.slug === 'string' && SLUG.test(c.slug)) {
      const gf = `${dirOf(f)}/goals/${c.slug}.md`
      const uxSection = existsSync(gf) ? goalSections(readFileSync(gf, 'utf8')).UX : undefined
      if (uxSection !== undefined && uxSection !== '') {
        if (c.ux === false && !uxSaysOff(uxSection)) errors.push(`${s}: plan.json ux is false but the goal file's ## UX section asks for UX; make the section say "none" or set ux true`)
        if (c.ux === true && uxSaysOff(uxSection)) errors.push(`${s}: plan.json ux is true but the goal file's ## UX section says UX is off; change one of them`)
      }
    }
    if (plan.approvedAt === null && c.status !== 'planned') errors.push(`${s}: status must be planned on an unapproved plan, not ${JSON.stringify(c.status)}`)
  }
  // ADR-0043: crews may share files. Two crews' owns may overlap, in one stage or across goals, and no crew of a stage has to own a
  // rule file: each crew builds in its own worktree and they merge one at a time on the program manager's go-ahead.
  for (const e of profiles.errors) addOnce(e)
  if (errors.length > 0) throw refuse({ ok: false, errors })
  const warnings = stageWarnings(dirOf(f), crews)
  return { ok: true, unproved: crews.filter((c) => c.acceptanceTestProved === false).map(name), ...(warnings.length > 0 ? { warnings } : {}) }
}

// ADR-0044 (split by need): a stage after a goal's first needs a `Why stage <n>: <crew> needs <crew>'s merged <what>` line in the goal's
// plan.md (plan-<id>.md for an added goal); bold (`**Why stage <n>:**`) and a table cell (`| Why stage <n>:`) count. A missing line warns only.
function stageWarnings(dir: string, crews: Obj[]): string[] {
  const out: string[] = []
  const goals = [...new Set(crews.map(goalOf))]
  for (const g of goals) {
    const mine = crews.filter((c) => goalOf(c) === g && Number.isInteger(c.stage))
    const stages = [...new Set(mine.map((c) => c.stage as number))].sort((a, b) => a - b)
    if (stages.length < 2) continue
    const file = g === RUN_GOAL ? 'plan.md' : `plan-${g}.md`
    let md = ''
    try {
      md = readFileSync(`${dir}/${file}`, 'utf8')
    } catch {
      // no plan.md: every later stage lacks its Why line
    }
    for (let k = 1; k < stages.length; k++) {
      const n = stages[k]
      if (new RegExp(`(?:^\\s*(?:[-*]\\s+)?|\\|\\s*)(?:\\*\\*)?Why stage ${n}(?::|\\*\\*:)`, 'm').test(md)) continue
      const tag = g === RUN_GOAL ? '' : ` of goal ${g}`
      out.push(`stage ${n}${tag}: no "Why stage ${n}:" line in ${file}; say which crew needs which earlier crew's merged work, or merge it into stage ${stages[k - 1]}`)
    }
  }
  return out
}

function cmdApprove(f: Flags): Obj {
  const dir = dirOf(f)
  const by = need(f, 'by')
  if (by !== 'client' && by !== 'auto') throw usage('--by must be client or auto')
  const repo = repoOf(f)
  const plan = loadPlan(dir)
  const clientGoals = (Array.isArray(plan.goals) ? plan.goals : []).filter((g: unknown) => isObj(g) && g.approval === 'client').map((g: Obj) => String(g.id))
  if (plan.approvedAt !== null && plan.approvedAt !== undefined) {
    // ADR-0045: the client's typed approve of the run item already approved the plan; the first --by client call with that proof confirms it
    if (by === 'client' && confirmApproval(repo, dir, str(f, 'item'))) return { approvedAt: plan.approvedAt }
    throw refuse({ error: `the plan is already approved (${String(plan.approvedAt)})` })
  }
  // contract-025 section 3 (finding #17): auto never approves a goal that needs the client. ADR-0044: a stage-0 crew alone no longer
  // needs the client; a plan whose own approval is client does.
  if (by === 'auto') {
    if (plan.approval === 'client') throw refuse({ error: "approve --by auto: the plan's approval is client, so it needs the client's approval", goals: [RUN_GOAL] })
    if (clientGoals.length > 0) throw refuse({ error: `approve --by auto: ${clientGoals.length === 1 ? 'goal' : 'goals'} ${clientGoals.join(', ')} ${clientGoals.length === 1 ? 'needs' : 'need'} the client's approval`, goals: clientGoals })
  }
  // ADR-0045: approve --by client is the client's act; it passes only with the typed proof /truss:inbox resolve requires (ADR-0037).
  if (by === 'client') {
    const why = approvalProof(repo, dir, str(f, 'item'))
    if (why !== null) throw refuse({ error: `approve --by client: ${why}` })
  }
  const ltc = ltcPlanGate(repo, dir)
  if (ltc.length > 0) throw refuse({ error: 'long-term cost awaiting the client', ids: ltc })
  const s = settingsOf(repo)
  const approvedAt = new Date().toISOString()
  patchPlan(dir, (p) => { p.approvedAt = approvedAt })
  appendDecision(dir, `plan approved (${by}): merge ${s.merge}, target ${s.target} from ${s.source}; approvedAt ${approvedAt}; scope frozen | the plan is approved by ${by}, so crews may start`)
  return { approvedAt }
}
onPlanApprove((repo, dir, item) => {
  const at = loadPlan(dir).approvedAt // an approved plan is not confirmed here: only an explicit approve call confirms (confirmApproval)
  if (at !== null && at !== undefined) throw refuse({ error: `the plan is already approved (${String(at)})` })
  return cmdApprove({ repo, dir, by: 'client', item })
})

// Environment failures (ADR-0009 "check, environment failures"): output lines that say the host, not the code, failed, so no
// fix builder can clear them. Kept short and literal on purpose: a miss only costs the fix ladder, a false hit stops a crew.
export const ENV_PATTERNS: RegExp[] = [
  /Host system is missing dependencies/, // Playwright: the browser's system libraries are not installed
  /browserType\.launch: /, // Playwright: the browser process could not start
  /Executable doesn't exist at /, // Playwright: the browser binary was never downloaded
  /error while loading shared libraries: /, // the dynamic loader: a system library is missing
]
// The first line of a failed check's output that names an environment failure, cut at 300 characters, or undefined. Besides
// ENV_PATTERNS, node's `Cannot find package 'x' imported from <file>` (ERR_MODULE_NOT_FOUND) counts when the package.json
// nearest to <file> declares x: the dependency is declared but not installed. An undeclared package is a code failure.
export function envFailure(text: string): string | undefined {
  // A match counts only when no quote or backtick comes before it on the line: quoted text is output echoed by a test, not the
  // host failing. A leading YAML `error:` key and its one opening quote don't count (TAP's `error: "<msg>"`).
  const bare = (s: string, at: number): boolean => !/["'`]/.test(s.slice(0, at))
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const s = line.replace(/^error:\s*["']?/, '')
    let hit = ENV_PATTERNS.some((re) => {
      const x = re.exec(s)
      return x !== null && bare(s, x.index)
    })
    const m = /Cannot find package '([^']+)' imported from (\S+)/.exec(s)
    if (!hit && m && bare(s, m.index) && !m[1].startsWith('.') && !m[1].startsWith('/')) hit = declares(m[2].replace(/^file:\/\//, ''), packageName(m[1]))
    if (hit) return line.length > 300 ? `${line.slice(0, 299)}…` : line
  }
  return undefined
}
// ADR-0024 item 34: the failure blocks of a check's output, each from its header to the next header: Playwright's
// `N) [project] › file:line:col › ...` (the `[project] › ` part left out when the project has no name) and node:test TAP's
// `not ok N - ...` (a TAP parent that only reports failed subtests is no block of its own). Text before the first header
// belongs to no block. [] when no header is found. ADR-0025 item 43: a TAP block ends at its YAML diagnostic's closing `...`
// line, or at a plan or summary line (`1..N`, `# tests`); lines after that, up to the next header, belong to no block.
// Playwright blocks run to the next header. ADR-0026 item 58 (b): the closing `...` counts only at the indent of the block's
// own `---` line, and a plan or summary line ends a block only outside its YAML diagnostic, so an `error: |-` block scalar
// holding an indented `...` or `1..N` line stays one block.
function failureBlocks(text: string): string[] {
  const header = /^\s*(\d+\) (\[[^\]]+\] › )?[^\s›][^›]*:\d+:\d+ › |not ok \d+ - )/
  const tapHeader = /^\s*not ok \d+ - /
  const blocks: string[][] = []
  let open = false
  let tap = false
  // the indent of the open TAP block's `---` line while inside its YAML diagnostic, else undefined
  let yaml: string | undefined
  for (const line of text.split('\n')) {
    if (header.test(line)) {
      blocks.push([line])
      open = true
      tap = tapHeader.test(line)
      yaml = undefined
    } else if (open && tap && yaml === undefined && /^\s*(\d+\.\.\d+|# tests \d+)\b/.test(line)) open = false
    else if (open) {
      blocks[blocks.length - 1]?.push(line)
      if (!tap) continue
      if (yaml === undefined) {
        const start = /^(\s*)---\s*$/.exec(line)
        if (start !== null) yaml = start[1] as string
        else if (/^\s*\.\.\.\s*$/.test(line)) open = false
      } else if (line.startsWith(`${yaml}...`) && line.slice(yaml.length + 3).trim() === '') {
        yaml = undefined
        open = false
      }
    }
  }
  return blocks.map((b) => b.join('\n')).filter((b) => !/failureType: '?subtestsFailed'?/.test(b))
}
// `env` only when env lines explain every failure: every failure block holds one, or no block is found and an env line is.
// Otherwise the first env line, if any, is `envSeen` and the run is a code failure.
export function envVerdict(text: string): { env?: string; envSeen?: string } {
  const first = envFailure(text)
  if (first === undefined) return {}
  const blocks = failureBlocks(text)
  const explained = blocks.length === 0 || blocks.every((b) => envFailure(b) !== undefined)
  return explained ? { env: first } : { envSeen: first }
}

function cmdCheck(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const cwd = flat(need(f, 'cwd'))
  const expect = need(f, 'expect')
  if (expect !== 'red' && expect !== 'green') throw usage('--expect must be red or green')
  const crew = loadPlan(dir).crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  if (typeof crew.acceptanceTest !== 'string' || crew.acceptanceTest === '') throw usage(`crew ${slug} has no acceptanceTest`)
  const scratch = mkdtempSync(`${tmpdir()}/factory-check-`)
  let text: string
  let exit: number
  try {
    const fd = openSync(`${scratch}/out.txt`, 'w')
    const r = spawnSync('bash', ['-c', crew.acceptanceTest], { cwd, stdio: ['ignore', fd, fd] })
    closeSync(fd)
    if (r.error) throw usage(`cannot run bash in ${cwd}: ${r.error.message}`)
    exit = r.status ?? 1
    text = readFileSync(`${scratch}/out.txt`, 'utf8')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const tail = lines.slice(-40).join('\n')
  const head = gitOrFail(cwd, ['rev-parse', 'HEAD'])
  mkdirSync(`${dir}/checks`, { recursive: true })
  const used = readdirSync(`${dir}/checks`).map((n) => new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`).exec(n)?.[1]).filter((n) => n !== undefined).map(Number)
  const n = (used.length === 0 ? 0 : Math.max(...used)) + 1
  // a failing run whose env lines explain every failure carries `env`: never a red, and no fix builder for a green. One whose
  // env lines leave a code failure unexplained carries `envSeen` instead and counts as red (ADR-0024 item 34).
  const { env, envSeen } = exit === 0 ? {} : envVerdict(text)
  const envKeys = { ...(env === undefined ? {} : { env }), ...(envSeen === undefined ? {} : { envSeen }) }
  const known = exit === 0 ? [] : catalogHits(text)
  writeFileSync(`${dir}/checks/${slug}-${n}.json`, JSON.stringify({ command: crew.acceptanceTest, exit, head, tail, ...envKeys, ...(known.length === 0 ? {} : { catalog: known }) }) + '\n', { flag: 'wx' })
  const ok = expect === 'red' ? exit !== 0 && env === undefined : exit === 0
  const body = { ok, exit, head, tail, ...envKeys, ...(known.length === 0 ? {} : { catalog: known }), ...(ok && expect === 'green' ? { sourceChanges: sourceChangesOf(cwd, f) } : {}) }
  if (!ok) throw refuse(body)
  return body
}

// ADR-0033: the non-test source files the crew's diff (merge-base with the target ... HEAD) adds, renames or deletes, from
// `git diff --name-status -M`, so the knowledge step runs for new or moved functionality even when no member reported a learned
// item. A source file has a code extension and is not a test, a fixture, a doc (docs/, doc/) or under .claude/. A plain edit is no
// change. Best effort: when the target or the diff can't be read the list is empty. At most 100 entries.
function sourceChangesOf(cwd: string, f: Flags): Obj[] {
  const code = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|rb|php|cs|c|cc|cpp|h|hpp|swift|scala|vue|svelte|sh|sql)$/
  const source = (p: string): boolean => code.test(p) && !isTestPath(p) && !/^(docs?|\.claude)\//.test(p)
  let out: string
  try {
    out = gitOrFail(cwd, ['-c', 'core.quotepath=off', 'diff', '--name-status', '-M', `${baseOf(cwd, settingsOf(repoOf(f)).target)}...HEAD`])
  } catch {
    return []
  }
  const changes: Obj[] = []
  for (const line of out.split('\n')) {
    const [st, a, b] = line.split('\t')
    const status = st?.[0]
    if (a === undefined || (status !== 'A' && status !== 'D' && status !== 'R')) continue
    if (status === 'R') {
      if (b !== undefined && (source(a) || source(b))) changes.push({ status, path: b, from: a })
    } else if (source(a)) changes.push({ status, path: a })
  }
  return changes.slice(0, 100)
}

// ADR-0012 Decision 10: the catalog entries a failed check's output hits, in catalog order, each with the first line that hits it.
// An unreadable catalog gives no hits: a check never fails over it.
function catalogHits(text: string): { id: string; fix: string; line: string }[] {
  let catalog: Catalog
  try {
    catalog = retro().cat.loadCatalog(`${PLUGIN}/retro/catalog.json`)
  } catch {
    return []
  }
  const first = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.trim() === '') continue
    const shown = line.trim()
    for (const id of retro().cat.matchLine(line, catalog)) if (!first.has(id)) first.set(id, shown.length > 300 ? `${shown.slice(0, 299)}…` : shown)
  }
  return catalog.entries.filter((e) => first.has(e.id)).map((e) => ({ id: e.id, fix: e.fix, line: first.get(e.id) as string }))
}

// ADR-0012 Decision 9: probes every crew need and every catalog probe on the host; writes nothing.
function runProbe(probe: Obj, repo: string): { pass: boolean; detail: string } {
  if (probe.kind === 'file') {
    const p = String(probe.path)
    return existsSync(path.resolve(repo, p)) ? { pass: true, detail: '' } : { pass: false, detail: p }
  }
  const r = spawnSync('bash', ['-c', String(probe.run)], { cwd: repo, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  // bash exiting 0 passes even when a background child held the pipes until the timeout (spawnSync then sets ETIMEDOUT with status 0)
  if (r.status === 0) return { pass: true, detail: '' }
  const first = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').map((l) => l.trim()).find((l) => l !== '')
  const why = r.error !== undefined ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`
  const detail = first ?? why
  return { pass: false, detail: detail.length > 300 ? `${detail.slice(0, 299)}…` : detail }
}

function cmdDoctor(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const catPath = str(f, 'catalog')
  if (f.catalog !== undefined && (catPath === undefined || catPath === '')) throw usage('--catalog needs a value')
  let catalog: Catalog
  try {
    catalog = retro().cat.loadCatalog(catPath === undefined ? `${PLUGIN}/retro/catalog.json` : flat(catPath))
  } catch (e) {
    throw usage((e as Error).message)
  }
  const plan = loadPlan(dir)
  const probes: { name: string; kind: string; pass: boolean; detail: string }[] = []
  const allow: string[] = []
  const downloads: string[] = []
  const addOnce = (list: string[], v: unknown): void => {
    if (typeof v === 'string' && v !== '' && !list.includes(v)) list.push(v)
  }
  for (const c of plan.crews) {
    if (!isObj(c) || !Array.isArray(c.needs)) continue
    for (const nd of c.needs) {
      if (!isObj(nd) || !isObj(nd.probe)) continue
      const r = runProbe(nd.probe, repo)
      probes.push({ name: `${String(c.slug)}/${String(nd.id)}`, kind: String(nd.probe.kind), pass: r.pass, detail: r.detail })
      if (Array.isArray(nd.allow)) for (const a of nd.allow) addOnce(allow, a)
      if (!r.pass) addOnce(downloads, nd.download)
    }
  }
  const known: { id: string; pass: boolean }[] = []
  const rulings: { id: string; fix: string }[] = []
  for (const e of catalog.entries) {
    if (e.probe === undefined) continue
    const r = runProbe(e.probe, repo)
    known.push({ id: e.id, pass: r.pass })
    if (!r.pass) rulings.push({ id: e.id, fix: e.fix })
  }
  // a malformed .claude/truss.json is one failed probe, so the other probes still print
  let cfg: Obj = {}
  try {
    cfg = configOf(repo)
  } catch (e) {
    probes.push({ name: 'config', kind: 'config', pass: false, detail: e instanceof CliError && typeof e.body.error === 'string' ? e.body.error : (e as Error).message })
  }
  const failed = probes.filter((p) => !p.pass).map((p) => p.name)
  // contract-025 section 4: with a budget set, a model the roles use that no pricing key covers can't be priced, so every spend would hold
  const warnings: string[] = []
  if (isObj(cfg.budget)) {
    const keys = isObj(cfg.pricing) ? Object.keys(cfg.pricing) : []
    const models = new Set(Object.values(rolesWithTypes(PLUGIN, [], cfg.roles)).filter(isObj).map((r) => r.model).filter((m): m is string => typeof m === 'string'))
    // a pricing key is a model-id prefix; a role names its model by alias (opus, sonnet), so a key that holds the alias covers it
    for (const m of models) if (!keys.some((k) => m.startsWith(k) || k.includes(m))) warnings.push(`budget is set but pricing has no entry for the ${m} model (a key that is a prefix of its id); its spend can't be priced, so the budget holds`)
  }
  const body = { ok: failed.length === 0, probes, passed: probes.filter((p) => p.pass).map((p) => p.name), failed, known, bundle: { allow, downloads, rulings }, ...(warnings.length > 0 ? { warnings } : {}) }
  if (!body.ok) throw refuse(body)
  return body
}

// The existing crew worktree for --slug, and the repo and target it belongs to.
function crewCtx(f: Flags): { dir: string; repo: string; slug: string; wt: string; target: string } {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const repo = repoOf(f)
  const wt = crewWorktree(repo, slug)
  if (!existsSync(wt)) throw usage(`no crew worktree for ${slug} at ${wt}`)
  return { dir, repo, slug, wt, target: settingsOf(repo).target }
}
// Runs a merge in the worktree; on conflict leaves it in progress and refuses with the conflicting paths.
function mergeIn(wt: string, args: string[]): Obj {
  const r = run(wt, ['merge', '--no-edit', ...args])
  if (r.status !== 0) {
    const conflicts = run(wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    if (conflicts.length === 0) throw usage(`git merge ${args.join(' ')} failed: ${r.err || r.out}`)
    throw refuse({ merged: false, conflicts })
  }
  return { merged: true, head: gitOrFail(wt, ['rev-parse', 'HEAD']) }
}
function cmdSync(f: Flags): Obj {
  const c = crewCtx(f)
  return mergeIn(c.wt, [c.target])
}
// Commits in HEAD..branch whose message has a `Truss-Crew:` or `Truss-Role:` line that git's trailer parser doesn't see:
// a blank line inside the trailer block, or between it and a later one such as Co-Authored-By. QC reads the role with
// %(trailers:key=Truss-Role), so such a commit would fail as a role violation. `<sha> <subject>` each; [] when the range can't be read.
export function unparsedTrailers(wt: string, branch: string): string[] {
  const r = run(wt, ['log', '--format=%H %s%x1f%(trailers:key=Truss-Crew,valueonly)%x1f%(trailers:key=Truss-Role,valueonly)%x1f%B%x1e', `HEAD..${branch}`])
  if (r.status !== 0) return []
  const missed = (parsed: string | undefined, key: string, body: string | undefined): boolean => String(parsed).trim() === '' && new RegExp(`^${key}:`, 'm').test(String(body))
  return r.out.split('\x1e').map((rec) => rec.replace(/^\n/, '').split('\x1f')).filter((x) => x.length === 4)
    .filter(([, crew, role, body]) => missed(crew, 'Truss-Crew', body) || missed(role, 'Truss-Role', body)).map(([id]) => String(id))
}
// Non-merge commits in HEAD..branch that the target does not hold and that carry neither Truss-Crew nor Truss-Role, `<sha> <subject>`
// each; [] when the range can't be read. A commit already in the target (a main commit that reached the branch by a merge) never counts.
function untrailered(wt: string, target: string, branch: string): string[] {
  // a local branch first, else the target as git names it (origin/main): `refs/heads/origin/main` is a fatal error, which used to read as no commits
  const local = run(wt, ['rev-parse', '-q', '--verify', `refs/heads/${target}^{commit}`]).status === 0
  const not = local ? `refs/heads/${target}` : target
  const r = run(wt, ['log', '--no-merges', '--format=%H %s%x1f%(trailers:key=Truss-Crew,valueonly)%x1f%(trailers:key=Truss-Role,valueonly)%x1e', `HEAD..${branch}`, '--not', not])
  // fail closed: an unreadable range (an unknown target, a bad branch) is no proof that every commit carries a trailer
  if (r.status !== 0) throw refuse({ merged: false, conflicts: [], missingTrailers: [], why: `could not read the commits of ${branch} that ${target} does not hold, so their trailers are unchecked: ${r.err.trim().split('\n')[0] ?? ''}` })
  return r.out.split('\x1e').map((rec) => rec.replace(/^\n/, '').split('\x1f')).filter((x) => x.length === 3)
    .filter(([, crew, role]) => String(crew).trim() === '' && String(role).trim() === '').map(([id]) => String(id))
}
// The git operation left unconcluded in a worktree, if any: a rebase (`rebase-merge` or `rebase-apply` in its git dir, checked
// first since a rebase's own picks and merges can set the heads below), a merge, a cherry-pick or a revert.
function operationInProgress(wt: string): 'rebase' | 'merge' | 'cherry-pick' | 'revert' | undefined {
  for (const d of ['rebase-merge', 'rebase-apply']) {
    const p = run(wt, ['rev-parse', '--path-format=absolute', '--git-path', d])
    if (p.status === 0 && p.out.trim() !== '' && existsSync(p.out.trim())) return 'rebase'
  }
  const has = (ref: string): boolean => run(wt, ['rev-parse', '-q', '--verify', ref]).status === 0
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return undefined
}
function cmdIntegrate(f: Flags): Obj {
  const branch = need(f, 'branch')
  const c = crewCtx(f)
  // ADR-0026 item 58 (c), (d), overriding ADR-0025 item 44 ("while one is, mergeIn answers"): with a merge, cherry-pick,
  // revert or rebase unconcluded in the crew worktree, integrate refuses up front, before any git merge or merge-tree, with
  // no conflicts (the paths git lists belong to that operation, not to this branch) and `inProgress` naming it.
  const inProgress = operationInProgress(c.wt)
  if (inProgress !== undefined) {
    throw refuse({ merged: false, conflicts: [], inProgress, why: `a ${inProgress} is in progress in ${c.wt}; conclude or abort it before integrating ${branch}` })
  }
  const trailers = unparsedTrailers(c.wt, branch)
  if (trailers.length > 0) throw refuse({ merged: false, conflicts: [], trailers })
  const missingTrailers = untrailered(c.wt, c.target, branch)
  if (missingTrailers.length > 0) throw refuse({ merged: false, conflicts: [], missingTrailers })
  // ADR-0024 item 32: a branch whose merge would leave the crew head's tree unchanged (one the head already holds, even after a
  // rewrite split its commits) isn't merged. A conflict or a merge-tree failure falls back to the --no-ff merge below.
  const mt = run(c.wt, ['merge-tree', '--write-tree', 'HEAD', branch])
  const tree = mt !== undefined && mt.status === 0 ? mt.out.split('\n')[0]?.trim() : undefined
  if (tree !== undefined && tree !== '') {
    const now = run(c.wt, ['rev-parse', 'HEAD^{tree}'])
    if (now.status === 0 && now.out === tree) return { merged: true, contained: true, head: gitOrFail(c.wt, ['rev-parse', 'HEAD']) }
  }
  return mergeIn(c.wt, ['--no-ff', branch])
}
// Sets a crew merged when truss-<slug> is an ancestor of the target; refuses and changes nothing otherwise.
function cmdMarkMerged(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const repo = repoOf(f)
  const plan = loadPlan(dir)
  const crew = plan.crews.find((x: Obj) => isObj(x) && x.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  const target = settingsOf(repo).target
  const r = run(repo, ['merge-base', '--is-ancestor', `truss-${slug}`, target])
  if (r.status !== 0) throw refuse({ ok: false, slug, merged: false, why: `truss-${slug} is not an ancestor of ${target}` })
  // ADR-0035: a raw merge cannot be recorded as merged. The same two comparisons as a merge: the crew head against its fork from the target's
  // pre-merge tip, and what landed against that tip. Both from commits; the reflog only says which commit the tip was.
  const crewHead = gateGit(repo, ['rev-parse', '--verify', `refs/heads/truss-${slug}^{commit}`]).out
  const pre = preMergeOf(repo, target, crewHead)
  const fork = pre.old === undefined ? undefined : gateGit(repo, ['merge-base', pre.old, crewHead]).out
  const nextStep = `Next step: this check could not separate the crew's change from the client's. Once the client has confirmed the config change is theirs, the existing recovery is a hand edit of this crew's "status" to "merged" in plan.json.`
  const landedWhy = (old: string, landed: string): string | undefined => {
    const why = knowledgeConfigRefusal(repo, old, landed)
    return why === undefined ? undefined : `${why}. ${nextStep}`
  }
  const cfgWhy = pre.old === undefined || pre.landed === undefined
    ? `knowledge config gate: could not verify .claude/truss.json, so the merge is not recorded: ${pre.why}. ${nextStep}`
    : fork === undefined || fork === ''
      ? `knowledge config gate: truss-${slug} has no fork point with the pre-merge tip of ${target}`
      : (knowledgeConfigRefusal(repo, fork, crewHead) ?? landedWhy(pre.old, pre.landed))
  if (cfgWhy !== undefined) throw refuse({ ok: false, slug, merged: false, why: cfgWhy })
  patchPlan(dir, (p) => { const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug); if (e !== undefined) e.status = 'merged' })
  appendDecision(dir, `${slug} marked merged | truss-${slug} is an ancestor of ${target}`)
  return { ok: true, slug, status: 'merged' }
}
// Adds one glob to a crew's owns in plan.json under the plan lock, so the PM never hand-edits the plan, and logs a decision line.
// Another crew may own the same files (ADR-0043): the crews merge in turn.
function cmdOwnsExtend(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const glob = need(f, 'glob')
  const reason = need(f, 'reason').replace(/\s+/g, ' ').trim()
  const done = withLock(dir, 'plan', (): Obj => {
    const plan = loadPlan(dir)
    const crew = plan.crews.find((x: Obj) => isObj(x) && x.slug === slug)
    if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
    const owns: string[] = Array.isArray(crew.owns) ? crew.owns.filter((g: unknown) => typeof g === 'string') : []
    if (!owns.includes(glob)) owns.push(glob)
    crew.owns = owns
    savePlan(dir, plan)
    return { ok: true, slug, glob, owns }
  })
  appendDecision(dir, `${slug} owns extended by ${glob.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()} | ${reason}`)
  return done
}
function cmdOwnsCheck(f: Flags): Obj {
  const c = crewCtx(f)
  const crew = loadPlan(c.dir).crews.find((x: Obj) => isObj(x) && x.slug === c.slug)
  if (crew === undefined) throw usage(`no crew ${c.slug} in the plan`)
  const owns: string[] = Array.isArray(crew.owns) ? crew.owns.filter((g: unknown) => typeof g === 'string') : []
  const files = gitOrFail(c.wt, ['-c', 'core.quotepath=off', 'diff', '--name-only', `${baseOf(c.wt, c.target)}...HEAD`]).split('\n').filter(Boolean)
  // path.matchesGlob's `**` skips dot segments; an owned `**` covers them.
  const owned = (file: string, g: string): boolean => {
    if (path.matchesGlob(file, g)) return true
    const i = g.indexOf('**')
    if (i === -1) return false
    const head = g.slice(0, i)
    if (!head.endsWith('/') && head !== '') return false
    const tail = g.slice(i + 2)
    if (tail === '' || tail === '/') return file.startsWith(head) && file.length > head.length
    // `**/rest`: any depth under head, then rest matched on the remaining segments
    const rest = tail.replace(/^\//, '')
    const under = file.slice(head.length)
    if (!file.startsWith(head)) return false
    const segs = under.split('/')
    for (let k = 0; k < segs.length; k++) if (path.matchesGlob(segs.slice(k).join('/'), rest)) return true
    return false
  }
  const allowed = knowledgeDocs(c)
  const outside = files.filter((file) => !owns.some((g) => owned(file, g)) && !allowed.has(file))
  // the files the exemption let through: changed, outside the crew's owns, and exempt (sorted, so the report is stable)
  const exempt = files.filter((file) => !owns.some((g) => owned(file, g)) && allowed.has(file)).sort()
  if (outside.length > 0) throw refuse({ ok: false, outside, exempt })
  return { ok: true, exempt }
}

// ADR-0033: the files the crew's knowledge commit may change outside the crew's owns. The commit is the one recorded by
// `knowledge-commit` (its subject never counts: anyone can write a subject). A file is exempt only when ALL hold: it changed in a
// recorded knowledge commit and in no other non-merge commit of the crew; it is a .md file; it is the feature map (featureMap,
// default docs/features.md), a file under the ADR directory (adrDir, default docs/adr), a persona or the product-owner file
// (.claude/agents/*.md, whose YAML frontmatter is unchanged: tools and model are never the knowledge step's to edit), or the
// target of a learned item the crew recorded with `crew-learned`. A code file, or a file another commit changed, is not exempt.
function knowledgeDocs(c: { dir: string; repo: string; slug: string; wt: string; target: string }): Set<string> {
  const shas = knowledgeShas(c.dir, c.slug)
  if (shas.length === 0) return new Set()
  const base = baseOf(c.wt, c.target)
  const out = gitOrFail(c.wt, ['-c', 'core.quotepath=off', 'log', '--no-merges', '--name-only', '--format=%x00%H', `${base}..HEAD`])
  const byKnowledge = new Set<string>()
  const byOthers = new Set<string>()
  for (const chunk of out.split('\0').slice(1)) {
    const lines = chunk.split('\n')
    const files = lines.slice(1).map((l) => l.trim()).filter(Boolean)
    for (const file of files) (shas.includes((lines[0] as string).trim()) ? byKnowledge : byOthers).add(file)
  }
  const keys = docKeysOf(c.repo)
  const featureMap = keys.featureMap ?? 'docs/features.md'
  const adrDir = keys.adrDir ?? 'docs/adr'
  const targets = learnedTargets(c.dir, c.slug)
  const frontmatter = (text: string): string => {
    const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
    if (lines[0]?.trim() !== '---') return ''
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
    return (end < 0 ? lines : lines.slice(0, end + 1)).join('\n')
  }
  const isPersona = (file: string): boolean => /^\.claude\/agents\/[^/]+\.md$/.test(file)
  const frontmatterKept = (file: string): boolean => {
    const was = run(c.wt, ['show', `${base}:${file}`])
    const now = run(c.wt, ['show', `HEAD:${file}`])
    return frontmatter(was.status === 0 ? was.out : '') === frontmatter(now.status === 0 ? now.out : '')
  }
  // ADR-0035: the rules dir, the knowledge dir, the agents index and the product-decisions file join the doc set. A persona's
  // frontmatter is still never the knowledge step's to edit, whatever else names the file.
  const kc = knowledgeCfgOf(c.repo)
  const isDoc = (file: string): boolean =>
    file.toLowerCase().endsWith('.md') &&
    (file === featureMap || file.startsWith(`${adrDir}/`) || isPersona(file) || targets.has(file) || file.startsWith(`${kc.rulesDir}/`) || file.startsWith(`${kc.knowledgeDir}/`) || file === kc.agentsIndex || file === kc.productDecisions) &&
    (!isPersona(file) || frontmatterKept(file))
  return new Set([...byKnowledge].filter((file) => !byOthers.has(file) && isDoc(file)))
}

// Guarded = every file a `Truss-Role: test-writer` commit in <base>..HEAD touched, whatever its name, plus every existing path
// the acceptanceTest names that is a test file by name (isTestPath). Lists every builder or resolver commit there that touched
// one, the check of agents/qc-engineer.md step 8 done before a QC engineer is paid for it. Read oldest first with
// `--name-status -M`: a pure rename (R100) of a guarded file is no touch and the guard follows the new path; a rename with an
// edit, a later edit at the new path, and a delete are touches. A merge commit counts only for the files its resolution changed
// (`--cc`), so integrating a tester's branch is no touch. History is what QC reads, so a later commit that restores the file
// doesn't clear it.
function cmdTestsCheck(f: Flags): Obj {
  const { touched, tests } = guardedOf(crewCtx(f))
  if (touched.length > 0) throw refuse({ ok: false, touched, tests })
  return { ok: true, tests }
}
// The one guarded-set rule, used by tests-check and by the start entry's `guarded`.
function guardedOf(c: { dir: string; slug: string; wt: string; target: string }): { touched: Obj[]; tests: string[] } {
  const out = gitOrFail(c.wt, ['-c', 'core.quotepath=off', 'log', '--cc', '--name-status', '-M', '--format=%x00%H %(trailers:key=Truss-Role,valueonly,separator=%x2C)', `${baseOf(c.wt, c.target)}..HEAD`])
  // Oldest first; each entry is a status letter (R keeps its score) with the old path and, for a rename, the new one.
  const commits = out.split('\0').filter((b) => b.trim() !== '').map((b) => {
    const [first = '', ...rest] = b.split('\n')
    const [sha = '', roles = ''] = first.split(' ')
    const entries = rest.filter((l) => l.trim() !== '').map((l) => {
      const [st = '', p1 = '', p2 = ''] = l.split('\t')
      return { st, from: p1, to: st.startsWith('R') || st.startsWith('C') ? p2 : p1 }
    })
    return { sha, roles: roles.split(',').map((r) => r.trim()).filter(Boolean), entries }
  }).reverse()
  // Also guarded: every existing repo-relative path the crew's acceptanceTest names.
  const plan = loadPlan(c.dir)
  const crew = Array.isArray(plan.crews) ? plan.crews.find((x: unknown) => isObj(x) && x.slug === c.slug) : undefined
  const base = baseOf(c.wt, c.target)
  const named = typeof crew?.acceptanceTest === 'string'
    ? crew.acceptanceTest.split(/[\s"'`;&|<>()=]+/).map((t: string) => t.replace(/^\.\//, '')).filter((t: string) => t !== '' && !t.startsWith('/') && !t.startsWith('-') && !t.split('/').includes('..') && (existsSync(`${c.wt}/${t}`) ? statSync(`${c.wt}/${t}`).isFile() : run(c.wt, ['cat-file', '-e', `${base}:${t}`]).status === 0))
    : []
  const guarded = new Set<string>(named.filter(isTestPath))
  const touched: Obj[] = []
  for (const x of commits) {
    const role = x.roles.find((r) => r === 'builder' || r === 'resolver')
    const writer = x.roles.includes('test-writer')
    const files: string[] = []
    for (const e of x.entries) {
      const renamed = e.st.startsWith('R')
      if (writer) {
        if (renamed) guarded.delete(e.from)
        if (!e.st.startsWith('D')) guarded.add(e.to)
        continue
      }
      if (!guarded.has(e.from)) continue
      if (renamed && e.st === 'R100') { guarded.delete(e.from); guarded.add(e.to); continue }
      if (role !== undefined) files.push(e.to)
      if (renamed) { guarded.delete(e.from); guarded.add(e.to) }
    }
    if (role !== undefined && !writer && files.length > 0) touched.push({ commit: x.sha, role, files })
  }
  return { touched, tests: [...guarded].sort() }
}

// A test file by name: basename `.test|spec|check.[cm]?[jt]sx?`, `test_*.py`, `*_test.py|go`, `conftest.py`, or a directory segment
// tests/ test/ __tests__/ spec/ checks/ e2e/ fixtures/.
function isTestPath(p: string): boolean {
  const parts = p.split('/')
  const b = parts[parts.length - 1] ?? ''
  return /\.(test|spec|check)\.[cm]?[jt]sx?$/.test(b) || /^test_.*\.py$/.test(b) || /_test\.(py|go)$/.test(b) || b === 'conftest.py'
    || parts.slice(0, -1).some((s) => ['tests', 'test', '__tests__', 'spec', 'checks', 'e2e', 'fixtures'].includes(s))
}

// ==== start ====

// A goal file's `## Heading` sections as {heading: text}; the text before the first heading is under "".
function goalSections(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key = ''
  let buf: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      out[key] = buf.join('\n').trim()
      key = m[1]
      buf = []
    } else buf.push(line)
  }
  out[key] = buf.join('\n').trim()
  return out
}
// The engine a goal file asks for: workflow only when `## Engine` starts with the word workflow; else project manager with the reason.
function engineOf(sections: Record<string, string>, merge: string, noWorkflow: boolean): { engine: 'workflow' | 'project-manager'; reason: string } {
  if (merge === 'single') return { engine: 'project-manager', reason: 'merge mode single runs on the project manager path' }
  if (noWorkflow) return { engine: 'project-manager', reason: 'no Workflow tool in this session' }
  const text = sections.Engine
  if (text === undefined || text === '') return { engine: 'project-manager', reason: 'the goal file has no ## Engine section' }
  const m = /^(\w+)[\s:,.\-]*([\s\S]*)$/.exec(text)
  if (m?.[1].toLowerCase() === 'workflow') return { engine: 'workflow', reason: '' }
  return { engine: 'project-manager', reason: (m?.[2] ?? '').trim() || 'the goal file says project-manager' }
}

// ADR-0022 U6 (item 23): each `<n> <role> on <model> at effort <effort>` phrase in the goal file's `## Members` (a line, a bullet
// or part of a sentence; role builder(s) or tester(s), any case) as {builder?, tester?: {model, effort}}; any other text is prose.
// A counted phrase with a model other than opus or sonnet, an effort other than low or medium (R2: high and xhigh included), or two lines for
// one role that disagree gives `refuse`, the reason factory start refuses the crew with: it never lowers an effort silently.
type Members = Partial<Record<'builder' | 'tester', { model: string; effort: string }>>
export function membersOf(section: string | undefined, goalFile: string): { members: Members; refuse?: string } {
  const members: Members = {}
  const tail = `factory start never lowers an effort silently. Set ## Engine to project-manager in ${goalFile} to run this crew on the project manager path.`
  // A goal file writes ## Members as sentences ("1 tester on Sonnet at effort medium writes the tests. Then 2 builders on Opus at
  // effort medium, split by file: ..."), so the phrase counts wherever it stands, not only as a whole line: a phrase the parser
  // skipped would run a high-effort ask at the default effort, the silent lowering R2 forbids.
  const phrase = /(?<![\w.])(\d+)\s+(builders?|testers?)\s+on\s+([A-Za-z][\w.-]*?)\s+at\s+effort\s+([A-Za-z]+)\b/gi
  for (const m of (section ?? '').matchAll(phrase)) {
    const [, n, word, model, effort] = [m[0], m[1], m[2].toLowerCase(), m[3].toLowerCase(), m[4].toLowerCase()]
    const role = word.startsWith('builder') ? 'builder' : 'tester'
    if (effort !== 'low' && effort !== 'medium') return { members, refuse: `## Members asks for ${n} ${word} at effort ${effort}; a workflow crew runs members at effort low or medium only (ADR-0009), and ${tail}` }
    if (model !== 'opus' && model !== 'sonnet') return { members, refuse: `## Members asks for ${n} ${word} on ${model}; a workflow crew runs members on opus or sonnet only, and ${tail}` }
    const old = members[role]
    if (old !== undefined && (old.model !== model || old.effort !== effort)) {
      return { members, refuse: `## Members gives the ${role} two values, ${old.model} at effort ${old.effort} and ${model} at effort ${effort}; a workflow crew takes one model and effort per role, and ${tail}` }
    }
    members[role] = { model, effort }
  }
  return { members }
}

// Creates the crew worktree on branch truss-<slug> from the target head, or reuses it when it is already there.
function ensureWorktree(repo: string, slug: string, target: string): string {
  const wt = crewWorktree(repo, slug)
  if (existsSync(wt)) return wt
  mkdirSync(path.dirname(wt), { recursive: true })
  const branch = `truss-${slug}`
  const exists = run(repo, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).status === 0
  gitOrFail(repo, exists ? ['worktree', 'add', '-q', wt, branch] : ['worktree', 'add', '-q', '-b', branch, wt, target])
  return wt
}

type StartCtx = { dir: string; repo: string; roles: Obj; settings: { merge: string; target: string; source: string }; plan: Obj; scriptPath: string; arch: string; adrs: string[]; models: Record<string, string> }
const NEED_TRANSCRIPT = 'start needs --transcript T (a Workflow run dir; the runs root is its parent) to read the runs of this session'

// A ## UX section that says UX is off: starts with none, no, off, or "ux: false" (also "ux: no" / "ux: off").
export const uxSaysOff = (uxText: string): boolean => /^(?:none|no|off|ux\s*[:=]\s*(?:false|no|off|none))(?![\w-])/i.test(uxText.trim())
// plan.json ux false wins over any ## UX section; plan.json ux true is on; otherwise a non-empty ## UX section that is not off.
export function uxOn(planUx: unknown, uxText: string): boolean {
  if (planUx === false) return false
  if (planUx === true) return true
  return uxText !== '' && !uxSaysOff(uxText)
}

// A crew entry for stage.js; `resume`, `tasks`, `done`, `answers` and `prior` are the restart facts (fresh start: null and empty).
// prior: [{at, branch}], an earlier member branch per task whose commits the crew branch lacks (priorBranches).
// Per role, the larger next-free label number of two maps.
function mergeLabelFrom(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out = { ...a }
  for (const [role, n] of Object.entries(b)) out[role] = Math.max(out[role] ?? 1, n)
  return out
}
// {role: next free number} from the labels of the crew's agents in the given runs. A resume reads these as well as the report
// files, because finish files a run's reports only after it, so a run not yet recorded would otherwise have its labels reused.
function labelsOfRuns(runs: WfRun[], slug: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of runs) for (const a of r.agents) {
    const p = parseLabel(a.label)
    if (p !== undefined && p.slug === slug) out[p.role] = Math.max(out[p.role] ?? 1, p.n + 1)
  }
  return out
}
function crewEntry(c: StartCtx, crew: Obj, wt: string, extra: { resume: string | null; tasks?: unknown[]; done?: string[]; answers?: unknown[]; prior?: { at: string; branch: string }[]; runLabels?: Record<string, number> }): Obj {
  const slug = String(crew.slug)
  const goalFile = `${c.dir}/goals/${slug}.md`
  const sections = goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '')
  // ADR-0019 item 7, the lean entry: no goal; scope and acceptanceTest only when the goal file lacks their section,
  // since stage.js then points members to goalFile for them
  const has = (h: string) => Object.hasOwn(sections, h)
  // the goal file holds the acceptance test only when its section quotes the plan's command; a section that only points
  // elsewhere (such as to the plan's acceptanceTest) leaves the command in the entry, so the prompts still print it
  const at = typeof crew.acceptanceTest === 'string' ? crew.acceptanceTest.trim() : ''
  const atInGoal = has('Acceptance test') && (at === '' || sections['Acceptance test'].includes(at))
  // ADR-0022 U3: plan.json ux true, or a ## UX section that is not empty and does not start with none; either is enough
  const uxText = sections.UX ?? ''
  const ux = uxOn(crew.ux, uxText)
  // ADR-0025 item 40, ADR-0026 item 53: the first ## UX line that reads "Live page" as a whole word after an optional list
  // marker ("-", "*", "+" or "1." / "1)", then any run of spaces), trimmed, else null. "Live pages are not built" is no Live page line.
  const livePage = uxText.split(/\r?\n/).map((l) => l.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '')).find((l) => /^Live page(?![\w-])/.test(l))?.trim() ?? null
  // ADR-0026 item 50: start --model <role>=<model> reaches the ## Members entry of that role too, so stage.js needs no change
  const members = membersOf(sections.Members, goalFile).members
  for (const role of ['builder', 'tester'] as const) {
    const m = members[role]
    if (m !== undefined && c.models[role] !== undefined) members[role] = { ...m, model: c.models[role] }
  }
  // contract-025 section 5: a work type's profile can switch the stress test on, never off
  const profile = typeof crew.workType === 'string' ? profilesOf(configOf(c.repo)).profiles[crew.workType] : undefined
  return {
    slug, stage: crew.stage, goalFile, owns: crew.owns ?? [], ...(typeof crew.workType === 'string' ? { workType: crew.workType } : {}),
    ...(atInGoal ? {} : { acceptanceTest: crew.acceptanceTest ?? '' }),
    guarded: guardedOf({ dir: c.dir, slug, wt, target: c.settings.target }).tests,
    ownTests: (Array.isArray(crew.owns) ? crew.owns : []).filter((g: unknown): g is string => typeof g === 'string' && isTestPath(g)),
    highImpact: (sections['High-impact paths'] ?? '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/`/g, '').trim()).filter((l) => l !== '' && !/^none\.?$/i.test(l)),
    stressTest: /^(yes|true)\b/i.test(sections['Stress test'] ?? '') || profile?.stressTest === true, ...(has('Approved scope') ? {} : { scope: '' }), worktree: wt, branch: `truss-${slug}`,
    base: baseOf(wt, c.settings.target), head: gitOrFail(c.repo, ['rev-parse', `refs/heads/truss-${slug}`]), architecture: c.arch, adrs: c.adrs, resume: extra.resume, tasks: extra.tasks ?? [], done: extra.done ?? [], answers: extra.answers ?? [], prior: extra.prior ?? [],
    spent: spentOf(c.dir, slug), labelFrom: mergeLabelFrom(labelFromOf(c.dir, slug), extra.runLabels ?? {}),
    ux, livePage, direction: directionOf(c.dir, slug), members,
  }
}
function stageOut(c: StartCtx, entries: Obj[], projectManagers: Obj[], refused: Obj[], stale: Obj[], unfinished: Obj[], held: Obj[] = [], direct: Obj[] = []): Obj {
  const w = loadWarned(c.dir)
  const found = buildPersonas(c.repo)
  const warnings = [...stressWarnings(c, [...entries, ...projectManagers].map((e) => String(e.slug)), w), ...roleWarnings(c, entries, w, found.personas), ...memberWarnings(c, entries), ...found.warnings]
  saveWarned(c.dir, w)
  return {
    truss: { kind: 'stage', platform: process.platform, dir: c.dir, repo: c.repo, plugin: PLUGIN, target: c.settings.target, reworkAllowance: intOr(c.plan.reworkAllowance, 2, 0), roles: c.roles, personas: found.personas, ...docKeysOf(c.repo), ...knowledgeArgsOf(c.repo, true), scriptPath: c.scriptPath, crews: entries },
    held, projectManagers, ...(direct.length > 0 ? { direct } : {}), refused, stale, unfinished, warnings,
  }
}

// ADR-0026 item 49 (b): <truss dir>/agent-warnings.json maps each agent file a newer-than-session warning named (absolute
// path) to the sha256 of its content then. A file whose content still has that hash warns no more; a new hash warns again.
// `seen` is the record as this call found it, `now` what this call warned; every crew of one call still gets its warning.
// The file is per session and cheap to drop: a missing or bad one is an empty record, and a failed write only repeats warnings.
type Warned = { seen: Record<string, string>; now: Record<string, string> }
const WARNED_FILE = (dir: string): string => `${dir}/agent-warnings.json`
function loadWarned(dir: string): Warned {
  const seen: Record<string, string> = {}
  try {
    const v = JSON.parse(readFileSync(WARNED_FILE(dir), 'utf8'))
    if (isObj(v)) for (const [k, h] of Object.entries(v)) if (typeof h === 'string') seen[k] = h
  } catch {
    // missing or bad: nothing warned yet
  }
  return { seen, now: {} }
}
function saveWarned(dir: string, w: Warned): void {
  if (Object.keys(w.now).length === 0) return
  try {
    writeFileSync(WARNED_FILE(dir), JSON.stringify({ ...w.seen, ...w.now }, null, 2) + '\n')
  } catch {
    // the warnings repeat next start; nothing else depends on the record
  }
}
// The detail text for a newer-than-session warning about the plugin's agent file `file`, or null for no warning: the
// file is not newer than the session start, git shows it unchanged since then (item 49 (a)), or this content was warned before.
function newerDetail(file: string, changed: number, started: number, w: Warned): string | null {
  if (!(changed > started)) return null
  const detail = changeDetail(file, changed, started)
  if (detail === null) return null
  const key = `${PLUGIN}/${file}`
  let hash: string
  try {
    hash = createHash('sha256').update(readFileSync(key)).digest('hex')
  } catch {
    return detail
  }
  w.now[key] = hash
  return w.seen[key] === hash ? null : detail
}
// ADR-0026 item 50: without --model the ## Members model stands (ADR-0022 U6). One warning per crew whose ## Members model
// differs from its roles row, so the PM changes models the one supported way.
function memberWarnings(c: StartCtx, entries: Obj[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    const diff: string[] = []
    for (const role of ['tester', 'builder']) {
      const m = isObj(e.members) && isObj(e.members[role]) ? String(e.members[role].model) : undefined
      const r = isObj(c.roles[role]) && typeof c.roles[role].model === 'string' ? c.roles[role].model : undefined
      if (m !== undefined && r !== undefined && m !== r) diff.push(`${role} on ${m} (roles.${role}.model is ${r})`)
    }
    if (diff.length > 0) out.push(`crew ${String(e.slug)}'s ## Members runs the ${diff.join(' and the ')}; the ## Members model stands (ADR-0022 U6). To run another model, pass start --model <role>=<model> (repeatable, also on --resume), which sets both the roles row and the ## Members entry; never edit the args file`)
  }
  return out
}

// The start time of the session, in ms since the epoch, or undefined when it can't be read: TRUSS_SESSION_START (a test
// override), else the start time of the CLAUDE_PID process: on Linux /proc/<pid>/stat field 22 over the tick rate, plus btime;
// on macOS the elapsed time `ps -o etime= -p <pid>` (locale-free, 1 s resolution, so one more second is taken off); on Windows
// PowerShell's Get-Process start time as epoch ms. Only that one process is asked about, never a scan of the process table, and
// every command runs through an argument array, never a shell string. Unreadable is undefined, and the caller warns that it
// can't tell (the safe side: a restart prompt, never a silent pass).
// Never the /proc/<pid> inode mtime, never the transcript (--continue keeps the old one). A session-start hook was not used: it
// fires on clear and compact too, which do not reload agents, and the factory cannot tell which session wrote which stamp.
export type StartProbe = { exec: (file: string, args: string[]) => string | undefined; now: () => number }
const REAL_PROBE: StartProbe = {
  exec: (file, args) => {
    const r = spawnSync(file, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return r.error === undefined && r.status === 0 ? r.stdout : undefined
  },
  now: () => Date.now(),
}
// "[[dd-]hh:]mm:ss" as seconds, or undefined.
function etimeSeconds(text: string): number | undefined {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(text.trim())
  if (m === null) return undefined
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}
export function sessionStart(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, probe: StartProbe = REAL_PROBE): number | undefined {
  const o = env.TRUSS_SESSION_START
  if (o !== undefined && o !== '') {
    const n = Number(o)
    return Number.isFinite(n) ? n : undefined
  }
  const pid = env.CLAUDE_PID
  if (pid === undefined || !/^\d+$/.test(pid)) return undefined
  if (platform === 'darwin') {
    const secs = etimeSeconds(probe.exec('ps', ['-o', 'etime=', '-p', pid]) ?? '')
    return secs === undefined ? undefined : probe.now() - (secs + 1) * 1000
  }
  if (platform === 'win32') {
    const script = `([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`
    for (const shell of ['powershell.exe', 'pwsh']) {
      const out = probe.exec(shell, ['-NoProfile', '-NonInteractive', '-Command', script])
      const n = /^\d{10,}$/.test((out ?? '').trim()) ? Number((out as string).trim()) : NaN
      if (Number.isFinite(n)) return n
    }
    return undefined
  }
  if (platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    // comm (field 2) may hold spaces and parentheses: count fields from after the last ")". Field 3 is the first after it.
    const rest = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)
    const ticks = Number(rest[22 - 3])
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync('/proc/stat', 'utf8'))?.[1])
    const hz = Number(spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim())
    if (!Number.isFinite(ticks) || !Number.isFinite(btime) || !(hz > 0) || rest.length < 20) return undefined
    return (btime + ticks / hz) * 1000
  } catch {
    return undefined
  }
}
// sessionStart, asked once per process for the same inputs: a Windows probe can launch PowerShell twice at 8 s each, and one
// start asks for it in buildPersonas, roleWarnings and stressWarnings. An unreadable start is memoised too.
const SESSION_START_MEMO = new Map<string, number | undefined>()
export function sessionStartOnce(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform, probe: StartProbe = REAL_PROBE): number | undefined {
  const key = `${platform}|${env.CLAUDE_PID ?? ''}|${env.TRUSS_SESSION_START ?? ''}`
  if (!SESSION_START_MEMO.has(key)) SESSION_START_MEMO.set(key, sessionStart(env, platform, probe))
  return SESSION_START_MEMO.get(key)
}
// One warning per crew starting now whose goal file says `## Stress test` yes, when the stress role's agent file changed after
// the session loaded its agents. Warnings never hold or refuse a crew.
function stressWarnings(c: StartCtx, slugs: string[], w: Warned): string[] {
  const out: string[] = []
  let started: number | undefined
  let read = false
  for (const slug of slugs) {
    const goalFile = `${c.dir}/goals/${slug}.md`
    if (!existsSync(goalFile) || !/^(yes|true)\b/i.test(goalSections(readFileSync(goalFile, 'utf8'))['Stress test'] ?? '')) continue
    if (!read) {
      read = true
      started = sessionStartOnce()
    }
    const type = String((isObj(c.roles.stress) ? c.roles.stress.agentType : undefined) ?? 'truss:stress-engineer')
    let changed: number | undefined
    try {
      changed = statSync(`${PLUGIN}/agents/${type.replace(/^[^:]*:/, '')}.md`).mtimeMs
    } catch {
      changed = undefined
    }
    if (changed === undefined || started === undefined) {
      out.push(`crew ${slug} runs ${type}, but I can't tell whether its agent file changed after this session loaded its agents; restart the session if it did`)
      continue
    }
    const detail = newerDetail(`agents/${type.replace(/^[^:]*:/, '')}.md`, changed, started, w)
    if (detail !== null) out.push(`crew ${slug} runs ${type}, but the role's agent file changed after this session loaded its agents (${detail}); restart the session to load it`)
  }
  return out
}
// ADR-0025 item 41: what changed in the plugin's agent file `file` (relative to PLUGIN) since the session start, for the
// newer-than-session warnings. In a git work tree with a commit before the session start: the lines added and removed since
// that commit (working tree included) and the newest commit after it that touched the file, or `uncommitted`. Else the
// file's mtime and the session start as ISO times. Read-only git only.
// ADR-0026 item 49 (a): an empty numstat (the file holds its session-start content again, reverted or restored) is null,
// no change and so no warning.
function changeDetail(file: string, mtime: number, started: number): string | null {
  const fallback = `mtime ${new Date(mtime).toISOString()}, session start ${new Date(started).toISOString()}`
  try {
    if (run(PLUGIN, ['rev-parse', '--is-inside-work-tree']).out !== 'true') return fallback
    // First-parent only: a --no-ff merge after the session start of a crew commit dated before it must not become the base.
    const base = run(PLUGIN, ['rev-list', '-1', '--first-parent', `--before=${new Date(started).toISOString()}`, 'HEAD'])
    if (base.status !== 0 || base.out === '') return fallback
    const ns = run(PLUGIN, ['diff', '--numstat', base.out, '--', file])
    if (ns.status === 0 && ns.out === '') return null
    const m = /^(\d+)\t(\d+)\t/.exec(ns.out)
    if (ns.status !== 0 || m === null) return fallback
    const last = run(PLUGIN, ['log', '-1', '--format=%h %s', `${base.out}..HEAD`, '--', file])
    const commit = last.status === 0 && last.out !== '' ? `last commit ${last.out}` : 'uncommitted'
    return `${m[1]} added, ${m[2]} removed since the session start, ${commit}`
  } catch {
    return fallback
  }
}
// ADR-0024 item 24: one warning per truss:* agent type the stage workflow spawns for a starting workflow crew, besides stress
// (stressWarnings keeps its own texts): planner, qc and writer, tester and builder when their type is truss:*, and ux when the
// entry is ux. Never designer or checker, which the stage workflow does not spawn. A type warns when its agent file is missing,
// is newer than the session start, or the session start can't be read; each warning names both fallbacks.
function roleWarnings(c: StartCtx, entries: Obj[], w: Warned, personas: Obj = {}): string[] {
  const out: string[] = []
  let started: number | undefined
  let read = false
  for (const e of entries) {
    const slug = String(e.slug)
    const roles = ['planner', 'qc', 'writer', 'tester', 'builder', ...(e.ux === true ? ['ux'] : [])]
    for (const role of roles) {
      const type = isObj(c.roles[role]) && typeof c.roles[role].agentType === 'string' ? String(c.roles[role].agentType) : ''
      if (!type.startsWith('truss:')) continue
      if (!read) {
        read = true
        started = sessionStartOnce()
      }
      const file = `agents/${type.slice('truss:'.length)}.md`
      let changed: number | undefined
      try {
        changed = statSync(`${PLUGIN}/${file}`).mtimeMs
      } catch {
        changed = undefined
      }
      const fallback = `or resume with roles.${role}.agentType set to general-purpose and an answer telling the agent to read ${file} and follow it`
      if (changed === undefined) out.push(`crew ${slug} runs ${type} as its ${role}, but its agent file ${file} is missing; restart the session once it is back, ${fallback}`)
      else if (started === undefined) out.push(`crew ${slug} runs ${type} as its ${role}, but I can't tell whether ${file} changed after this session loaded its agents; restart the session if it did, ${fallback}`)
      else {
        const detail = newerDetail(file, changed, started, w)
        if (detail !== null) out.push(`crew ${slug} runs ${type} as its ${role}, but ${file} changed after this session loaded its agents (${detail}); restart the session to load it, ${fallback}`)
      }
    }
  }
  // The judge host is no role, but plan.js and stage.js spawn truss:judge for every inlined read-only persona: a session that loaded
  // its agents before agents/judge.md existed has no such type, and the spawn would fail mid-run. Only a project with such a persona is warned.
  if (entries.length > 0 && Object.values(personas).some((p) => isObj(p) && p.readOnly === true)) {
    if (!read) started = sessionStartOnce()
    const file = `agents/${READ_ONLY_HOST.slice('truss:'.length)}.md`
    let changed: number | undefined
    try {
      changed = statSync(`${PLUGIN}/${file}`).mtimeMs
    } catch {
      changed = undefined
    }
    const slugs = entries.map((e) => String(e.slug)).join(', ')
    const fallback = 'read-only personas cannot be judged until it is loaded'
    if (changed === undefined) out.push(`crews ${slugs} may judge with ${READ_ONLY_HOST}, but its agent file ${file} is missing; restart the session once it is back, ${fallback}`)
    else if (started === undefined) out.push(`crews ${slugs} may judge with ${READ_ONLY_HOST}, but I can't tell whether ${file} changed after this session loaded its agents; restart the session if it did, ${fallback}`)
    else {
      const detail = newerDetail(file, changed, started, w)
      if (detail !== null) out.push(`crews ${slugs} may judge with ${READ_ONLY_HOST}, but ${file} changed after this session loaded its agents (${detail}); restart the session to load it, ${fallback}`)
    }
  }
  return out
}

// ==== personas (ADR-0032) ====
// A persona is a project agent type file <repo>/.claude/agents/<name>.md (symlinks followed). Role stays the pipeline slot;
// the persona is who does a task: its agent type, model, effort and standards.
const PERSONA_MODELS = ['opus', 'sonnet']
const PERSONA_EFFORT_LEVELS = ['low', 'medium', 'high']
const PERSONA_KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const PERSONA_DESCRIPTION_MAX = 400
type PersonaDoc = { fm: Record<string, string>; body: string }

// The frontmatter of an agent file as flat key/value strings (a folded or literal block value is joined), and the body after it.
// undefined when the text opens with no frontmatter block.
function parsePersonaFile(text: string): PersonaDoc | undefined {
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return undefined
  const fm: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] as string)
    if (m === null) continue
    let v = (m[2] as string).trim()
    if (v === '' || /^[>|][+-]?$/.test(v)) {
      const block: string[] = []
      while (i + 1 < end && /^\s/.test(lines[i + 1] as string)) block.push((lines[++i] as string).trim())
      v = block.join(v.startsWith('|') ? '\n' : ' ').trim()
    } else if (/^(["']).*\1$/.test(v)) {
      v = v.slice(1, -1)
    }
    fm[m[1] as string] = v
  }
  return { fm, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '') }
}

// Why a persona file is not valid, or undefined. fileName is the name without .md.
function personaFault(fileName: string, doc: PersonaDoc | undefined): string | undefined {
  if (doc === undefined) return 'it has no frontmatter block'
  const { fm } = doc
  if (fm.name !== fileName) return `its frontmatter name ${fm.name === undefined ? '(missing)' : fm.name} differs from the file name ${fileName}`
  if ((fm.description ?? '') === '') return 'it has no description'
  if (fm.model !== undefined && !PERSONA_MODELS.includes(fm.model)) return `its model ${fm.model} is not opus or sonnet`
  if (fm.effort !== undefined && !PERSONA_EFFORT_LEVELS.includes(fm.effort)) return `its effort ${fm.effort} is not low, medium or high`
  // a file cut short by a fence that closed early has no Standards section: it is not installed
  if (!/^##[ \t]+Standards[ \t]*$/m.test(doc.body)) return 'it has no ## Standards heading (a draft cut short by an early-closing fence has none)'
  return undefined
}

// An editing persona: no tools line, or a tools line that holds Write or Edit (or all tools).
function personaReadOnly(fm: Record<string, string>): boolean {
  if (fm.tools === undefined) return false
  const tools = fm.tools.replace(/[[\]"']/g, '').split(/[,\s]+/).filter((t) => t !== '')
  if (tools.length === 0) return false
  return !tools.some((t) => t === 'Write' || t === 'Edit' || t === '*')
}

// The agent type that hosts a read-only persona whose body is inlined (it is not loaded, or only a draft exists): a plugin type that
// is always loaded and whose tools hold neither Write nor Edit, so an inlined judge never gets write tools. It is
// truss:judge (agents/judge.md; Read, Grep, Glob, Bash): a neutral host whose only instruction is to adopt the persona definition at
// the top of the brief, so no other role's system prompt competes with it.
const READ_ONLY_HOST = 'truss:judge'
function personaInlineType(): string {
  return READ_ONLY_HOST
}

// The personas the stage args carry, from the main checkout's .claude/agents/*.md. loaded: the file is not newer than the session
// start (the session loads agent types only at start); false too when the start can't be read, the safe side. An unloaded
// persona carries its body, since stage.js runs it as general-purpose with that body inlined. A malformed file is skipped with a warning.
function buildPersonas(repo: string): { personas: Obj; warnings: string[] } {
  const personas: Obj = {}
  const warnings: string[] = []
  const dir = `${flat(repo)}/.claude/agents`
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return { personas, warnings }
  }
  const started = sessionStartOnce()
  for (const n of names) {
    const file = `${dir}/${n}`
    const name = n.slice(0, -'.md'.length)
    let text: string
    let changed: number
    try {
      text = readFileSync(file, 'utf8')
      changed = statSync(file).mtimeMs // through a symlink: the real file's time
    } catch (e) {
      warnings.push(`persona file ${file} is skipped: it can't be read (${(e as Error).message})`)
      continue
    }
    const doc = parsePersonaFile(text)
    const fault = personaFault(name, doc)
    if (fault !== undefined || doc === undefined) {
      warnings.push(`persona file ${file} is skipped: ${fault}`)
      continue
    }
    const loaded = started !== undefined && !(changed > started)
    const readOnly = personaReadOnly(doc.fm)
    personas[name] = {
      agentType: name, model: doc.fm.model ?? 'sonnet', effort: doc.fm.effort ?? 'medium', file, description: (doc.fm.description as string).slice(0, PERSONA_DESCRIPTION_MAX),
      readOnly, ...(readOnly ? { inlineType: personaInlineType() } : {}), loaded, ...(loaded ? {} : { body: doc.body }),
    }
    if (!loaded) {
      warnings.push(`persona ${name} (${file}) is ${started === undefined ? "not known to be loaded (I can't read the session start)" : 'newer than the session start, so this session has not loaded it'}; its tasks run as ${readOnly ? READ_ONLY_HOST : 'general-purpose'} with its definition inlined. Restart the session to load it`)
    }
  }
  return { personas, warnings }
}

// factory persona-install --from <dir> --repo <root> [--replace]: copies <dir>/*.md into <root>/.claude/agents/ and commits them.
function cmdPersonaInstall(f: Flags): Obj {
  const from = need(f, 'from')
  const repo = repoOf(f)
  const replace = f.replace === true
  let entries: string[]
  try {
    entries = readdirSync(from).filter((n) => n.endsWith('.md')).sort()
  } catch (e) {
    throw usage(`cannot read --from ${flat(from)}: ${(e as Error).message}`)
  }
  const jobs: { name: string; text: string }[] = []
  for (const n of entries) {
    const name = n.slice(0, -'.md'.length)
    if (!PERSONA_KEBAB.test(name)) throw usage(`${n}: the persona name must be kebab-case (lowercase letters, digits, hyphens)`)
    const fault = personaFault(name, parsePersonaFile(readText(path.join(from, n))))
    if (fault !== undefined) throw usage(`${n}: ${fault}`)
    jobs.push({ name, text: readText(path.join(from, n)) })
  }
  const target = path.join(repo, '.claude', 'agents')
  const installed: string[] = []
  const skipped: string[] = []
  const written: string[] = []
  for (const j of jobs) {
    const to = path.join(target, `${j.name}.md`)
    if (existsSync(to)) {
      if (readFileSync(to).equals(readFileSync(path.join(from, `${j.name}.md`)))) continue
      if (!replace) {
        skipped.push(j.name)
        continue
      }
    }
    mkdirSync(target, { recursive: true })
    copyFileSync(path.join(from, `${j.name}.md`), to)
    installed.push(j.name)
    written.push(path.posix.join('.claude', 'agents', `${j.name}.md`))
  }
  let commit: string | null = null
  if (written.length > 0) {
    gitOrFail(repo, ['add', '--', ...written])
    if (run(repo, ['diff', '--cached', '--quiet', '--', ...written]).status !== 0) {
      gitOrFail(repo, ['commit', '-q', '-m', `chore(agents): add personas ${installed.join(', ')}`, '--', ...written])
      commit = gitOrFail(repo, ['rev-parse', 'HEAD'])
    }
  }
  return { installed, skipped, commit }
}

// ADR-0024 item 26: the crew's member worktrees, found by their branch names worktree-<run id>-<n> for the crew's runs,
// whose directory is gone (with no runs, any worktree-*-<n> branch forked from the crew branch). When any is, a decision line names them and `git worktree prune` drops their registrations.
function missingWorktrees(c: StartCtx, slug: string, runs: WfRun[]): { branch: string; worktree: string }[] {
  const ids = new Set(runs.map((r) => r.id))
  // With no runs (merge-ready without --transcript) a member branch is the crew's when it shares a commit with truss-<slug>
  // that the target lacks: a member branch forks from the crew head, and another crew's forks from its own branch.
  const crews = (branch: string): boolean => {
    const mb = run(c.repo, ['merge-base', branch, `truss-${slug}`])
    return mb.status === 0 && run(c.repo, ['merge-base', '--is-ancestor', mb.out.trim(), c.settings.target]).status === 1
  }
  const out: { branch: string; worktree: string }[] = []
  const list = run(c.repo, ['worktree', 'list', '--porcelain'])
  if (list.status !== 0) return out
  let wtPath: string | undefined
  for (const line of list.out.split('\n')) {
    if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/') && wtPath !== undefined) {
      const branch = line.slice('branch refs/heads/'.length)
      const m = /^worktree-(.+)-(\d+)$/.exec(branch)
      if (m !== null && !existsSync(wtPath) && (runs.length === 0 ? crews(branch) : ids.has(m[1] as string))) out.push({ branch, worktree: flat(wtPath) })
    }
  }
  if (out.length > 0) {
    appendDecision(c.dir, `crew ${slug}: member worktree(s) gone before the resume: ${out.map((w) => `${w.branch} (${w.worktree})`).join(', ')} | ran git worktree prune so a recreated member worktree is not refused; the branches stay`)
    run(c.repo, ['worktree', 'prune'])
  }
  return out
}

// ADR-0024 item 35: the newest `<slug>-ux*` agent result of the crew's runs (highest label number, later run on a tie) whose
// first non-empty line, after unbannered, is UX: DIRECTION, as {label, text} trimmed as directionOf trims it; null when none.
function runDirectionOf(runs: WfRun[], slug: string): { label: string; text: string } | null {
  let best: { n: number; label: string; text: string } | undefined
  for (const wfRun of runs) {
    for (const a of wfRun.agents) {
      const p = parseLabel(a.label)
      if (p === undefined || p.slug !== slug || p.role !== 'ux' || !a.hasResult || typeof a.result !== 'string') continue
      if (!/^UX: DIRECTION\b/.test(firstLine(a.result))) continue
      if (best === undefined || p.n >= best.n) best = { n: p.n, label: a.label, text: unbannered(a.result.replace(/^﻿/, '').replace(/\r/g, '')).trim() }
    }
  }
  return best === undefined ? null : { label: best.label, text: best.text }
}

// The runs of this session: the dirs next to the transcript dir T (T's parent is the runs root).
const runsNextTo = (transcript: string): WfRun[] => runsOf(path.dirname(flat(transcript).replace(/\/+$/, '')))
const eventsOf = (dir: string): Obj[] => (existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : [])

// The runs that hold one of the crew's labels, oldest first (newest mtime, then id).
const crewRunsOf = (runs: WfRun[], slug: string): WfRun[] =>
  runs.filter((r) => r.agents.some((a) => parseLabel(a.label)?.slug === slug)).sort((a, b) => newestMtime(a.dir) - newestMtime(b.dir) || (a.id < b.id ? -1 : 1))
type CrewState = { kind: 'none' } | { kind: 'unfinished'; run: string | null } | { kind: 'returned' } | { kind: 'live' } | { kind: 'stale'; since: string }
// The state of a running workflow crew, read from files (ADR-0009 "start, stale runs"); `none` when rule 1 fails.
// runs undefined means no --transcript was given: nothing can be read, so the crew fails closed as unfinished.
function crewState(dir: string, crew: Obj, runs: WfRun[] | undefined, events: Obj[], now: number): CrewState {
  const slug = String(crew.slug)
  const spawn = factorySpawned(dir, slug)
  if (crew.status !== 'running' || spawn === undefined) return { kind: 'none' }
  if (runs === undefined) return { kind: 'unfinished', run: null }
  const holding = crewRunsOf(runs, slug)
  const newest = holding[holding.length - 1]
  if (newest !== undefined) {
    if (!events.some((e) => e.event === 'spawn' && e.crew === slug && e.by === `workflow:${newest.id}`)) return { kind: 'unfinished', run: newest.id }
    if (!events.some((e) => e.event === 'incomplete' && e.crew === slug && e.run === newest.id)) return { kind: 'returned' }
  }
  if (isLive(String(spawn.ts), newest?.dir, now)) return { kind: 'live' }
  return { kind: 'stale', since: String(spawn.ts) }
}

// The tasks of the highest-numbered `<slug>-planner*` result over the crew's runs, and the index of the run that holds it
// (0 when none does). labelFrom numbers labels on across runs, so the highest is the newest plan; on a tie the later run wins.
function plannerTasks(runs: WfRun[], slug: string): { tasks: unknown[]; from: number } {
  let best = 0
  let out = { tasks: [] as unknown[], from: 0 }
  runs.forEach((wfRun, i) => {
    for (const a of wfRun.agents) {
      const p = parseLabel(a.label)
      if (p === undefined || p.slug !== slug || p.role !== 'planner' || !a.hasResult || p.n < best) continue
      let r = a.result
      if (typeof r === 'string') {
        try {
          r = JSON.parse(r)
        } catch {
          continue
        }
      }
      if (isObj(r) && Array.isArray(r.tasks)) {
        best = p.n
        out = { tasks: r.tasks, from: i }
      }
    }
  })
  return out
}
// The task name a member's prompt gives: the `Task: <name>` line directly followed by a `Files you may change:` line, read from
// the first user record of the agent transcript (a string, or an array of text blocks). undefined when there is none.
function promptTask(transcript: string): string | undefined {
  if (!existsSync(transcript)) return undefined
  const first = jsonLines(transcript).find((rec) => rec.type === 'user')
  const c = first?.message?.content
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: unknown) => (typeof b === 'string' ? b : isObj(b) && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
  const lines = text.split('\n')
  for (let i = 0; i + 1 < lines.length; i++) {
    const m = /^\s*Task: (.+?)\s*$/.exec(lines[i] as string)
    if (m?.[1] !== undefined && /^\s*Files you may change:/.test(lines[i + 1] as string)) return m[1]
  }
  return undefined
}
// Names of the tasks whose member result is DONE and whose branch is an ancestor of the crew branch or has every commit
// patch-id-matched on it (git decides, not the report), over the given runs: a task done in an earlier run, and passed in `done`
// to a later one that never re-ran it, stays done. The name is the prompt's Task line, else result.task minus a leading `<slug>: `.
// ADR-0024 item 27: a result whose marker isn't DONE (nor CHECKPOINT) counts too, when its branch has commits of its own and the crew branch
// holds them all (as above). A branch's own commits are those not on `target` and not behind its fork point, the newest commit
// of the crew branch's first-parent line it contains: a fresh member branch (one that only points at a crew head, old or
// current) has none, though it is an ancestor. When that count is 0, commits the branch's reflog shows were made on it count:
// a hand `git merge` that fast-forwards puts them on the first-parent line. ADR-0025 item 42: when the branch holds no commit of
// that line (the crew branch was rewritten after the member forked), the reflog count is the only count.
function doneTasks(runs: WfRun[], slug: string, wt: string, target: string): string[] {
  const crewBranch = `truss-${slug}`
  const { ownCommits, picked } = memberGit(slug, wt, target)
  const done: string[] = []
  // runs come oldest first and a run's agents in start order, so the last result of a task is its newest
  const agents = runs.flatMap((r) => r.agents)
  const names = agents.map((a) => memberTaskOf(a, slug))
  const newest = new Map<string, number>()
  names.forEach((n, i) => {
    if (n !== undefined) newest.set(n, i)
  })
  for (const [i, a] of agents.entries()) {
    const r = a.result
    const name = names[i]
    if (name === undefined || !isObj(r) || typeof r.branch !== 'string') continue
    if (done.includes(name)) continue
    // ADR-0024 item 27 counts a result that isn't DONE only when it is the task's newest: an older hand-merged BLOCKED branch
    // never makes done a task whose newer result stopped again on an unmerged branch.
    if (r.marker !== 'DONE' && newest.get(name) !== i) continue
    // A CHECKPOINT says the member stopped with work left, so its merged commits are partial and never make the task done.
    if (r.marker === 'CHECKPOINT' || (r.marker !== 'DONE' && ownCommits(r.branch) === 0)) continue
    if (run(wt, ['merge-base', '--is-ancestor', r.branch, crewBranch]).status === 0 || picked(r.branch)) done.push(name)
  }
  return done
}

// The member's task name: the prompt's Task line, else result.task minus a leading `<slug>: `; undefined for another crew's agent
// or a result with no task. A fix member's name is its `fix, <what>` Task line.
function memberTaskOf(a: RunAgent, slug: string): string | undefined {
  const r = a.result
  if (parseLabel(a.label)?.slug !== slug || !isObj(r) || typeof r.task !== 'string') return undefined
  return promptTask(a.transcript) ?? (r.task.startsWith(`${slug}: `) ? r.task.slice(slug.length + 2) : r.task)
}

// The earlier member branches a resumed crew's members must merge (stage.js firstStep): for each task (or `fix, <what>`) not in
// `done`, the branch of its newest result when that result is not DONE (QUESTION, BLOCKED, PROPOSAL or CHECKPOINT), the branch has
// commits of its own, and the crew branch holds neither the branch nor a patch-id match of every commit on it. A resumed member
// forks from the session checkout, not from that branch, so without the merge those commits are lost.
function priorBranches(runs: WfRun[], slug: string, wt: string, target: string, done: string[]): { at: string; branch: string }[] {
  const crewBranch = `truss-${slug}`
  const { ownCommits, picked } = memberGit(slug, wt, target)
  const newest = new Map<string, Obj>()
  for (const a of runs.flatMap((r) => r.agents)) {
    const name = memberTaskOf(a, slug)
    if (name !== undefined && isObj(a.result)) newest.set(name, a.result)
  }
  const out: { at: string; branch: string }[] = []
  for (const [at, r] of newest) {
    const branch = r.branch
    if (done.includes(at) || r.marker === 'DONE' || typeof branch !== 'string' || branch === '' || branch === crewBranch) continue
    if (run(wt, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).status !== 0) continue
    if (ownCommits(branch) === 0) continue
    if (run(wt, ['merge-base', '--is-ancestor', branch, crewBranch]).status === 0 || picked(branch)) continue
    out.push({ at, branch })
  }
  return out
}

// git facts about a crew's member branches. ownCommits: the commits the member made on its branch (see doneTasks). picked: every
// commit the branch has over the crew branch is patch-id-matched on it (git cherry).
function memberGit(slug: string, wt: string, target: string): { ownCommits: (branch: string) => number; picked: (branch: string) => boolean } {
  const crewBranch = `truss-${slug}`
  const lines = (args: string[]): string[] | undefined => {
    const x = run(wt, args)
    return x.status === 0 ? x.out.split('\n').filter((l) => l.trim() !== '') : undefined
  }
  const picked = (branch: string): boolean => {
    const c = run(wt, ['cherry', crewBranch, branch])
    return c.status === 0 && c.out.split('\n').filter((l) => l.trim() !== '').every((l) => l.startsWith('-'))
  }
  const ownCommits = (branch: string): number => {
    const reach = lines(['rev-list', branch, '--not', target])
    const spine = lines(['rev-list', '--first-parent', crewBranch, '--not', target])
    if (reach === undefined || spine === undefined) return 0
    const inBranch = new Set(reach)
    // The branch's reflog tells a member's own commits apart: a commit the member made on it (commit, cherry-pick, revert)
    // that the branch still reaches and `target` lacks is its own; a creation or a fast-forward onto a crew head is not.
    // A missing reflog counts 0, so the task re-runs. ADR-0026 item 58 (a): a `rebase (finish): refs/heads/<b> onto <onto>`
    // entry whose sha the branch still reaches counts the commits in `<onto>..<sha>` that the branch reaches and `target`
    // lacks: the member's rebased own commits, which a fast-forward of the crew branch puts on its first-parent line.
    const made = (): number => {
      const own = new Set<string>()
      for (const l of lines(['log', '-g', '--format=%H %gs', `refs/heads/${branch}`]) ?? []) {
        const sha = l.split(' ')[0] as string
        if (!inBranch.has(sha)) continue
        if (/^[0-9a-f]+ (commit|cherry-pick|revert)\b/.test(l)) own.add(sha)
        const reb = /^[0-9a-f]+ rebase(?: -[a-z]+)? \(finish\): \S+ onto ([0-9a-f]+)\s*$/.exec(l)
        if (reb !== null) for (const s of lines(['rev-list', sha, '--not', reb[1] as string, target]) ?? []) if (inBranch.has(s)) own.add(s)
      }
      return own.size
    }
    const fork = spine.find((s) => inBranch.has(s))
    // ADR-0025 item 42: no first-parent crew commit in the branch means the crew branch was rewritten after the member forked,
    // so `reach` still holds the old crew commits; a fresh branch left on the old crew head would count them. The reflog decides.
    if (fork === undefined) return made()
    const behind = lines(['rev-list', branch, '--not', target, fork])?.length ?? 0
    if (behind > 0) return behind
    // A fork-point count of 0 can be a hand merge that fast-forwarded the crew branch onto the member's own tip, so the
    // member's commits sit on the first-parent line; the reflog decides here too.
    return made()
  }
  return { ownCommits, picked }
}

// start --slug S --resume answers|merge-ready|stale: one crew entry, or a refusal {slug, why}.
/** The ids of plan.goals rows whose approvedAt is null; the top-level goal `run` is never one. */
function unapprovedGoals(plan: Obj): Set<string> {
  const goals: unknown[] = Array.isArray(plan.goals) ? plan.goals : []
  return new Set(goals.filter((g): g is Obj => isObj(g) && g.approvedAt === null && typeof g.id === 'string' && g.id !== RUN_GOAL).map((g) => String(g.id)))
}

const isDirect = (crew: Obj): boolean => crew.process === 'solo' || crew.process === 'lean'

function cmdStartResume(f: Flags, c: StartCtx, slug: string, kind: string): Obj {
  if (!['answers', 'merge-ready', 'stale'].includes(kind)) throw usage(`--resume needs answers, merge-ready or stale, got ${kind}`)
  // ADR-0031 item 6: a solo or lean crew runs direct and merges with land, so it is never resumed (before any flag check)
  const direct = c.plan.crews.find((x: unknown) => isObj(x) && x.slug === slug && isDirect(x))
  if (direct !== undefined && c.settings.merge !== 'single') throw refuse({ slug, why: `${slug} is a ${String(direct.process)} crew; it runs direct, so merge it with land` })
  const transcript = str(f, 'transcript') ?? ''
  if ((kind === 'answers' || kind === 'stale') && transcript === '') throw usage(`--resume ${kind} needs --transcript T: ${NEED_TRANSCRIPT}`)
  let answers: unknown[] = []
  if (kind === 'answers') {
    const a = readJson(need(f, 'answers'))
    if (!Array.isArray(a) || !a.every((x) => isObj(x) && typeof x.at === 'string' && typeof x.text === 'string')) throw usage('--answers must be a JSON array of {"at","text"}')
    answers = a
  }
  const crew = c.plan.crews.find((x: unknown) => isObj(x) && x.slug === slug)
  // ADR-0025 item 37: a crew of an unapproved goal is never resumed
  if (crew !== undefined && unapprovedGoals(c.plan).has(goalOf(crew))) throw refuse({ slug, why: `its goal ${goalOf(crew)} is not approved (approvedAt is null)` })
  if (crew === undefined || crew.status !== 'running' || factorySpawned(c.dir, slug) === undefined) throw refuse({ slug, why: kind === 'stale' ? 'not stale' : 'not restartable' })
  // tasks and done are rebuilt from every run of the crew in the runs root (T's parent), T included, not from T alone:
  // a resumed run that took saved tasks has no planner result, and its done list holds tasks no member of it ran.
  let runs: WfRun[] = []
  if (kind === 'stale') {
    const all = runsNextTo(transcript)
    const st = crewState(c.dir, crew, all, eventsOf(c.dir), Date.now())
    if (st.kind === 'returned' || st.kind === 'none') throw refuse({ slug, why: 'not stale' })
    if (st.kind === 'unfinished') throw refuse({ slug, why: 'run not finished' })
    if (st.kind === 'live') throw refuse({ slug, why: 'run may be live' })
    runs = crewRunsOf(all, slug)
  } else if (transcript !== '') {
    // answers, and merge-ready given --transcript (whose runs only find member worktrees and the direction; it rebuilds nothing)
    const t = runOf(transcript)
    const all = runsNextTo(transcript)
    runs = crewRunsOf(all.some((r) => r.id === t.id) ? all : [...all, t], slug)
  }
  // An answer at a step after red needs the red record, as mergeCrew does; an answer at red itself does not.
  if (kind === 'answers' && answers.length > 0 && !answers.some((x) => isObj(x) && x.at === 'red')) {
    const red = redRecord(c.dir, slug)
    if (red === undefined || !Number.isInteger(red.exit) || red.exit === 0) throw refuse({ slug, why: 'no red record: the lowest-numbered checks file is missing or has exit 0, so an answer after red has nothing to resume' })
  }
  // ADR-0022 U6 (R2): the same ## Members check as a fresh start, before the worktree and the entry
  const goalFile = `${c.dir}/goals/${slug}.md`
  const membersDeny = membersOf(goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '').Members, goalFile).refuse
  if (membersDeny !== undefined) return stageOut(c, [], [], [{ slug, reason: membersDeny }], [], [])
  const wt = ensureWorktree(c.repo, slug, c.settings.target)
  // A stale crew whose branch has no commit beyond the base starts from step 1.
  const noWork = kind === 'stale' && Number(run(wt, ['rev-list', '--count', `${baseOf(wt, c.settings.target)}..HEAD`]).out) === 0
  const rebuild = kind !== 'merge-ready' && !noWork
  // done counts only from the run of the chosen plan on, so a re-split's task names never match an older plan's members
  const plan = rebuild ? plannerTasks(runs, slug) : { tasks: [], from: 0 }
  const done = rebuild ? doneTasks(runs.slice(plan.from), slug, wt, c.settings.target).filter((t) => !answers.some((x) => isObj(x) && x.at === t)) : []
  // ADR-0019 item 7: a done task never runs again, so its entry keeps only what stage.js checks and orders by. Review 3: and the
  // brief and persona when present, because a main-session change or an answer can still rerun the task, and a rerun needs both.
  const tasks = plan.tasks.map((t: unknown) => (isObj(t) && done.includes(String(t.name)) ? { name: t.name, role: t.role, effort: t.effort, files: t.files, after: t.after, ...(typeof t.brief === 'string' ? { brief: t.brief } : {}), ...(typeof t.persona === 'string' && t.persona !== '' ? { persona: t.persona } : {}) } : t))
  // answers and stale: an earlier member's stopped branch whose commits the crew branch lacks, so its resumed successor merges it
  const prior = rebuild ? priorBranches(runs.slice(plan.from), slug, wt, c.settings.target, done) : []
  const entry = crewEntry(c, crew, wt, { resume: kind, tasks, done, answers, prior, runLabels: labelsOfRuns(runs, slug) })
  // review 2: what the crew's members reported before the restart (crew-learned) goes back in, so the knowledge step and QC still see
  // it; a result read earlier no longer holds for a crew that runs again
  entry.learned = learnedOf(c.dir, slug)
  setCrewState(c.dir, slug, null)
  // ADR-0024 item 35: a resume before `finish` has no ux report yet; the direction comes from the crew's agent results
  if (entry.direction === null) entry.direction = runDirectionOf(runs, slug)
  const missing = missingWorktrees(c, slug, runs)
  // The crew's first stress test report (label <slug>-stress, stage.js nextLabel :108-112): its ## Notes bullets, parsed as stage.js stressTest() :479 and sectionOf :466-473.
  const rtFile = `${c.dir}/reports/${slug}/${slug}-stress.md`
  if (existsSync(rtFile)) {
    let section: string | undefined
    entry.deferred = []
    for (const line of readFileSync(rtFile, 'utf8').replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n')) {
      if (line.startsWith('## ')) section = line.trimEnd()
      else if (section === '## Notes' && line.startsWith('- ')) entry.deferred.push(line.slice(2))
    }
  }
  if (kind === 'stale') {
    appendEvent(c.dir, { event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', ...roleDefaults(c.roles, 'planner'), by: 'factory' })
    appendDecision(c.dir, `restarted stale workflow crew ${slug} | its stage.js run died; same worktree and branch; ${entry.spent} repair round(s) already spent`)
  }
  const out = stageOut(c, [entry], [], [], [], [])
  return missing.length > 0 ? { ...out, missingWorktrees: missing } : out
}

function cmdStart(f: Flags): Obj {
  const dir = path.resolve(startDirOf(f))
  const repo = path.resolve(repoOf(f))
  const roles = rolesWithTypes(PLUGIN, listOf(f, 'type'), configOf(repo).roles)
  const settings = settingsOf(repo)
  const plan = loadPlan(dir)
  excludeScratch(repo)
  const scriptPath = scriptPathFor(PLUGIN, 'stage.js', str(f, 'scripts-dir'))
  const arch = archPath(repo, plan.architecture)
  const adrDir = `${path.posix.dirname(arch)}/adr`
  const adrs = existsSync(adrDir) ? readdirSync(adrDir).filter((n) => n.endsWith('.md')).sort().map((n) => `${adrDir}/${n}`) : []
  const models = modelsOf(f, roles)
  const ctx: StartCtx = { dir, repo, roles, settings, plan, scriptPath, arch, adrs, models }
  const slugFlag = str(f, 'slug')
  const resumeFlag = str(f, 'resume')
  if (resumeFlag !== undefined) {
    if (!slugFlag || !resumeFlag) throw usage('start --resume needs --slug S')
    return cmdStartResume(f, ctx, slugFlag, resumeFlag)
  }
  if (slugFlag === '') throw usage('start --slug needs a crew slug')
  // ADR-0026 item 46: --slug S without --resume considers crew S only, with --stage optional (default next)
  const only = slugFlag
  const stageArg = only !== undefined ? (str(f, 'stage') ?? 'next') : need(f, 'stage')
  const noWorkflow = f['no-workflow'] === true
  // ADR-0025 item 37: a crew whose goal is in plan.goals with approvedAt null is skipped: not started, refused, held or in goalNext
  const unapproved = unapprovedGoals(plan)
  const crews: Obj[] = plan.crews.filter(isObj).filter((c: Obj) => !unapproved.has(goalOf(c)))
  const picked = only === undefined ? undefined : plan.crews.find((c: Obj) => isObj(c) && c.slug === only)
  if (only !== undefined) {
    if (picked === undefined) throw refuse({ error: `start --slug ${only}: no crew ${only} in the plan` })
    if (unapproved.has(goalOf(picked))) throw refuse({ error: `start --slug ${only}: its goal ${goalOf(picked)} is not approved (approvedAt is null)` })
    if (picked.status === 'running') {
      // a PM resuming a crew that is already running gets a clear no-op, not an error
      return { noop: true, slug: only, note: `start --slug ${only}: the crew is already running; nothing started. To restart a dead run use start --slug ${only} --resume stale (or answers / merge-ready)`, entries: [], held: [], refused: [] }
    }
    if (picked.status !== 'planned') throw refuse({ error:`start --slug ${only}: the crew is ${String(picked.status)}, not planned; a running crew restarts with --resume` })
  }
  const open =crews.filter((c) => c.status === 'planned' || c.status === 'running').map((c) => c.stage).filter((w) => typeof w === 'number')
  // A plan with a goals array gets per-goal stages; a plan without one takes the single global next stage, as before.
  const hasGoals = Array.isArray(plan.goals) && plan.goals.length > 0
  const goalNext = new Map<string, number>()
  for (const c of crews) {
    if ((c.status !== 'planned' && c.status !== 'running') || typeof c.stage !== 'number') continue
    const g = goalOf(c)
    goalNext.set(g, Math.min(goalNext.get(g) ?? Infinity, c.stage))
  }
  // ADR-0025 item 37: a --stage N that only an unapproved goal has is refused as not the next stage of any goal, even
  // when no approved crew is open, so the goalNext check runs before the no-open-crew refusal.
  if (hasGoals && stageArg !== 'next' && ![...goalNext.values()].includes(Number(stageArg))) {
    throw refuse({ error: `stage ${stageArg} is not the next stage of any goal: ${[...goalNext].map(([g, w]) => `${g} ${w}`).join(', ') || 'none'}` })
  }
  if (open.length === 0) throw refuse({ error: 'no stage has a planned or running crew' })
  const next = Math.min(...open)
  if (!hasGoals && stageArg !== 'next' && Number(stageArg) !== next) throw refuse({ error: `stage ${stageArg} is not the next stage: ${next}` })
  const startsNow = (crew: Obj): boolean => (hasGoals ? goalNext.get(goalOf(crew)) === crew.stage && (stageArg === 'next' || Number(stageArg) === crew.stage) : crew.stage === next)
  if (picked !== undefined && !startsNow(picked)) {
    const at = hasGoals ? `its goal ${goalOf(picked)}'s next stage is ${goalNext.get(goalOf(picked)) ?? 'none'}` : `the next stage is ${next}`
    throw refuse({ error: `start --slug ${only}: the crew is in stage ${String(picked.stage)}, but ${at}${stageArg === 'next' ? '' : ` (--stage ${stageArg})`}` })
  }
  const cap = intOr(plan.maxParallelCrews, 4, 1)
  let slots = cap - crews.filter((c) => c.status === 'running').length
  const wasRunning = crews.filter((c) => c.status === 'running')
  const projectManagers: Obj[] = []
  const refused: Obj[] = []
  const entries: Obj[] = []
  const held: Obj[] = []
  const direct: Obj[] = []
  for (const crew of picked === undefined ? crews : [picked]) {
    if (!startsNow(crew) || crew.status !== 'planned') continue
    // a picked crew is held with admission's reason rather than dropped: admission's parallelism is never above the cap,
    // so a full cap holds it there
    if (slots <= 0 && picked === undefined) break
    const missingGoal = `${dir}/goals/${String(crew.slug)}.md`
    if (!existsSync(missingGoal)) {
      refused.push({ slug: String(crew.slug), reason: `the goal file ${missingGoal} is missing` })
      continue
    }
    const adm = heldOnBusy(() => admission(dir, repo, plan, crew, 'start', wasRunning.length + entries.length + projectManagers.length + direct.length))
    if (!adm.admitted) {
      held.push({ slug: String(crew.slug), why: adm.why })
      continue
    }
    const slug = String(crew.slug)
    const goalFile = `${dir}/goals/${slug}.md`
    const sections = goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '')
    // ADR-0031 item 6: a planned solo or lean crew runs direct; same planVerdict, no engine split, no ## Members check
    // Under merge single `land` refuses, so a solo or lean crew takes the project manager path like a full crew
    if (isDirect(crew) && settings.merge !== 'single') {
      const directVerdict = planVerdict(parsePlan(JSON.stringify(plan)) as any, slug)
      if (directVerdict !== undefined) {
        refused.push({ slug, reason: directVerdict.deny })
        continue
      }
      const wt = ensureWorktree(repo, slug, settings.target)
      crew.status = 'running'
      patchPlan(dir, (p) => { const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug); if (e !== undefined) e.status = 'running' })
      appendDecision(dir, `started direct crew ${slug} (process ${String(crew.process)}) in stage ${crew.stage} | worktree truss-${slug} from ${settings.target}`)
      slots--
      direct.push({ slug, process: crew.process, qc: crew.process === 'lean' ? crew.qc === true : false, red: crew.process === 'lean' ? crew.red === true : false, worktree: wt, branch: `truss-${slug}` })
      continue
    }
    const { engine, reason } = engineOf(sections, settings.merge, noWorkflow)
    if (engine === 'project-manager') {
      const projectManagerVerdict = hasGoals ? planVerdict(parsePlan(JSON.stringify(plan)) as any, slug) : undefined
      if (projectManagerVerdict !== undefined) {
        refused.push({ slug, reason: projectManagerVerdict.deny })
        continue
      }
      projectManagers.push({ slug, reason })
      slots--
      continue
    }
    const verdict = planVerdict(parsePlan(JSON.stringify(plan)) as any, slug)
    if (verdict !== undefined) {
      refused.push({ slug, reason: verdict.deny })
      continue
    }
    // ADR-0022 U6 (R2): a ## Members line the workflow can't run refuses the crew before its worktree; the crew stays planned
    const membersDeny = membersOf(sections.Members, goalFile).refuse
    if (membersDeny !== undefined) {
      refused.push({ slug, reason: membersDeny })
      continue
    }
    const wt = ensureWorktree(repo, slug, settings.target)
    crew.status = 'running'
    patchPlan(dir, (p) => { const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug); if (e !== undefined) e.status = 'running' })
    appendEvent(dir, { event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', ...roleDefaults(roles, 'planner'), by: 'factory' })
    appendDecision(dir, `started workflow crew ${slug} in stage ${crew.stage}${goalOf(crew) === RUN_GOAL ? '' : ` of goal ${goalOf(crew)}`} | worktree truss-${slug} from ${settings.target}; the cap leaves ${slots - 1} slot(s)`)
    slots--
    entries.push(crewEntry(ctx, crew, wt, { resume: null }))
  }
  // Running workflow crews that were already running before this call. --transcript T names the runs root (its parent); without it nothing can be read.
  const transcript = str(f, 'transcript')
  const runs = transcript ? runsNextTo(transcript) : undefined
  const events = eventsOf(dir)
  const stale: Obj[] = []
  const unfinished: Obj[] = []
  for (const crew of wasRunning) {
    const st = crewState(dir, crew, runs, events, Date.now())
    if (st.kind === 'stale') stale.push({ slug: crew.slug, since: st.since })
    else if (st.kind === 'unfinished') unfinished.push({ slug: crew.slug, run: st.run })
  }
  return stageOut(ctx, entries, projectManagers, refused, stale, unfinished, held, direct)
}

// --args-file P (absolute): start writes its whole output to P, the same one line, and prints a short pointer instead,
// so the stage args never fill the PM's Bash output. A Workflow script has no file system and the Workflow gate reads
// args.truss from the call, so the PM still Reads P and passes that object as the Workflow's args.
// ADR-0025 item 36: start checks --args-file before cmdStart or cmdStartResume changes any state, in both forms.
// A relative P, a P that ends in a separator or is an existing directory, or a P whose nearest existing ancestor isn't a
// writable directory, is a usage error (exit 2).
function checkArgsFile(f: Flags): void {
  const p = str(f, 'args-file')
  if (p === undefined) return
  if (!path.isAbsolute(p)) throw usage(`--args-file needs an absolute path, got ${p}`)
  let dir = p.endsWith(path.sep)
  let exists = false
  try {
    dir ||= statSync(p).isDirectory()
    exists = true
  } catch {
    // P does not exist yet (or can't be stat'ed): the ancestor check below decides
  }
  if (dir) throw usage(`cannot write ${flat(p)}: --args-file names a directory, not a file`)
  // ADR-0026 item 53: an existing P this user can't write is refused here, so argsFileOut never fails after start changed state
  if (exists) {
    try {
      accessSync(p, fsConstants.W_OK)
    } catch {
      throw usage(`cannot write ${flat(p)}: --args-file names an existing file that is not writable`)
    }
  }
  let a = path.dirname(p)
  while (!existsSync(a) && path.dirname(a) !== a) a = path.dirname(a)
  let ok = false
  try {
    ok = statSync(a).isDirectory()
    if (ok) accessSync(a, fsConstants.W_OK)
  } catch {
    ok = false
  }
  if (!ok) throw usage(`cannot write ${flat(p)}: its nearest existing ancestor ${flat(a)} is not a writable directory`)
}

function argsFileOut(f: Flags, out: Obj): Obj {
  const p = str(f, 'args-file')
  if (p === undefined) return out
  if (!path.isAbsolute(p)) throw usage(`--args-file needs an absolute path, got ${p}`)
  try {
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(out) + '\n')
  } catch (e) {
    throw usage(`cannot write ${flat(p)}: ${(e as Error).message}`)
  }
  // ADR-0024 item 29, seam 3: a P inside the truss dir is one the Workflow gate can read, so the PM passes {"trussFile": P}
  // instead of the object; outside it the gate refuses that form, so no workflowArgs and a warning instead
  const real = (q: string): string => {
    try {
      return flat(realpathSync(q))
    } catch {
      return flat(path.resolve(q))
    }
  }
  const trussDir = real(path.resolve(startDirOf(f)))
  const inside = `${real(path.dirname(p))}/${path.basename(p)}`.startsWith(`${trussDir}/`)
  const short: Obj = {
    argsFile: flat(p), scriptPath: out.truss.scriptPath, crews: out.truss.crews.map((e: Obj) => e.slug), held: out.held, projectManagers: out.projectManagers, refused: out.refused, stale: out.stale, unfinished: out.unfinished,
    warnings: inside ? out.warnings : [...out.warnings, `--args-file ${flat(p)} is outside the truss dir ${trussDir}, so the Workflow gate can't read it as args.trussFile; pass the file's object as args.truss inline`],
  }
  if (out.direct !== undefined) short.direct = out.direct
  if (out.missingWorktrees !== undefined) short.missingWorktrees = out.missingWorktrees
  if (inside) short.workflowArgs = { trussFile: flat(p) }
  return short
}

// ==== resources (ADR-0015): admit, heavy, reap ====

import { spawn } from 'node:child_process'
import { admits, groupAlive, killGroup, minFreeMB, releaseHeavySlot, sample, takeHeavySlot } from '../resources/index.ts'

// How long a heavy command waits for the slot and free memory: --wait-ms N, else TRUSS_HEAVY_WAIT_MS, else 540 s (under the 600000 ms Bash timeout stage.js sets, leaving room for the command).
export const HEAVY_WAIT_MS = 540000
export function heavyWaitMs(f: Flags, env: Record<string, string | undefined> = process.env): number {
  for (const v of [str(f, 'wait-ms'), env.TRUSS_HEAVY_WAIT_MS]) {
    const n = v === undefined || v.trim() === '' ? NaN : Number(v)
    if (Number.isInteger(n) && n >= 0) return n
  }
  return HEAVY_WAIT_MS
}
const sleepSync = (ms: number): void => void Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
// True while pid runs: process.kill(pid, 0), which works on every OS. On Linux a zombie counts as gone; elsewhere a live answer
// stands (no /proc, and truss reads no system process table), which only ever keeps a group from being reaped.
export const pidAlive = (pid: unknown, platform: NodeJS.Platform = process.platform): boolean => {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
  } catch (e: any) {
    return e.code === 'EPERM'
  }
  if (platform !== 'linux') return true
  try {
    // a zombie has exited: its parent has not collected it yet
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
}

// D/resources/parallelism.json counts only as an integer from 1 to the cap; anything else means the cap.
function effectiveParallelism(dir: string, cap: number): number {
  try {
    const v = JSON.parse(readFileSync(`${dir}/resources/parallelism.json`, 'utf8'))
    if (isObj(v) && Number.isInteger(v.parallelism) && v.parallelism >= 1 && v.parallelism <= cap) return v.parallelism
  } catch {
    // missing or bad: the cap
  }
  return cap
}

type Admission = { admitted: boolean; parallelism: number; running: number; freeMB: number | null; minFreeMB: number; memPressure?: number; swapUsedPct?: number; why?: string; budget?: true; awaiting?: true; scope?: string; spentUsd?: number | null; limitUsd?: number; escalateError?: string }
const MAX_MEM_PRESSURE = 10
const MAX_SWAP_USED_PCT = 70
// contract-025 section 3: blocking inbox items first, then (only when truss.json sets a budget) the budget verdict; a hold here never waits.
// A budget hold also writes one budget-hold event and one budget escalation (ref budget:<sid>:<scope>:<slug|run>); a throwing escalate never lifts the hold.
function holdOf(dir: string, repo: string, plan: Obj, slug: string, command: string, base: Omit<Admission, 'admitted'>): Admission | undefined {
  const sid = path.basename(dir)
  const ids = blockingFor(repo, sid, slug)
  if (ids.length > 0) return { admitted: false, ...base, awaiting: true, why: `awaiting client: ${ids.join(', ')}` }
  if (!isObj(configOf(repo).budget)) return undefined
  const v = budgetVerdict(dir, repo, plan, slug)
  if (!v.held) return undefined
  // one event per hold: a repeat admit under the same crew, scope and limit writes none (a raised limit is a new hold)
  const last = eventsOf(dir).filter((e) => e.event === 'budget-hold' && e.crew === slug && e.scope === v.scope).pop()
  if (last === undefined || last.limitUsd !== v.limitUsd) appendEvent(dir, { event: 'budget-hold', crew: slug, scope: v.scope, spentUsd: v.spentUsd, limitUsd: v.limitUsd })
  let escalateError: string | undefined
  let clientNote = ''
  try {
    const esc = escalate(repo, dir, { kind: 'budget', title: `budget: ${v.why}`.slice(0, 200), detail: `${v.why}\nscope ${v.scope}, spent ${v.spentUsd === null ? 'unknown' : `${v.spentUsd} USD`}, limit ${v.limitUsd} USD; held at ${command} of crew ${slug}`, crews: [slug], ref: typeof (v as Obj).ref === 'string' && (v as Obj).ref !== '' ? String((v as Obj).ref) : `budget:${sid}:${v.scope}:${v.scope === 'run' ? 'run' : slug}`, blocking: true })
    // the one-time code exists only in this return value (the inbox keeps its hash); with no notify command nothing else delivers it, so the held entry carries it for the PM to relay
    if (!esc.deduped && esc.code !== '' && esc.notified !== true) clientNote = `; client approval needed: ${esc.id} code ${esc.code} (relay to the client, who types /truss:inbox approve ${esc.id} ${esc.code} raise <usd>)`
  } catch (e) {
    escalateError = (e instanceof Error ? e.message : String(e)).slice(0, 200)
  }
  return { admitted: false, ...base, budget: true, scope: v.scope, spentUsd: v.spentUsd, limitUsd: v.limitUsd, why: v.why + clientNote, ...(escalateError === undefined ? {} : { escalateError }) }
}

// Memory first (free MB, then memory pressure and swap use, ADR-0026 item 57), then (for a planned crew) the effective parallelism. A sampler error admits and logs a sampler-error event.
function admission(dir: string, repo: string, plan: Obj, crew: Obj, command: string, running: number): Admission {
  const slug = String(crew.slug)
  const cap = intOr(plan.maxParallelCrews, 4, 1)
  const parallelism = effectiveParallelism(dir, cap)
  const min = minFreeMB()
  const held = holdOf(dir, repo, plan, slug, command, { parallelism, running, freeMB: null, minFreeMB: min })
  if (held !== undefined) return held
  let freeMB: number | null = null
  // ADR-0026 item 57: the sampler's memory pressure (PSI some avg10, %) and swap use (%), read as optional numbers here
  // until resources/index.ts types them; an absent or non-numeric field skips its rule
  let pressure: { memPressure?: unknown; swapUsedPct?: unknown } = {}
  try {
    const s = sample()
    freeMB = s.freeMB
    pressure = s as unknown as typeof pressure
  } catch (e) {
    appendEvent(dir, { event: 'sampler-error', crew: slug, agent: slug, command, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const memPressure = num(pressure.memPressure)
  const swapUsedPct = num(pressure.swapUsedPct)
  const base = { parallelism, running, freeMB, minFreeMB: min, ...(memPressure === undefined ? {} : { memPressure }), ...(swapUsedPct === undefined ? {} : { swapUsedPct }) }
  if (freeMB !== null && !admits({ freeMB, totalMB: 0 }, min)) return { admitted: false, ...base, why: `free memory ${freeMB} MB is below ${min} MB` }
  // strict limits: exactly 10% and 70% admit; well before systemd-oomd's 50% pressure and 90% swap kill switch
  if (memPressure !== undefined && memPressure > MAX_MEM_PRESSURE) return { admitted: false, ...base, why: `memory pressure ${memPressure}% (PSI some avg10) is above ${MAX_MEM_PRESSURE}%` }
  if (swapUsedPct !== undefined && swapUsedPct > MAX_SWAP_USED_PCT) return { admitted: false, ...base, why: `swap use ${swapUsedPct}% is above ${MAX_SWAP_USED_PCT}%` }
  if (crew.status === 'planned' && running >= parallelism) return { admitted: false, ...base, why: `${running} crew(s) running already fill the parallelism ${parallelism}` }
  return { admitted: true, ...base }
}

function cmdAdmit(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const plan = loadPlan(dir)
  const crew = plan.crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  const running = (): number => plan.crews.filter((c: Obj) => isObj(c) && c.status === 'running').length
  const repo = repoOf(f)
  let a = admission(dir, repo, plan, crew, 'admit', running())
  // --wait-ms N: a hold re-checks every 2 s for up to N ms (bounded) before it refuses, so a short memory dip does not stop the crew
  const waitMs = Math.min(intOr(Number(str(f, 'wait-ms') ?? 0), 0, 0), 600000)
  const t0 = Date.now()
  // an awaiting or budget hold waits for the client, not for memory, so it ends the wait at once
  while (!a.admitted && !a.budget && !a.awaiting && Date.now() - t0 < waitMs) {
    sleepSync(Math.min(2000, Math.max(1, waitMs - (Date.now() - t0))))
    a = admission(dir, repo, plan, crew, 'admit', running())
  }
  if (!a.admitted) throw refuse({ ...a, ...(waitMs > 0 ? { waitedMs: Date.now() - t0 } : {}) })
  // ADR-0015 Decision 6: --label and --title together record the agent's card title for the UI
  const label = str(f, 'label')
  const title = str(f, 'title')
  if (label !== undefined || title !== undefined) {
    if (label === undefined || title === undefined) throw usage('--label and --title go together')
    if (parseLabel(label) === undefined) throw usage(`--label ${label} is not a workflow label`)
    const one = title.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (one === '') throw usage('--title is empty')
    // ADR-0032: --persona names the persona the spawn runs as; recordRun copies it onto the spawn event
    const persona = str(f, 'persona')
    if (persona !== undefined && !/^[A-Za-z0-9][\w.-]{0,99}$/.test(persona)) throw usage(`--persona ${persona} is not a persona name`)
    appendEvent(dir, { event: 'title', crew: slug, agent: label, label, title: one, ...(persona !== undefined ? { persona } : {}), ...(f.high === true ? { high: true } : {}) })
  }
  return a
}

const GROUPS = (dir: string): string => `${dir}/resources/groups`

function cmdReap(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  const label = need(f, 'label')
  const reaped: number[] = []
  const skipped: number[] = []
  const gdir = GROUPS(dir)
  for (const name of existsSync(gdir) ? readdirSync(gdir) : []) {
    const file = `${gdir}/${name}`
    let rec: Obj
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (!isObj(rec) || rec.slug !== slug || rec.label !== label || !Number.isInteger(rec.pgid)) continue
    if (pidAlive(rec.heavyPid)) {
      skipped.push(rec.pgid)
      continue
    }
    if (groupAlive(rec.pgid)) {
      killGroup(rec.pgid, 'SIGTERM')
      for (let i = 0; i < 20 && groupAlive(rec.pgid); i++) sleepSync(100)
      if (groupAlive(rec.pgid)) killGroup(rec.pgid, 'SIGKILL')
    }
    rmSync(file, { force: true })
    reaped.push(rec.pgid)
  }
  return { reaped, skipped }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The one async command: runs argv (after the first `--`) through the heavy slot.
export async function heavyMain(argv: string[]): Promise<{ body: Obj; code: number }> {
  try {
    const cut = argv.indexOf('--')
    const cmd = cut < 0 ? [] : argv.slice(cut + 1)
    const f = parseFlags(cut < 0 ? argv : argv.slice(0, cut))
    const dir = dirOf(f)
    const slug = need(f, 'slug')
    const label = need(f, 'label')
    const cwd = flat(need(f, 'cwd'))
    if (cmd.length === 0) throw usage('heavy needs a command after --')
    const waitLimit = heavyWaitMs(f)
    const t0 = Date.now()
    let token: string | null = null
    for (;;) {
      token = takeHeavySlot(dir, { label, slug, pid: process.pid })
      if (token !== null) {
        let low = false
        try {
          low = !admits(sample(), minFreeMB())
        } catch (e) {
          appendEvent(dir, { event: 'sampler-error', crew: slug, agent: slug, command: 'heavy', error: (e instanceof Error ? e.message : String(e)).slice(0, 200) })
        }
        if (!low) break
        releaseHeavySlot(dir, token)
        token = null
      }
      if (Date.now() - t0 >= waitLimit) {
        const waitedMs = Date.now() - t0
        return { body: { heavy: { label, ran: false, waitedMs, waitLimitMs: waitLimit, why: `waited ${waitedMs} ms (limit ${waitLimit} ms) for the heavy slot and free memory` } }, code: 1 }
      }
      await sleep(500)
    }
    const waitedMs = Date.now() - t0
    const scratch = mkdtempSync(`${tmpdir()}/factory-heavy-`)
    let pgid: number | undefined
    try {
      const outFd = openSync(`${scratch}/out.txt`, 'w')
      const errFd = openSync(`${scratch}/err.txt`, 'w')
      const exit = await new Promise<number>((resolve) => {
        // --dir and --repo are relative to this process's cwd; the child runs in the crew worktree, where a relative
        // .git/truss/... does not exist (.git is a file there), so hand it absolute paths.
        // Only when the command is factory itself; any other command's --dir is its own and passes unchanged.
        const isFactory = cmd.some((a) => /(^|\/)factory(\.ts)?$/.test(a))
        const argv2 = cmd.map((a, i) => (isFactory && i > 0 && (cmd[i - 1] === '--dir' || cmd[i - 1] === '--repo') ? path.resolve(a) : a))
        const child = spawn(argv2[0], argv2.slice(1), { cwd, detached: true, stdio: ['ignore', outFd, errFd] })
        child.on('error', () => resolve(127))
        if (child.pid !== undefined) {
          pgid = child.pid
          mkdirSync(GROUPS(dir), { recursive: true })
          writeFileSync(`${GROUPS(dir)}/${pgid}.json`, JSON.stringify({ pgid, heavyPid: process.pid, label, slug, since: Date.now() }))
        }
        child.on('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : 128)))
      })
      closeSync(outFd)
      closeSync(errFd)
      releaseHeavySlot(dir, token)
      if (pgid !== undefined && !groupAlive(pgid)) rmSync(`${GROUPS(dir)}/${pgid}.json`, { force: true })
      const stdout = readFileSync(`${scratch}/out.txt`, 'utf8')
      const meta = { label, waitedMs, exit }
      let parsed: unknown
      try {
        // a factory child run with --status-line prints its truss-status line after the JSON result; parse the result alone
        parsed = JSON.parse(stdout.replace(/\ntruss-status: [^\n]*\n?$/, '\n'))
      } catch {
        parsed = undefined
      }
      if (isObj(parsed)) return { body: { ...parsed, heavy: meta }, code: exit }
      const lines = (stdout + readFileSync(`${scratch}/err.txt`, 'utf8')).split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      return { body: { heavy: meta, tail: lines.slice(-40).join('\n') }, code: exit }
    } finally {
      releaseHeavySlot(dir, token)
      rmSync(scratch, { recursive: true, force: true })
    }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}

// ==== finish ====

import { utimesSync } from 'node:fs'
import { NO_HEAD_REASON, NO_PASS_REASON, PATCH_COMMAND, family, headVerdict, qcRuling, latestQc, markerOf, patchIdOf, planAtLeastV2, runStart } from '../hooks/register.ts'
import type { QcRuling } from '../hooks/register.ts'

// The merge step's head rule (ADR-0009 step 3), failing closed. headVerdict is fail-open for the stop gate (it passes an undefined head
// or patch, and a plan below v2), so this refuses first when the QC, head or patch is missing, whatever the plan version, and then
// asks headVerdict about a v2 view of the plan. Returns {block} to refuse, undefined when the PASS stands.
export function mergeHeadVerdict(plan: any, qc: QcRuling | undefined, head: string | undefined, patch: string | undefined): { block: string } | undefined {
  if (qc === undefined || qc.verdict !== 'PASS' || qc.unscoped > 0) return { block: NO_PASS_REASON }
  if (qc.head === undefined || qc.patch === undefined) return { block: NO_HEAD_REASON }
  if (head === undefined || patch === undefined) return { block: 'Refused: patch id unavailable: the merged head or its patch id could not be computed.' }
  return headVerdict(planAtLeastV2(plan) ? plan : { ...(isObj(plan) ? plan : {}), version: 2 }, qc, head, patch)
}

type Audit = { label: string; why: string; slug?: string }

const textOfResult = (r: unknown): string | undefined => {
  if (typeof r === 'string') return r
  if (isObj(r) && typeof r.report === 'string') return r.report
  return r === undefined ? undefined : JSON.stringify(r)
}

// Pure role audit: qc must be truss:qc-engineer and never use Write or Edit; stress must be truss:stress-engineer or truss:qc-engineer. Returns the reason, or undefined when the agent is fine.
export function roleAudit(role: string, agentType: string | undefined, toolNames: readonly string[], roles?: Obj): string | undefined {
  // ADR-0022 R4: ux is audited like qc, against the run's ux row agentType (truss:ux-engineer, or what truss.json roles.ux maps)
  if (role === 'ux') {
    const want = isObj(roles?.ux) && typeof roles.ux.agentType === 'string' ? roles.ux.agentType : 'truss:ux-engineer'
    if (agentType !== want) return `ux ran as ${agentType ?? 'an unknown type'}, not ${want}`
    if (toolNames.some((t) => t === 'Write' || t === 'Edit')) return 'a UX engineer used Write or Edit'
  }
  if (role === 'qc') {
    if (agentType !== 'truss:qc-engineer') return `qc ran as ${agentType ?? 'an unknown type'}, not truss:qc-engineer`
    if (toolNames.some((t) => t === 'Write' || t === 'Edit')) return 'a QC used Write or Edit'
  }
  if (role === 'stress' && agentType !== 'truss:stress-engineer' && agentType !== 'truss:qc-engineer') return `stress ran as ${agentType ?? 'an unknown type'}, not truss:stress-engineer or truss:qc-engineer`
  return undefined
}

// Record step: files each crew agent's result under reports/, appends spawn and report lines (once), and audits every agent of the run.
function recordRun(dir: string, wfRun: WfRun, crewSlugs: Set<string>, roles: Obj): Audit[] {
  const audits: Audit[] = []
  const events = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
  for (const a of wfRun.agents) {
    const parsed = parseLabel(a.label)
    const facts = transcriptFacts(a.transcript)
    const agentType = typeof a.meta?.agentType === 'string' ? a.meta.agentType : undefined
    const slug = parsed !== undefined && crewSlugs.has(parsed.slug) ? parsed.slug : undefined
    const bad = (why: string): void => void audits.push({ label: a.label, why, ...(slug !== undefined ? { slug } : {}) })
    if (a.meta === undefined || typeof a.meta.model !== 'string' || a.meta.model === '') bad('the meta file has no model')
    const fam = family(facts.model)
    if (fam !== 'opus' && fam !== 'sonnet') bad(`the transcript model family is ${fam}, not opus or sonnet`)
    if (facts.effort === 'max') bad('effort max')
    // ADR-0032: admit --persona and --high put the persona and the wish for effort high on the label's title event. A member
    // that stage.js meant to run at high (a persona, a task effort or a ## Members line) is not an audit finding at high.
    const titled = events.filter((e) => e.event === 'title' && e.agent === a.label)
    const personaName = ((): string | null => {
      for (let i = titled.length - 1; i >= 0; i--) if (typeof titled[i]?.persona === 'string') return titled[i]?.persona
      return null
    })()
    const personaHigh = facts.effort === 'high' && titled.some((e) => e.high === true)
    if ((facts.effort === 'high' || facts.effort === 'xhigh') && parsed !== undefined && !personaHigh) bad(`effort ${facts.effort} on role ${parsed.role}`)
    if (parsed !== undefined) {
      const why = roleAudit(parsed.role, agentType, facts.tools.map((t) => t.name), roles)
      if (why !== undefined) bad(why)
    }
    if (parsed === undefined) {
      bad('the label does not parse as <slug>-<role>')
      continue
    }
    if (slug === undefined) {
      bad(`the label names no running factory crew (slug ${parsed.slug})`)
      continue
    }
    if (!isObj(roles[parsed.role])) {
      bad(`unknown role ${parsed.role}`)
      continue
    }
    if (!a.hasResult) continue
    const text = textOfResult(a.result)
    if (text === undefined) continue
    // ADR-0020: the k-th distinct agentId under a label (journal `started` order) owns <label>.md for k=1 and <label>.run<k>.md for k>=2.
    const ids: string[] = []
    // Only an agentId that returned a result text has a report to file, so only it holds a rank (an interrupted one never competes).
    for (const o of wfRun.agents) if (o.label === a.label && o.hasResult && textOfResult(o.result) !== undefined && !ids.includes(o.agentId)) ids.push(o.agentId)
    const rank = ids.indexOf(a.agentId) + 1
    const gate = parsed.role === 'qc' || parsed.role === 'stress'
    const file = `${dir}/reports/${slug}/${a.label}${rank >= 2 && !gate ? `.run${rank}` : ''}.md`
    mkdirSync(`${dir}/reports/${slug}`, { recursive: true })
    if (rank >= 2 && gate) {
      bad(`a second agentId (${a.agentId}) under the gate label ${a.label}; the merge and stress gates read one file per label, so it is not filed`)
    } else if (existsSync(file) && readFileSync(file, 'utf8') !== text) {
      bad('a report file with different text already exists; not overwritten')
    } else {
      if (!existsSync(file)) writeFileSync(file, text)
      const when = facts.lastTs === undefined ? NaN : Date.parse(facts.lastTs)
      if (Number.isFinite(when)) utimesSync(file, when / 1000, when / 1000)
    }
    const by = `workflow:${wfRun.id}`
    if (!events.some((e) => e.event === 'spawn' && e.agentId === a.agentId && e.by === by)) {
      const dflt = roleDefaults(roles, parsed.role)
      appendEvent(dir, { event: 'spawn', crew: slug, agent: a.label, agentId: a.agentId, type: agentType ?? 'general-purpose', model: facts.model ?? dflt.model, effort: facts.effort ?? dflt.effort, persona: personaName, by })
    }
    const marker = markerOf(text)
    if (!events.some((e) => e.event === 'report' && e.crew === slug && e.agent === a.label && (e.marker ?? null) === marker)) {
      appendEvent(dir, { event: 'report', crew: slug, agent: a.label, marker })
    }
  }
  recordRestarts(dir, wfRun, crewSlugs, events)
  return audits
}

// ADR-0021 Seams cf: one `restart` event per restarted member, learned from the journal. Per crew and role (tester, builder, writer),
// in `started` order, an agent whose last result is a CHECKPOINT object or a non-object was restarted when a later agent of the same
// crew and role started after that result line; the first such agent not already linked is its successor. No result line: never a restart.
function recordRestarts(dir: string, wfRun: WfRun, crewSlugs: Set<string>, events: Obj[]): void {
  const startedAt = (id: string): number => wfRun.journal.findIndex((l) => l.type === 'started' && l.agentId === id)
  const resultAt = (id: string): number => wfRun.journal.reduce((at, l, i) => (l.type === 'result' && l.agentId === id ? i : at), -1)
  const info = wfRun.agents.map((a) => ({ a, p: parseLabel(a.label), s: startedAt(a.agentId), t: promptTask(a.transcript) }))
  const linked = new Set<string>()
  const nOf = new Map<string, number>()
  for (const x of info) {
    if (x.p === undefined || !crewSlugs.has(x.p.slug) || !['tester', 'builder', 'writer'].includes(x.p.role) || !x.a.hasResult) continue
    const r = x.a.result
    const reason = isObj(r) ? (r.marker === 'CHECKPOINT' ? 'CHECKPOINT' : undefined) : 'no report'
    if (reason === undefined) continue
    const at = resultAt(x.a.agentId)
    const next = info.find((y) => y !== x && y.p?.slug === x.p?.slug && y.p?.role === x.p?.role && (x.t === undefined || y.t === undefined || x.t === y.t) && y.s > at && !linked.has(y.a.agentId))
    if (next === undefined) continue
    linked.add(next.a.agentId)
    const n = (nOf.get(x.a.agentId) ?? 0) + 1
    nOf.set(next.a.agentId, n)
    if (!events.some((e) => e.event === 'restart' && e.crew === x.p?.slug && e.label === x.a.label)) {
      appendEvent(dir, { event: 'restart', crew: x.p.slug, agent: x.a.label, label: x.a.label, n, reason })
    }
  }
}

// Record step, escalations (ADR-0009 "finish, escalation lines"): the event lines the hooks write on the project manager path, so retro
// counts a Workflow crew's stops and spent allowances from events.jsonl the same way. One `tag` line per crew stopped with
// QUESTION, BLOCKED or PROPOSAL in this run's result (once per crew and run), and one `allowance-spent` line naming the QC
// file whose FAIL took the crew's counted QC FAILs past reworkAllowance (once per crew and QC; the count is finish's merge gate's).
function recordEscalations(dir: string, wfRun: WfRun, crews: Obj[], results: Obj[] | undefined, plan: Obj): void {
  const events = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
  const allowance = intOr(plan.reworkAllowance, 2, 0)
  const since = runStart(plan as any) ?? 0
  for (const c of crews) {
    const slug = String(c.slug)
    const res = results?.find((r) => r.slug === slug)
    const tag = res !== undefined && res.state === 'stopped' && ['QUESTION', 'BLOCKED', 'PROPOSAL'].includes(res.tag) ? String(res.tag) : undefined
    if (tag !== undefined && !events.some((e) => e.event === 'tag' && e.crew === slug && e.run === wfRun.id)) appendEvent(dir, { event: 'tag', crew: slug, agent: slug, tag, run: wfRun.id })
    const fails = countedQc(dir, slug, reportsOf(dir, slug)).filter((f) => qcFails(slug, [f], since) === 1).sort((a, b) => qcK(a.name) - qcK(b.name))
    const spender = fails[allowance]
    if (spender === undefined) continue
    const agent = spender.name.replace(/\.md$/, '')
    if (!events.some((e) => e.event === 'allowance-spent' && e.crew === slug && e.agent === agent)) appendEvent(dir, { event: 'allowance-spent', crew: slug, agent })
  }
  // ADR-0033: one knowledge line per crew and run, from the result's knowledge field (the retro's signal for optional learning)
  for (const c of crews) {
    const slug = String(c.slug)
    const k = results?.find((r) => r.slug === slug)?.knowledge
    if (!isObj(k) || !Number.isInteger(k.items) || k.items < 0 || typeof k.ran !== 'boolean') continue
    if (events.some((e) => e.event === 'knowledge' && e.crew === slug && e.run === wfRun.id)) continue
    appendEvent(dir, { event: 'knowledge', crew: slug, run: wfRun.id, items: k.items, ran: k.ran, sourceChanges: Number.isInteger(k.sourceChanges) && k.sourceChanges >= 0 ? k.sourceChanges : 0 })
  }
}

// Session audit: every Workflow run of the session at or after the run start, in scope as ADR-0009 "finish, session audit" says.
export function sessionAudit(dir: string, rootDir: string, thisRunId: string, factorySlugs: Set<string>, waived: Set<string>): Audit[] {
  const audits: Audit[] = []
  const log = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
  const starts = [...log.matchAll(/^## Run (\S+)/gm)].map((m) => Date.parse(m[1] ?? '')).filter((n) => Number.isFinite(n))
  const start = starts.length === 0 ? undefined : Math.max(...starts)
  for (const r of runsOf(rootDir)) {
    if (waived.has(r.id)) continue
    const firsts = r.agents.map((a) => Date.parse(transcriptFacts(a.transcript).firstTs ?? '')).filter((n) => Number.isFinite(n))
    if (start !== undefined && firsts.length > 0 && Math.min(...firsts) < start) continue
    const trussRun = r.agents.every((a) => {
      const p = parseLabel(a.label)
      return p !== undefined && (p.slug === 'truss' || factorySlugs.has(p.slug))
    })
    const typeOf = (a: RunAgent): string => (typeof a.meta?.agentType === 'string' ? a.meta.agentType : '')
    if (!trussRun && !r.agents.some((a) => typeOf(a).startsWith('truss:'))) continue
    for (const a of r.agents) {
      const label = `${r.id}/${a.label}`
      if (!trussRun && typeOf(a).startsWith('truss:')) audits.push({ label, why: `${typeOf(a)} agent in a run that is not truss's` })
      if (typeof a.meta?.model !== 'string' || a.meta.model === '') audits.push({ label, why: 'the meta file has no model' })
      else {
        const fam = family(transcriptFacts(a.transcript).model)
        if (fam !== 'opus' && fam !== 'sonnet') audits.push({ label, why: `the transcript model family is ${fam}, not opus or sonnet` })
      }
    }
  }
  return audits
}

// The git worktrees of the repo as {path, branch}.
function worktreesOf(repo: string): { path: string; branch: string | undefined; locked: boolean }[] {
  const out: { path: string; branch: string | undefined; locked: boolean }[] = []
  for (const block of run(repo, ['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const p = lines.find((l) => l.startsWith('worktree '))
    if (p === undefined) continue
    const b = lines.find((l) => l.startsWith('branch '))
    out.push({ path: flat(p.slice('worktree '.length)), branch: b === undefined ? undefined : b.slice('branch refs/heads/'.length), locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')) })
  }
  return out
}

// The patch id of base...head by PATCH_COMMAND, or undefined when the diff or patch-id fails or is empty.
function patchOf(wt: string, base: string, head: string): string | undefined {
  const [diffCmd, idCmd] = PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', head).split(' '))
  if (diffCmd === undefined || idCmd === undefined) return undefined
  const d = spawnSync(diffCmd[0] as string, diffCmd.slice(1), { cwd: wt, encoding: 'utf8', maxBuffer: 1 << 29 })
  if (d.error || d.status !== 0) return undefined
  const p = spawnSync(idCmd[0] as string, idCmd.slice(1), { cwd: wt, input: d.stdout, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (p.error || p.status !== 0) return undefined
  return patchIdOf(p.stdout)
}

// The lowest-numbered D/checks/<slug>-<n>.json that has no `env` key: the red record. A run that failed on the environment
// proves nothing about the code, so it is passed over. undefined when none.
function redRecord(dir: string, slug: string): Obj | undefined {
  const d = `${dir}/checks`
  if (!existsSync(d)) return undefined
  const re = new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`)
  const found = readdirSync(d).flatMap((n) => {
    const m = re.exec(n)
    return m?.[1] === undefined ? [] : [{ n: Number(m[1]), name: n }]
  }).sort((x, y) => x.n - y.n)
  for (const f of found) {
    let v
    try {
      v = JSON.parse(readFileSync(`${d}/${f.name}`, 'utf8'))
    } catch {
      return undefined
    }
    if (!isObj(v)) return undefined
    if (v.env === undefined) return v
  }
  return undefined
}

// Member worktrees of earlier runs: branch worktree-wf_<id>-<n>, path ending wf_<id>-<n>.
export const OLD_WF_BRANCH = /^worktree-wf_[\w.-]+-\d+$/
export const OLD_WF_PATH = /(^|\/)wf_[\w.-]+-\d+$/
export const OLD_WF_IDLE_MS = 3600000
function idleMs(p: string): number {
  try {
    return Date.now() - statSync(p).mtimeMs
  } catch {
    return 0
  }
}

// ADR-0030: retiring member worktrees. A branch whose commits the target lacks is kept as a ref under ARCHIVE_PREFIX/<run id>/<branch>
// before it is deleted; archive refs whose commit is older than ARCHIVE_KEEP_MS are pruned at finish.
export const ARCHIVE_PREFIX = 'refs/truss/archive'
export const ARCHIVE_KEEP_MS = 30 * 86400000
type Wt = { path: string; branch: string | undefined; locked: boolean }
type RetireWhy = 'merged' | 'superseded' | 'dropped' | 'failed'
const within = (p: string, root: string): boolean => p === root || p.startsWith(`${root}/`)
const realOr = (p: string): string => {
  try {
    return flat(realpathSync(p))
  } catch {
    return flat(p)
  }
}

// The one scratch dir a truss agent may write untracked files to in its worktree (.plan-scratch/ is the legacy name). Both are
// listed in <git common dir>/info/exclude, so no project's .gitignore changes, and never count as work: retirement deletes them.
export const SCRATCH_DIRS = ['.truss-scratch', '.plan-scratch']
// Appends each scratch dir to the repo's info/exclude once; a failure is ignored (worktreeChanges still treats them as scratch).
function excludeScratch(repo: string): void {
  try {
    const r = run(repo, ['rev-parse', '--git-common-dir'])
    if (r.status !== 0 || r.out === '') return
    const file = path.join(path.resolve(repo, r.out), 'info', 'exclude')
    const had = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const lines = had.replace(/\r/g, '').split('\n')
    const add = SCRATCH_DIRS.map((d) => `${d}/`).filter((l) => !lines.includes(l))
    if (add.length === 0) return
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${had}${had === '' || had.endsWith('\n') ? '' : '\n'}${add.join('\n')}\n`)
  } catch {
    // best effort
  }
}

// A worktree's `git status --porcelain` entries split in two: links are untracked symlinks that point into the main checkout but
// outside the worktree (the worktrees plugin links ui/node_modules that way), which are no work; real is everything else. Untracked
// entries under a scratch dir are neither.
export function worktreeChanges(wt: string, mainTop: string): { real: string[]; links: string[] } {
  const r = run(wt, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const out = { real: [] as string[], links: [] as string[] }
  if (r.status !== 0) return { real: [r.err || 'git status failed'], links: [] }
  const top = realOr(mainTop)
  const self = realOr(wt)
  for (const e of r.out.split('\0').filter((x) => x !== '')) {
    const rel = e.slice(3)
    if (e.startsWith('?? ') && SCRATCH_DIRS.some((d) => rel === `${d}/` || rel.startsWith(`${d}/`))) continue
    if (e.startsWith('?? ')) {
      const full = `${wt}/${rel.replace(/\/$/, '')}`
      try {
        if (lstatSync(full).isSymbolicLink()) {
          const to = flat(path.resolve(path.dirname(full), readlinkSync(full)))
          if (within(to, top) && !within(to, self) && !within(to, flat(wt))) {
            out.links.push(full)
            continue
          }
        }
      } catch {
        // unreadable: counted as real
      }
    }
    out.real.push(rel === '' ? e : rel)
  }
  return out
}

type RetireCtx = { dir: string; repo: string; target: string; mainTop: string }
// Retires one worktree and its branch, or says why it stays: locked or real changes. truss stops no process (ADR-0030 item 7):
// the PM's TaskStop of the finished agent or background shell stops what it left running. The main-checkout links are unlinked
// so git removes it without --force. A branch tip the target lacks is archived first. One retire event per retirement.
function retireWorktree(x: RetireCtx, w: Wt, o: { crew: string; run: string; why: RetireWhy }): string | undefined {
  if (w.branch === undefined) return 'detached'
  if (w.locked) return 'locked'
  if (existsSync(w.path)) {
    const ch = worktreeChanges(w.path, x.mainTop)
    if (ch.real.length > 0) return 'dirty'
    for (const l of ch.links) {
      try {
        unlinkSync(l)
      } catch {
        // git remove reports it
      }
    }
    // scratch dirs go first: an excluded one git removes anyway, one not yet excluded would make `worktree remove` refuse
    for (const d of SCRATCH_DIRS) {
      if (!existsSync(path.join(w.path, d)) || run(w.path, ['ls-files', '--', `${d}/`]).out !== '') continue
      try {
        rmSync(path.join(w.path, d), { recursive: true, force: true })
      } catch {
        // git remove reports it
      }
    }
    if (run(x.repo, ['worktree', 'remove', w.path]).status !== 0) return 'dirty'
  } else run(x.repo, ['worktree', 'prune'])
  return retireBranch(x, w.branch, { ...o, worktree: w.path })
}
// Archives (when the target lacks its tip) and deletes one branch; undefined on success, else why it stays.
function retireBranch(x: RetireCtx, branch: string, o: { crew: string; run: string; why: RetireWhy; worktree: string | null }): string | undefined {
  const tip = run(x.repo, ['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`]).out
  if (tip === '') return 'no branch'
  const inTarget = run(x.repo, ['merge-base', '--is-ancestor', tip, `refs/heads/${x.target}`]).status === 0
  const archive = inTarget ? null : `${ARCHIVE_PREFIX}/${o.run}/${branch}`
  if (archive !== null && run(x.repo, ['update-ref', archive, tip]).status !== 0) return 'archive failed'
  if (run(x.repo, ['branch', '-D', branch]).status !== 0) return 'branch delete failed'
  const why = o.why === 'merged' && !inTarget ? 'superseded' : o.why
  appendEvent(x.dir, { event: 'retire', crew: o.crew, agent: branch, run: o.run, branch, worktree: o.worktree, reason: why, archive })
  return undefined
}
// Drops archive refs whose commit is older than ARCHIVE_KEEP_MS.
function pruneArchive(repo: string, now = Date.now()): void {
  const r = run(repo, ['for-each-ref', '--format=%(refname) %(committerdate:unix)', `${ARCHIVE_PREFIX}/`])
  if (r.status !== 0) return
  for (const l of r.out.split('\n')) {
    const [ref, at] = l.split(' ')
    if (ref !== undefined && ref !== '' && Number(at) * 1000 < now - ARCHIVE_KEEP_MS) run(repo, ['update-ref', '-d', ref])
  }
}

// The run dir of run id under the transcripts root, else under any session of the same project (<proj>/<session>/subagents/workflows/<id>).
function runDirFor(tdir: string, id: string): string | undefined {
  const root = path.dirname(tdir)
  if (existsSync(`${root}/${id}/journal.jsonl`)) return `${root}/${id}`
  const parts = root.split('/')
  if (parts.length < 4 || parts[parts.length - 1] !== 'workflows' || parts[parts.length - 2] !== 'subagents') return undefined
  const proj = parts.slice(0, -3).join('/')
  try {
    for (const s of readdirSync(proj)) if (existsSync(`${proj}/${s}/subagents/workflows/${id}/journal.jsonl`)) return `${proj}/${s}/subagents/workflows/${id}`
  } catch {
    // no project dir
  }
  return undefined
}
// Worktree basename -> crew slug for a run's agents, from the first cwd in each agent transcript (its first 64 KiB).
function ownersOf(runDir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const a of runOf(runDir).agents) {
    const slug = parseLabel(a.label)?.slug
    if (slug === undefined || !existsSync(a.transcript)) continue
    let head = ''
    try {
      const fd = openSync(a.transcript, 'r')
      const buf = Buffer.alloc(65536)
      head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0)).toString('utf8')
      closeSync(fd)
    } catch {
      continue
    }
    const m = /"cwd":"([^"]+)"/.exec(head)
    if (m?.[1] !== undefined) out.set(path.basename(flat(m[1]).replace(/\/+$/, '')), slug)
  }
  return out
}

// ADR-0030: the finish sweep. Every wf_<run>-<n> member worktree (and branch with no worktree left) whose crew is terminal is retired:
// merged now (reason merged, or superseded when the target lacks its tip), dropped, or failed (rework allowance spent now). The crew
// is the one the run's agent transcript names for that worktree, else the run's only crew in the spawn events. Other member
// worktrees keep the 0.19.0 rule, run only when a crew merged: this run's own, or an older run's idle an hour, once merged and clean.
// A dropped crew's own worktree and branch truss-<slug> go too. Returns what stayed.
function sweepMembers(x: RetireCtx, tdir: string, runId: string, terminal: Map<string, RetireWhy>, merged: string[]): { path: string; branch: string; why: string }[] {
  const left: { path: string; branch: string; why: string }[] = []
  const events = existsSync(`${x.dir}/events.jsonl`) ? jsonLines(`${x.dir}/events.jsonl`) : []
  const crewsOfRun = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.event !== 'spawn' || typeof e.by !== 'string' || !e.by.startsWith('workflow:') || typeof e.crew !== 'string') continue
    const id = e.by.slice('workflow:'.length)
    if (!crewsOfRun.has(id)) crewsOfRun.set(id, new Set())
    crewsOfRun.get(id)?.add(e.crew)
  }
  // A run no finish recorded (one stopped and resumed by `start --resume` in a new run) still belongs to a terminal crew whose labels
  // it holds in this session's runs root: the runs `start --resume` rebuilds the crew from.
  const nextTo = terminal.size > 0 ? runsNextTo(tdir) : []
  for (const crew of terminal.keys()) {
    for (const r of crewRunsOf(nextTo, crew)) {
      if (!crewsOfRun.has(r.id)) crewsOfRun.set(r.id, new Set())
      crewsOfRun.get(r.id)?.add(crew)
    }
  }
  const owners = new Map<string, Map<string, string>>()
  const ownerOf = (id: string, base: string): string | undefined => {
    // only runs this truss dir recorded: another goal's run may use the same slug
    if (id !== runId && !crewsOfRun.has(id)) return undefined
    if (!owners.has(id)) {
      const d = runDirFor(tdir, id)
      owners.set(id, d === undefined ? new Map() : ownersOf(d))
    }
    const named = owners.get(id)?.get(base)
    if (named !== undefined) return named
    const only = crewsOfRun.get(id)
    return only !== undefined && only.size === 1 ? [...only][0] : undefined
  }
  const idRe = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const branchRe = new RegExp(`^worktree-${idRe}-\\d+$`)
  const pathRe = new RegExp(`(^|/)${idRe}-\\d+$`)
  const memberRun = (branch: string): string | undefined => /^worktree-(.+)-\d+$/.exec(branch)?.[1]
  const checkedOut = new Set<string>()
  for (const w of worktreesOf(x.repo)) {
    if (w.branch === undefined) continue
    checkedOut.add(w.branch)
    const ours = branchRe.test(w.branch) && pathRe.test(w.path)
    const old = OLD_WF_BRANCH.test(w.branch) && OLD_WF_PATH.test(w.path)
    if (!ours && !old) continue
    const id = ours ? runId : (memberRun(w.branch) as string)
    if (!ours && path.basename(w.path) !== w.branch.slice('worktree-'.length)) continue
    const crew = ownerOf(id, path.basename(w.path))
    const why = crew === undefined ? undefined : terminal.get(crew)
    if (why !== undefined && crew !== undefined) {
      // an older run's member of a crew that is terminal now: that run is over for this crew, so no idle wait
      const kept = retireWorktree(x, w, { crew, run: id, why })
      if (kept !== undefined) left.push({ path: w.path, branch: w.branch, why: kept })
      continue
    }
    if (merged.length === 0 || (!ours && idleMs(w.path) < OLD_WF_IDLE_MS)) continue
    const isMerged = [...merged.map((s) => `truss-${s}`), x.target].some((b) => run(x.repo, ['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/${b}`]).status === 0)
    if (w.locked) left.push({ path: w.path, branch: w.branch, why: 'locked' })
    else if (!isMerged) left.push({ path: w.path, branch: w.branch, why: 'unmerged' })
    else {
      const kept = retireWorktree(x, w, { crew: crew ?? merged[0] as string, run: id, why: 'merged' })
      if (kept !== undefined) left.push({ path: w.path, branch: w.branch, why: kept })
    }
  }
  // member branches whose worktree is already gone
  const heads = run(x.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
  for (const b of heads.status === 0 ? heads.out.split('\n') : []) {
    if (b === '' || checkedOut.has(b) || !OLD_WF_BRANCH.test(b)) continue
    const id = memberRun(b) as string
    const crew = ownerOf(id, b.slice('worktree-'.length))
    const why = crew === undefined ? undefined : terminal.get(crew)
    if (why !== undefined && crew !== undefined) retireBranch(x, b, { crew, run: id, why, worktree: null })
  }
  // a dropped crew's own worktree and branch
  for (const [crew, why] of terminal) {
    if (why !== 'dropped') continue
    const b = `truss-${crew}`
    const w = worktreesOf(x.repo).find((v) => v.branch === b)
    const kept = w !== undefined ? retireWorktree(x, w, { crew, run: runId, why }) : checkedOut.has(b) ? undefined : run(x.repo, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).status === 0 ? retireBranch(x, b, { crew, run: runId, why, worktree: null }) : undefined
    if (kept !== undefined && w !== undefined) left.push({ path: w.path, branch: b, why: kept })
  }
  pruneArchive(x.repo)
  return left
}

type Outcome ={ merged?: true; left?: { path: string; branch: string; why: string }[]; rework?: string; blocked?: string; refused?: string }

// Merge step for one crew whose newest QC is a clean PASS (ADR-0009 steps 1 to 5). Fails closed: any doubt is a refusal.
// `gates` (ADR-0031 land) switches the red and QC gates by the crew's booleans; absent, both are on (finish, a full crew).
// `runId` names the run in the retire event of the crew's own branch (land has none: 'land').
function mergeCrew(f: Flags, dir: string, repo: string, target: string, crew: Obj, ruling: QcRuling | undefined, audits: Audit[], fails: number, gates?: { process: string; qc: boolean; red: boolean }, runId = 'land'): Outcome {
  const needRed = gates?.red ?? true
  const needQc = gates?.qc ?? true
  const slug: string = crew.slug
  const wt = crewWorktree(repo, slug)
  const plan = loadPlan(dir)
  // step 1: gates
  const named = audits.filter((a) => a.slug === slug)
  if (named.length > 0) return { refused: `audit: ${named.map((a) => `${a.label} (${a.why})`).join('; ')}` }
  if (!existsSync(wt)) return { refused: `no crew worktree at ${wt}` }
  try {
    cmdOwnsCheck({ ...f, dir, repo, slug })
  } catch (e) {
    return { refused: e instanceof CliError && Array.isArray(e.body.outside) ? `owns-check: outside ${(e.body.outside as string[]).join(', ')}` : `owns-check failed: ${(e as Error).message}` }
  }
  // the gate reads refs/heads/<target> throughout and fails closed: a remote-tracking name such as origin/main is refused up front, with the fix
  if (run(repo, ['rev-parse', '--verify', '-q', `refs/heads/${target}^{commit}`]).status !== 0) return { refused: `target ${target} is not a local branch (refs/heads/${target} does not resolve); set \`target\` in .claude/truss.json to a local branch (\`git branch --list\` names them), or make one from it with \`git branch <local-name> ${target}\` and set \`target\` to <local-name>` }
  // contract-025 section 3 (finding #22): every crew, solo and qc:false included, passes the long-term cost gate; its QC text is the newest QC file, if any
  const since = runStart(plan) ?? 0
  const qcFiles = reportsOf(dir, slug).map((r) => (/^qc(-\d+)?\.md$/.test(r.name) ? { ...r, name: `${slug}-${r.name}` } : r))
  // a base or head that does not resolve would hand the gate '' and no triggers: refuse instead
  const ltcBase = gateGit(wt, ['merge-base', `refs/heads/${target}`, `refs/heads/truss-${slug}`])
  if (ltcBase.status !== 0 || ltcBase.out === '') return { refused: `long-term cost gate: git merge-base refs/heads/${target} refs/heads/truss-${slug} failed${ltcBase.err === '' ? '' : `: ${ltcBase.err.split('\n')[0]}`}` }
  const ltcHead = gateGit(wt, ['rev-parse', '--verify', `refs/heads/truss-${slug}`])
  if (ltcHead.status !== 0 || ltcHead.out === '') return { refused: `long-term cost gate: git rev-parse refs/heads/truss-${slug} failed${ltcHead.err === '' ? '' : `: ${ltcHead.err.split('\n')[0]}`}` }
  // ADR-0035: from the commits alone, before anything else can open a client item or touch a branch
  const cfgRefusal = knowledgeConfigRefusal(wt, ltcBase.out, ltcHead.out)
  if (cfgRefusal !== undefined) return { refused: cfgRefusal }
  const gate = ltcCrewGate(repo, dir, slug, { qcText: latestQc(slug, qcFiles, since)?.text ?? null, base: ltcBase.out, head: ltcHead.out })
  if (gate.refused !== undefined) return { refused: gate.refused }
  const allowance = intOr(plan.reworkAllowance, 2, 0)
  if (fails > allowance) return { refused: `rework allowance spent: ${fails} QC FAILs, allowance ${allowance}` }
  const red = needRed ? redRecord(dir, slug) : undefined
  if (needRed && (red === undefined || !Number.isInteger(red.exit) || red.exit === 0)) return { refused: 'no red record: the lowest-numbered checks file is missing or has exit 0' }
  if (run(wt, ['rev-parse', `refs/heads/truss-${slug}`]).out !== run(wt, ['rev-parse', 'HEAD']).out) return { refused: `the crew worktree is not on branch truss-${slug}` }
  // step 2: resolve the target once, fully qualified (a same-named tag must not win), and merge that commit in, never a rebase
  const targetRef = `refs/heads/${target}`
  const resolved = run(repo, ['rev-parse', '--verify', `${targetRef}^{commit}`])
  if (resolved.status !== 0 || resolved.out === '') return { refused: `target branch ${target} does not resolve` }
  const oldSha = resolved.out
  const m = run(wt, ['merge', '--no-edit', oldSha])
  if (m.status !== 0) {
    const conflict = run(wt, ['diff', '--name-only', '--diff-filter=U']).out !== ''
    run(wt, ['merge', '--abort'])
    return conflict ? { rework: 'conflict' } : { refused: `git merge ${target} failed: ${m.err || m.out}` }
  }
  // step 3: the patch is always computed on the merged head, against the target head just merged in
  const head = run(wt, ['rev-parse', 'HEAD']).out
  const base = run(wt, ['merge-base', oldSha, 'HEAD']).out
  // ADR-0035: what lands must not loosen the target, whatever each side looked like alone
  const landing = knowledgeConfigRefusal(wt, oldSha, head)
  if (landing !== undefined) return { refused: landing }
  const patch = !needQc || head === '' || base === '' ? undefined : patchOf(wt, base, head)
  if (needQc && (ruling === undefined || ruling.head === undefined || ruling.patch === undefined || head === '' || patch === undefined)) return { refused: 'patch id unavailable' }
  if (needQc && mergeHeadVerdict(plan, ruling, head, patch) !== undefined) return { rework: 'reqc' }
  if (needRed || (needQc && head !== ruling?.head)) {
    try {
      cmdCheck({ dir, slug, cwd: wt, expect: 'green' })
    } catch {
      return { rework: 'reqc' }
    }
  }
  // step 4: fast-forward the target
  const onTarget = worktreesOf(repo).find((w) => w.branch === target)
  if (onTarget !== undefined) {
    const dirty = run(onTarget.path, ['status', '--porcelain', '--untracked-files=no']).out
    if (dirty !== '') return { blocked: `target checked out dirty: ${dirty.split('\n')[0]?.trim().replace(/^\S+\s+/, '')}` }
    if (run(onTarget.path, ['rev-parse', 'HEAD']).out !== oldSha) return { rework: 'target moved' }
    if (run(onTarget.path, ['merge', '--ff-only', head]).status !== 0) return { rework: 'target moved' }
  } else if (run(repo, ['update-ref', targetRef, head, oldSha]).status !== 0) return { rework: 'target moved' }
  // step 5: record, then clean up
  const fresh = patchPlan(dir, (fresh) => {
    const entry = fresh.crews.find((c: Obj) => isObj(c) && c.slug === slug)
    if (entry !== undefined) entry.status = 'merged'
  })
  if (gates !== undefined) appendDecision(dir, `crew ${slug} merged into ${target} at ${head} | land: process ${gates.process}, qc ${gates.qc}, red ${gates.red}${red !== undefined ? `, red record exit ${red.exit}` : ''}${needQc && ruling !== undefined ? `, QC PASS on ${ruling.head}` : ''}`)
  else appendDecision(dir, `crew ${slug} merged into ${target} at ${head} | QC PASS on ${ruling?.head}, red record exit ${red?.exit}, patch ${patch}, acceptance test green on the merged head`)
  // contract-025 section 4: the merge is final by now, so a ledger failure is a decision line, never a refusal
  try {
    const cost = crewCost(dir, repo, slug)
    ledgerAppend(repo, { v: 1, ts: new Date().toISOString(), kind: 'merge', session: path.basename(dir), crew: slug, goal: goalOf(crew), workType: typeof crew.workType === 'string' ? crew.workType : null, process: gates?.process ?? crew.process ?? 'full', qc: needQc, red: needRed, target, base, head, costUsd: cost.usd, ...(cost.usd === null && cost.why !== undefined ? { costWhy: cost.why } : {}) })
  } catch (e) {
    appendDecision(dir, `ledger row for crew ${slug} not written | ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`)
  }
  const own = new Set(fresh.crews.filter(isObj).map((c: Obj) => `truss-${c.slug}`))
  for (const w of worktreesOf(repo)) {
    if (w.path === wt || w.branch === undefined || own.has(w.branch) || !w.branch.startsWith(`truss-${slug}-`)) continue
    if (run(repo, ['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/truss-${slug}`]).status === 0) run(repo, ['worktree', 'remove', w.path])
  }
  // the crew's own worktree and branch truss-<slug> are retired now: the target holds the branch, so nothing is archived
  const x: RetireCtx = { dir, repo, target, mainTop: worktreesOf(repo)[0]?.path ?? repo }
  const crewWt = worktreesOf(repo).find((w) => w.branch === `truss-${slug}`)
  const kept = crewWt !== undefined ? retireWorktree(x, crewWt, { crew: slug, run: runId, why: 'merged' }) : retireBranch(x, `truss-${slug}`, { crew: slug, run: runId, why: 'merged', worktree: null })
  // ADR-0021 Decision 7 and ADR-0030: the run's member worktrees are retired by sweepMembers once every crew has had its turn
  return kept !== undefined && crewWt !== undefined ? { merged: true, left: [{ path: crewWt.path, branch: `truss-${slug}`, why: kept }] } : { merged: true }
}

// ADR-0026 item 56: when the repo finish merged into is the plugin's own repo, one warning per plugin agents/*.md the merges
// changed (target head before..after): this session keeps the agent definition it loaded until a restart, silently.
// Each names the item-24 fallback. Read-only git; any git failure gives no warning.
function agentFileWarnings(repo: string, before: string, target: string): string[] {
  const top = (cwd: string): string | undefined => {
    const r = run(cwd, ['rev-parse', '--show-toplevel'])
    if (r.status !== 0 || r.out === '') return undefined
    try {
      return flat(realpathSync(r.out))
    } catch {
      return flat(r.out)
    }
  }
  let pluginTop: string | undefined
  let repoTop: string | undefined
  try {
    pluginTop = top(PLUGIN)
    repoTop = top(repo)
  } catch {
    return []
  }
  if (pluginTop === undefined || pluginTop !== repoTop) return []
  const rel = path.posix.relative(pluginTop, flat(realpathSync(PLUGIN)))
  const agents = rel === '' ? 'agents' : `${rel}/agents`
  const workflows = rel === '' ? 'workflows' : `${rel}/workflows`
  const d = run(repo, ['diff', '--name-only', before, `refs/heads/${target}`, '--', `${agents}/`, `${workflows}/stage.js`, `${workflows}/plan.js`])
  if (d.status !== 0) return []
  const out: string[] = []
  for (const p of d.out.split('\n')) {
    for (const name of ['stage.js', 'plan.js']) {
      if (p === `${workflows}/${name}`) out.push(`the merge changed workflows/${name}; the Workflow gate still matches the ${name} this session loaded, so the repo path is refused until a restart; restart the session, or run a scratchpad copy of the loaded plugin's ${name} for crews already under way (ADR-0024 item 24)`)
    }
    if (!p.startsWith(`${agents}/`) || !/^[^/]+\.md$/.test(p.slice(agents.length + 1))) continue
    const file = `agents/${p.slice(agents.length + 1)}`
    const type = `truss:${file.slice('agents/'.length, -'.md'.length)}`
    out.push(`the merge changed ${file}; this session keeps the ${type} definition it loaded until a restart, so restart the session, or spawn the role as general-purpose with ${file} inlined in its prompt (ADR-0024 item 24)`)
  }
  return out
}

// ADR-0031 item 6: the merge gate for a direct (solo or lean) crew. mergeCrew's steps, the red and QC gates switched by the crew's booleans.
function cmdLand(f: Flags): Obj {
  const repo = repoOf(f)
  const slug = need(f, 'slug')
  const settings = settingsOf(repo)
  if (settings.merge === 'single') throw usage('single merge mode runs on the project manager path')
  const dir = dirOf(f)
  const plan = loadPlan(dir)
  const crew = plan.crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (crew === undefined) throw usage(`no crew ${slug} in the plan`)
  const no = (why: string): CliError => refuse({ merged: false, slug, why })
  if (crew.status !== 'running') throw no(`${slug} is not running (status ${String(crew.status)})`)
  const process = crew.process
  if (process !== 'solo' && process !== 'lean') throw no(`${slug} has process ${process === undefined ? 'absent' : String(process)}, not solo or lean; a full crew merges through finish`)
  const qc = process === 'lean' && crew.qc === true
  const red = process === 'lean' && crew.red === true
  let ruling: QcRuling | undefined
  let fails = 0
  if (qc) {
    const since = runStart(plan) ?? 0
    // the PM saves the hand-back as <slug>-qc[-k].md (finish's name) or, under reports/<slug>/, as qc[-k].md
    const files = reportsOf(dir, slug).map((r) => (/^qc(-\d+)?\.md$/.test(r.name) ? { ...r, name: `${slug}-${r.name}` } : r))
    const newest = latestQc(slug, files, since)
    ruling = newest === undefined ? undefined : qcRuling(newest.text)
    if (ruling === undefined || ruling.verdict !== 'PASS') throw no('qc: the newest QC file is not a PASS')
    if (ruling.unscoped > 0) throw no('qc: the QC PASS has an UNSCOPED finding')
    fails = qcFails(slug, countedQc(dir, slug, files), since)
  }
  const r = mergeCrew(f, dir, repo, settings.target, crew, ruling, [], fails, { process, qc, red })
  if (r.merged) return { merged: true, slug, process, qc, red, head: run(repo, ['rev-parse', '--verify', `refs/heads/${settings.target}`]).out, ...(r.left !== undefined && r.left.length > 0 ? { leftWorktrees: r.left } : {}) }
  throw no(r.rework ?? r.blocked ?? r.refused ?? 'refused')
}

function cmdFinish(f: Flags): Obj {
  const repo = repoOf(f)
  need(f, 'transcript')
  const settings = settingsOf(repo)
  if (settings.merge === 'single') throw usage('single merge mode runs on the project manager path')
  const dir = dirOf(f)
  const tdir = flat(need(f, 'transcript')).replace(/\/+$/, '')
  const resultPath = str(f, 'result')
  let results: Obj[] | undefined
  if (resultPath !== undefined) {
    const v = readJson(flat(resultPath))
    if (!Array.isArray(v)) throw usage('--result must hold the JSON array stage.js returned')
    results = v.filter(isObj)
  }
  const plan = loadPlan(dir)
  // ADR-0022 R4: the run's roles table, truss.json roles laid on, so the ux audit names the mapped ux agentType
  const roles = rolesWithTypes(PLUGIN, [], configOf(repo).roles)
  const wfRun = runOf(tdir)
  const factoryCrews: Obj[] = plan.crews.filter((c: Obj) => isObj(c) && typeof c.slug === 'string' && c.status === 'running' && factorySpawned(dir, c.slug) !== undefined)
  const factorySlugs = new Set(factoryCrews.map((c) => c.slug as string))
  const inRun = factoryCrews.filter((c) => wfRun.agents.some((a) => parseLabel(a.label)?.slug === c.slug))
  const out = { merged: [] as string[], rework: [] as Obj[], blocked: [] as Obj[], refused: [] as Obj[], audit: [] as Obj[], incomplete: [] as string[], stopped: [] as Obj[], leftWorktrees: [] as Obj[], warnings: [] as string[] }
  const finishWith = (): Obj => {
    const body = {
      merged: out.merged, rework: out.rework, blocked: out.blocked, refused: out.refused, audit: out.audit, incomplete: out.incomplete, stopped: out.stopped,
      ...(out.leftWorktrees.length > 0 ? { leftWorktrees: out.leftWorktrees } : {}), ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}),
    }
    if (out.refused.length > 0 || out.rework.length > 0 || out.blocked.length > 0 || out.audit.length > 0) throw refuse(body)
    return body
  }

  // every running crew whose result is not `passed`, or that the run holds with no result at all, is listed so the PM
  // can't miss it; why is the stop text's first line (the full text is in the result file). It never changes the exit code.
  for (const c of results === undefined ? [] : factoryCrews) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined && !inRun.includes(c)) continue
    if (res !== undefined) setCrewState(dir, String(c.slug), res.state === 'passed' ? 'finished' : 'stopped')
    if (res === undefined) out.stopped.push({ slug: c.slug, tag: null, at: null, why: 'no result for this crew in --result' })
    else if (res.state !== 'passed') {
      const first = String(res.text ?? '').replace(/\r/g, '').split('\n').find((l) => l.trim() !== '')?.trim()
      const why = first === undefined ? `state ${String(res.state)}` : first.length > 300 ? `${first.slice(0, 299)}…` : first
      out.stopped.push({ slug: c.slug, tag: typeof res.tag === 'string' ? res.tag : null, at: typeof res.at === 'string' ? res.at : null, why })
    }
  }

  if (results === undefined) {
    // no result: the liveness rule first, writing nothing while it fails
    const now = Date.now()
    for (const c of inRun) if (isLive(factorySpawned(dir, c.slug)?.ts ?? now, tdir, now)) out.refused.push({ slug: c.slug, why: 'run may be live' })
    if (out.refused.length > 0) return finishWith()
  }

  // ADR-0012 Decision 10: the extract is kept with the truss dir; a failed write is one decision line and changes nothing else
  try {
    const parts = tdir.split('/')
    const session = parts.length >= 3 && parts[parts.length - 2] === 'workflows' && parts[parts.length - 3] === 'subagents' ? parts.slice(0, -3).join('/') : tdir
    const { cat, ex } = retro()
    ex.writeExtract(dir, ex.extractSession(session, cat.loadCatalog(`${PLUGIN}/retro/catalog.json`)))
  } catch (e) {
    const what = `retro extract failed: ${(e as Error).message}`
    const had = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
    if (!had.includes(what)) appendDecision(dir, what)
  }

  const audits = recordRun(dir, wfRun, factorySlugs, roles)
  for (const a of audits) out.audit.push({ label: a.label, why: a.why })
  recordEscalations(dir, wfRun, inRun, results, plan)

  if (results === undefined) {
    const have = existsSync(`${dir}/events.jsonl`) ? jsonLines(`${dir}/events.jsonl`) : []
    for (const c of inRun) {
      if (!have.some((e) => e.event === 'incomplete' && e.crew === c.slug && e.run === wfRun.id)) appendEvent(dir, { event: 'incomplete', crew: c.slug, agent: c.slug, run: wfRun.id })
      out.incomplete.push(c.slug)
    }
    return finishWith()
  }

  // session audit: while an entry stands, nothing merges
  const log = existsSync(`${dir}/decisions.md`) ? readFileSync(`${dir}/decisions.md`, 'utf8') : ''
  const waived = new Set([...log.matchAll(/^- [^|]*\|\s*audit waived: ([A-Za-z0-9._-]+)/gm)].map((m) => m[1] as string))
  const stand = sessionAudit(dir, path.dirname(tdir), wfRun.id, new Set(plan.crews.filter((c: Obj) => isObj(c) && factorySpawned(dir, c.slug) !== undefined).map((c: Obj) => c.slug as string)), waived)
  for (const a of stand) if (!out.audit.some((x) => x.label === a.label && x.why === a.why)) out.audit.push({ label: a.label, why: a.why })
  if (stand.length > 0) {
    const what = `session audit stands, nothing merged: ${stand.map((a) => `${a.label} (${a.why})`).join('; ')}`
    if (!log.includes(what)) appendDecision(dir, `${what} | the client rules, then a decision line "audit waived: <run id>" or the offending run goes`)
    for (const c of inRun) out.refused.push({ slug: c.slug, why: 'session audit' })
    return finishWith()
  }

  const since = runStart(plan) ?? 0
  const targetBefore = run(repo, ['rev-parse', '-q', '--verify', `refs/heads/${settings.target}`])
  for (const c of inRun) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined || res.state !== 'passed') continue
    const files = reportsOf(dir, c.slug)
    const newest = latestQc(c.slug, files, since)
    const ruling = newest === undefined ? undefined : qcRuling(newest.text)
    if (ruling === undefined || ruling.verdict !== 'PASS' || ruling.unscoped > 0) continue
    const r = mergeCrew(f, dir, repo, settings.target, c, ruling, audits, qcFails(c.slug, countedQc(dir, c.slug, files), since), undefined, wfRun.id)
    if (r.merged) {
      out.merged.push(c.slug)
      out.leftWorktrees.push(...(r.left ?? []))
    }
    else if (r.rework !== undefined) out.rework.push({ slug: c.slug, why: r.rework })
    else if (r.blocked !== undefined) out.blocked.push({ slug: c.slug, why: r.blocked })
    else out.refused.push({ slug: c.slug, why: r.refused ?? 'refused' })
  }
  if (out.merged.length > 0 && targetBefore.status === 0) out.warnings.push(...agentFileWarnings(repo, targetBefore.out, settings.target))
  // ADR-0030: retire the member worktrees and branches of every crew that is terminal now
  const terminal = new Map<string, RetireWhy>()
  for (const c of loadPlan(dir).crews) if (isObj(c) && typeof c.slug === 'string' && c.status === 'dropped') terminal.set(c.slug, 'dropped')
  for (const r of out.refused) if (typeof r.slug === 'string' && String(r.why).startsWith('rework allowance spent')) terminal.set(r.slug, 'failed')
  for (const s of out.merged) terminal.set(s, 'merged')
  const mainTop = worktreesOf(repo)[0]?.path ?? repo
  out.leftWorktrees.push(...sweepMembers({ dir, repo, target: settings.target, mainTop }, tdir, wfRun.id, terminal, out.merged))
  // each merged crew's sweep reports what it left; a later crew's sweep may have removed it, and the same one is listed per pass.
  // Report each still-present worktree once.
  const present = new Set(worktreesOf(repo).map((w) => w.path))
  const seen = new Set<string>()
  out.leftWorktrees = out.leftWorktrees.filter((l) => {
    if (!present.has(l.path) || seen.has(l.path)) return false
    seen.add(l.path)
    return true
  })
  return finishWith()
}

// ==== decide ====

// ADR-0027 F-73: the PM's one route to D/decisions.md. Three forms, exactly one per call:
//   --line '<decision> | <reason> | <checker> | <outcome>'          -> `- HH:MM | <decision> | <reason> | <checker> | <outcome>`
//   --checker <n> --recommend <answer|defer|pass> --text T --outcome O -> `- HH:MM | checker-<n> RECOMMEND <answer>: T | O`
//   --run '<goal>'                                                   -> `## Run <UTC start> | <goal>`
// The clock stamps every line. Each refusal exits 2 and writes nothing; no form writes a continuation line.
const RECOMMENDS = ['answer', 'defer', 'pass']
// True when `dir` is a direct child of <git common dir>/truss; the compare is on real, normalised paths (case-insensitive on win32).
export function isSessionDirUnderCommon(repo: string, dir: string, platform: string = process.platform): boolean {
  let common: string
  try {
    common = commonDir(repo)
  } catch {
    return false
  }
  const norm = (p: string): string => (platform === 'win32' ? flat(p).toLowerCase() : flat(p))
  const target = path.resolve(dir)
  if (!/^[A-Za-z0-9._-]+$/.test(path.basename(target))) return false
  const parent = path.dirname(target)
  // <common>/truss may not exist yet: resolve the nearest existing ancestor with realpath and re-append the missing tail, so a repo
  // reached through a symlink (macOS /var -> /private/var) compares equal to the real common dir
  const real = (p: string): string => {
    let head = p
    const tail: string[] = []
    while (!existsSync(head) && path.dirname(head) !== head) (tail.unshift(path.basename(head)), (head = path.dirname(head)))
    return path.join(existsSync(head) ? realpathSync(head) : head, ...tail)
  }
  return norm(real(parent)) === norm(path.join(real(common), 'truss'))
}
export function cmdDecide(f: Flags, platform: string = process.platform): Obj {
  const dir = dirOf(f)
  const forms = (['line', 'checker', 'run'] as const).filter((k) => f[k] !== undefined)
  if (forms.length !== 1) throw usage('decide takes exactly one of --line, --checker (with --recommend, --text, --outcome) or --run')
  const form = forms[0]
  const keys = form === 'checker' ? ['checker', 'recommend', 'text', 'outcome'] : [form]
  const vals: Record<string, string> = {}
  for (const k of keys) {
    const v = str(f, k)
    if (v === undefined) throw usage(`decide --checker needs --${k}`)
    if (/[\r\n]/.test(v)) throw usage(`--${k} holds a newline; a decision is one line`)
    vals[k] = v
  }
  // --run is the first command of a run: its session dir may not exist yet, so it makes one, but only directly under <common>/truss
  // and only once the goal text is valid, so a refusal leaves nothing behind
  if (form === 'run' && vals.run.trim() !== '' && !existsSync(dir) && isSessionDirUnderCommon(repoOf(f), dir, platform)) mkdirSync(dir, { recursive: true })
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`--dir is not a directory: ${dir}`)
  let line: string
  if (form === 'line') {
    const fields = vals.line.split('|').map((s) => s.trim())
    if (fields.length !== 4) throw usage(`--line needs four fields split by |, decision | reason | checker | outcome; got ${fields.length}`)
    line = `- ${localTime(Date.now())} | ${fields.join(' | ')}`
  } else if (form === 'checker') {
    if (!/^[1-9]\d*$/.test(vals.checker)) throw usage(`--checker must be a positive integer, got ${vals.checker}`)
    if (!RECOMMENDS.includes(vals.recommend)) throw usage(`--recommend must be one of ${RECOMMENDS.join(', ')}, got ${vals.recommend}`)
    if (vals.text.trim() === '') throw usage('--text is empty')
    if (vals.outcome.trim() === '') throw usage('--outcome is empty')
    line = `- ${localTime(Date.now())} | checker-${vals.checker} RECOMMEND ${vals.recommend}: ${vals.text.trim()} | ${vals.outcome.trim()}`
  } else {
    const goal = vals.run.trim()
    if (goal === '') throw usage('--run needs a goal')
    line = `## Run ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} | ${goal}`
  }
  appendDecisionLine(dir, line)
  return { ok: true, form, line }
}

// ==== crew decisions ====

// A crew's product calls reach the main session as they happen, and the crew never waits. State is one small file per decision
// under <dir>/crew-decisions/: <id>.json (the call), <id>.reply.json (the main session's reply), <id>.consumed (the crew applied the
// reply and said so with decision-ack). Each file is made once with the exclusive flag, so the id counter, the reply hand-over and
// two crews acking at the same time need no lock: a second claimant gets EEXIST and skips. Reading replies marks nothing: a reply
// that a runner garbled on its way back is read again.
const CREW_DECISIONS = (dir: string): string => `${dir}/crew-decisions`
// Per-crew state under <dir>/crews/<slug>/: checkpoint.json (the crew passed its reply checkpoint), knowledge-commit.json
// ({shas}: the crew's knowledge commits), learned.jsonl (one learned item per line) and state.json ({state}: finished or stopped,
// written when the crew's result is read, cleared when the crew starts again).
const CREW_STATE = (dir: string, slug: string): string => `${dir}/crews/${slug}`
// stopped is not here: a stopped crew can be resumed and still applies replies at its checkpoint.
const CLOSED_CREW = ['finished', 'merged', 'dropped']
function readQuiet(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''))
  } catch {
    return undefined
  }
}
function knowledgeShas(dir: string, slug: string): string[] {
  const v = readQuiet(`${CREW_STATE(dir, slug)}/knowledge-commit.json`)
  return isObj(v) && Array.isArray(v.shas) ? v.shas.filter((s: unknown): s is string => typeof s === 'string') : []
}
// The learned items stored for a crew, oldest first; a line that is not a JSON object is skipped.
function learnedOf(dir: string, slug: string): Obj[] {
  const p = `${CREW_STATE(dir, slug)}/learned.jsonl`
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim() !== '').flatMap((l) => {
    try {
      const v = JSON.parse(l)
      return isObj(v) ? [v] : []
    } catch {
      return []
    }
  })
}
// The repo paths the crew's learned items name as targets, only markdown ones (an item can't send the knowledge step to code).
function learnedTargets(dir: string, slug: string): Set<string> {
  const out = new Set<string>()
  for (const item of learnedOf(dir, slug)) {
    const t = repoPathOf(item.target)
    if (t !== undefined && t.toLowerCase().endsWith('.md')) out.add(t)
  }
  return out
}
function setCrewState(dir: string, slug: string, state: 'finished' | 'stopped' | null): void {
  const p = `${CREW_STATE(dir, slug)}/state.json`
  try {
    if (state === null) rmSync(p, { force: true })
    else {
      mkdirSync(CREW_STATE(dir, slug), { recursive: true })
      writeFileSync(p, JSON.stringify({ state }) + '\n')
    }
  } catch {
    // a failed write only means decisions still reads the plan's status for this crew
  }
}
// The crew's status for decisions: the plan's status (planned, running, merged, dropped), finished or stopped once its result was
// read, unknown when the plan or the crew is missing.
function crewStatusOf(dir: string, plan: Obj | undefined, slug: string): string {
  const entry = plan === undefined ? undefined : plan.crews.find((x: unknown) => isObj(x) && x.slug === slug)
  const planned = isObj(entry) && typeof entry.status === 'string' ? entry.status : 'unknown'
  if (planned === 'merged' || planned === 'dropped') return planned
  const st = readQuiet(`${CREW_STATE(dir, slug)}/state.json`)
  return isObj(st) && (st.state === 'finished' || st.state === 'stopped') ? st.state : planned
}
const planQuiet = (dir: string): Obj | undefined => {
  const v = readQuiet(`${dir}/plan.json`)
  return isObj(v) && Array.isArray(v.crews) ? v : undefined
}
// The crew has applied (or can no longer apply) the main session's replies: it recorded its checkpoint, or it is closed.
const pastCheckpoint = (dir: string, slug: string, status: string): boolean => existsSync(`${CREW_STATE(dir, slug)}/checkpoint.json`) || CLOSED_CREW.includes(status)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim()
type CrewDecision = { id: string; ts: string; crew: string; task: string; question: string; answer: string; by: string }
type DecisionReply = { id: string; crew: string; reply: 'ack' | 'change'; note: string | null }

function readDecision(dir: string, id: string): CrewDecision {
  const p = `${CREW_DECISIONS(dir)}/${id}.json`
  if (!/^d-[a-z0-9-]+-\d+$/.test(id) || !existsSync(p)) throw usage(`no crew decision ${id} in this run`)
  return readJson(p) as CrewDecision
}
function readReply(dir: string, id: string): DecisionReply | undefined {
  const p = `${CREW_DECISIONS(dir)}/${id}.reply.json`
  return existsSync(p) ? (readJson(p) as DecisionReply) : undefined
}

// factory crew-decision --crew <slug> --task <id> --question <q> --answer <a> --by <who>: the project manager (or a member) records a
// product call it made and went on. Appends the decide line, writes a crew-decision event, prints {id}.
function cmdCrewDecision(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  if (!SLUG.test(crew)) throw usage(`--crew ${crew} is not a crew slug`)
  const v: Record<string, string> = {}
  for (const k of ['task', 'question', 'answer', 'by']) {
    v[k] = oneLine(need(f, k))
    if (v[k] === '') throw usage(`--${k} is empty`)
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw usage(`--dir is not a directory: ${dir}`)
  const cdir = CREW_DECISIONS(dir)
  mkdirSync(cdir, { recursive: true })
  const taken = readdirSync(cdir).filter((n) => new RegExp(`^d-${crew}-\\d+\\.json$`).test(n)).length
  for (let n = taken + 1; n < taken + 10000; n++) {
    const id = `d-${crew}-${n}`
    const rec: CrewDecision = { id, ts: new Date().toISOString(), crew, task: v.task as string, question: v.question as string, answer: v.answer as string, by: v.by as string }
    try {
      writeFileSync(`${cdir}/${id}.json`, JSON.stringify(rec) + '\n', { flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    appendDecisionLine(dir, `- ${localTime(Date.now())} | PO crew ${crew}: ${rec.question} | ${rec.answer} | ${rec.by} | decided`)
    appendEvent(dir, { event: 'crew-decision', id, crew, task: rec.task, question: rec.question, answer: rec.answer, by: rec.by })
    return { id }
  }
  throw usage(`no free decision id for crew ${crew}`)
}

// factory decision-reply <id> ack|change [--note <text>]: the main session answers a crew's call. change needs a note.
function cmdDecisionReply(f: Flags): Obj {
  const dir = dirOf(f)
  const id = need(f, 'id')
  const verdict = need(f, 'reply')
  if (verdict !== 'ack' && verdict !== 'change') throw usage(`the reply must be ack or change, got ${verdict}`)
  const rawNote = str(f, 'note')
  const note = rawNote === undefined ? null : oneLine(rawNote)
  if (verdict === 'change' && (note === null || note === '')) throw usage('a change reply needs --note: say what the crew should do instead')
  const d = readDecision(dir, id)
  const cdir = CREW_DECISIONS(dir)
  const rec: DecisionReply = { id, crew: d.crew, reply: verdict, note: note === '' ? null : note }
  // the exclusive create makes a second reply (even one at the same moment) a refusal, never an overwrite
  try {
    writeFileSync(`${cdir}/${id}.reply.json`, JSON.stringify(rec) + '\n', { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw usage(`crew decision ${id} already has a reply`)
    throw e
  }
  appendEvent(dir, { event: 'decision-reply', id, crew: d.crew, reply: verdict, note: rec.note })
  const status = crewStatusOf(dir, planQuiet(dir), d.crew)
  if (!pastCheckpoint(dir, d.crew, status)) return { id, reply: verdict }
  return {
    id, reply: verdict, crewPastCheckpoint: true,
    hint: `crew ${d.crew} is past its reply checkpoint (status ${status}) and will not apply this reply; the crew result lists the call as late, so a change becomes a fix at merge`,
  }
}

// factory decision-replies --crew <slug>: the replies to a crew's calls that it has not acked yet, as [{id, reply, note}]. It marks
// nothing: the crew acks with decision-ack once it has applied them, so a reply lost on the way back is read again.
function cmdDecisionReplies(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  const cdir = CREW_DECISIONS(dir)
  const out: { id: string; reply: string; note: string | null }[] = []
  const names = existsSync(cdir) ? readdirSync(cdir).filter((n) => n.endsWith('.reply.json')).sort(byDecisionId) : []
  for (const n of names) {
    const r = readJson(`${cdir}/${n}`) as DecisionReply
    if (r.crew !== crew || existsSync(`${cdir}/${r.id}.consumed`)) continue
    out.push({ id: r.id, reply: r.reply, note: r.note })
  }
  return out as unknown as Obj
}

// factory decision-ack --crew <slug> --ids <id,id,...>: the crew applied these replies. Each is marked consumed with an exclusive
// create, so two acks of one reply never both count: prints {acked, already}. Every id must be a reply to a call of this crew, or
// nothing is acked.
function cmdDecisionAck(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  const ids = [...new Set(need(f, 'ids').split(',').map((s) => s.trim()).filter((s) => s !== ''))]
  if (ids.length === 0) throw usage('--ids needs at least one decision id')
  const cdir = CREW_DECISIONS(dir)
  for (const id of ids) {
    const d = readDecision(dir, id)
    if (d.crew !== crew) throw usage(`crew decision ${id} belongs to crew ${d.crew}, not ${crew}`)
    if (readReply(dir, id) === undefined) throw usage(`crew decision ${id} has no reply to ack`)
  }
  const acked: string[] = []
  const already: string[] = []
  for (const id of ids) {
    try {
      writeFileSync(`${cdir}/${id}.consumed`, '', { flag: 'wx' })
      acked.push(id)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      already.push(id)
    }
  }
  if (acked.length > 0) appendEvent(dir, { event: 'decision-ack', crew, ids: acked })
  return { acked, already }
}

// factory decision-checkpoint --crew <slug>: the crew passed its reply checkpoint (it applied the replies it had, or made no call).
// A reply that comes later is not applied by the crew; decision-reply and decisions --open say so. Safe to call again.
function cmdDecisionCheckpoint(f: Flags): Obj {
  const dir = dirOf(f)
  const crew = need(f, 'crew')
  if (!SLUG.test(crew)) throw usage(`--crew ${crew} is not a crew slug`)
  mkdirSync(CREW_STATE(dir, crew), { recursive: true })
  writeFileSync(`${CREW_STATE(dir, crew)}/checkpoint.json`, JSON.stringify({ ts: new Date().toISOString() }) + '\n')
  return { crew, checkpoint: true }
}

// factory knowledge-commit --slug <slug> --sha <sha>: records the commit that holds the crew's knowledge step, the one commit
// owns-check lets change docs outside the crew's owns. Prints {slug, sha} with the full sha. With --base and --head (shas) the sha
// must be a non-merge commit in base..head (git rev-list --no-merges), else it is a usage error and nothing is recorded; the output
// then also carries files (git diff --name-only base head). There is no docs-only answer: markdown can be test input, so green
// always re-runs after the knowledge commit.
function cmdKnowledgeCommit(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  if (!SLUG.test(slug)) throw usage(`--slug ${slug} is not a crew slug`)
  const given = need(f, 'sha')
  if (!/^[0-9a-f]{7,64}$/.test(given)) throw usage(`--sha ${given} is not a commit sha`)
  const r = run(repoOf(f), ['rev-parse', '--verify', '-q', `${given}^{commit}`])
  if (r.status !== 0 || r.out === '') throw usage(`--sha ${given} is not a commit of this repo`)
  const sha = r.out
  const base = str(f, 'base')
  const head = str(f, 'head')
  const ranged = base !== undefined && head !== undefined
  if (ranged) {
    for (const [name, v] of [['base', base], ['head', head]]) if (!/^[0-9a-f]{7,64}$/.test(v)) throw usage(`--${name} ${v} is not a commit sha`)
    const l = run(repoOf(f), ['rev-list', '--no-merges', `${base}..${head}`])
    if (l.status !== 0) throw usage(`git rev-list ${base}..${head} failed: ${l.err || l.out}`)
    if (!l.out.split('\n').map((x) => x.trim()).includes(sha)) throw usage(`--sha ${sha} is not a non-merge commit in ${base}..${head}`)
  }
  const shas = knowledgeShas(dir, slug)
  if (!shas.includes(sha)) {
    mkdirSync(CREW_STATE(dir, slug), { recursive: true })
    writeFileSync(`${CREW_STATE(dir, slug)}/knowledge-commit.json`, JSON.stringify({ shas: [...shas, sha] }) + '\n')
    appendEvent(dir, { event: 'knowledge-commit', crew: slug, sha })
  }
  if (!ranged) return { slug, sha }
  const d = run(repoOf(f), ['-c', 'core.quotepath=off', 'diff', '--name-only', base as string, head as string])
  if (d.status !== 0) throw usage(`git diff ${base} ${head} failed: ${d.err || d.out}`)
  const files = d.out.split('\n').map((l) => l.trim()).filter(Boolean)
  return { slug, sha, files }
}

// factory crew-learned --slug <slug> --add=<json array>: appends the learned items of one member report to the crew's list. The list
// survives a restart of the crew's run: start --resume hands it back as learned, and the knowledge step reads it. Prints
// {slug, added, total}.
function cmdCrewLearned(f: Flags): Obj {
  const dir = dirOf(f)
  const slug = need(f, 'slug')
  if (!SLUG.test(slug)) throw usage(`--slug ${slug} is not a crew slug`)
  let items: unknown
  try {
    items = JSON.parse(need(f, 'add'))
  } catch {
    throw usage('--add is not JSON')
  }
  if (!Array.isArray(items) || items.length === 0) throw usage('--add must be a JSON array of at least one learned item')
  for (const i of items) {
    if (!isObj(i) || typeof i.kind !== 'string' || i.kind.trim() === '' || typeof i.text !== 'string' || i.text.trim() === '') throw usage('every learned item needs a kind and a text')
  }
  mkdirSync(CREW_STATE(dir, slug), { recursive: true })
  appendFileSync(`${CREW_STATE(dir, slug)}/learned.jsonl`, items.map((i) => JSON.stringify(i) + '\n').join(''))
  return { slug, added: items.length, total: learnedOf(dir, slug).length }
}
// d-<crew>-<n> in the order they were made: by crew, then n as a number.
function byDecisionId(a: string, b: string): number {
  const split = (s: string): [string, number] => {
    const m = /^d-(.*)-(\d+)\./.exec(s)
    return [m?.[1] ?? s, Number(m?.[2] ?? 0)]
  }
  const [ca, na] = split(a)
  const [cb, nb] = split(b)
  return ca < cb ? -1 : ca > cb ? 1 : na - nb
}

// factory decisions [--open] [--crew <slug>]: the run's crew decisions in the order they were made, each with its reply status and
// its crew's status (crewStatus); --open keeps the ones with no reply yet whose crew can still apply one, so a crew past its
// checkpoint or a finished crew goes quiet. One read of a small directory, cheap to poll.
function cmdDecisions(f: Flags): Obj {
  const dir = dirOf(f)
  const cdir = CREW_DECISIONS(dir)
  const only = str(f, 'crew')
  const files = existsSync(cdir) ? readdirSync(cdir).filter((n) => /^d-.*-\d+\.json$/.test(n)) : []
  const plan = planQuiet(dir)
  const status = new Map<string, string>()
  const statusOf = (crew: string): string => status.get(crew) ?? (status.set(crew, crewStatusOf(dir, plan, crew)), status.get(crew) as string)
  const list = files.map((n) => {
    const d = readJson(`${cdir}/${n}`) as CrewDecision
    const r = readReply(dir, d.id)
    return { ...d, reply: r?.reply ?? null, note: r?.note ?? null, consumed: existsSync(`${cdir}/${d.id}.consumed`), crewStatus: statusOf(d.crew) }
  }).filter((d) => (only === undefined || d.crew === only) && (f.open !== true || (d.reply === null && !pastCheckpoint(dir, d.crew, d.crewStatus))))
  list.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : byDecisionId(`${a.id}.`, `${b.id}.`)))
  // review 3: with --crew, whether the crew already passed its reply checkpoint, so a resume applies no reply it was told is late
  if (only !== undefined) return { decisions: list, checkpoint: SLUG.test(only) && existsSync(`${CREW_STATE(dir, only)}/checkpoint.json`) }
  return { decisions: list }
}

// ==== knowledge (ADR-0035) ====

// `knowledge-lint [--base=<sha>] [--repo R] [--slug S [--dir D]]`: exit 0 whether or not it found failures; the caller reads `ok`.
// With --slug it lints the crew worktree (its working tree, HEAD as the head); with no --base the base is `git merge-base <target>
// HEAD` there, and when that does not resolve, the head of the crew's red record in --dir (the crew's head when its red check ran,
// so a later base than the fork point: the output then carries `baseFallback: true`); with neither, a failing result. Without
// --slug it lints the repo's own checkout, against --base when given. With a base the config is the base commit's; a head that
// loosens it or a side git cannot read is a failure. The output carries `base` whenever the lint ran against one.
function cmdKnowledgeLint(f: Flags): Obj {
  const repo = repoOf(f)
  let at = repo
  let base = str(f, 'base')
  let fallback = false
  if (f.base === true || base === '') throw usage('--base needs a value')
  // the full sha a ref names in the linted checkout, or undefined
  const commitOf = (ref: string): string | undefined => {
    if (ref.startsWith('-')) return undefined
    const r = run(at, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    return r.status === 0 && r.out !== '' ? r.out : undefined
  }
  if (f.slug !== undefined) {
    const slug = str(f, 'slug')
    if (slug === undefined || !SLUG.test(slug)) throw usage(`--slug ${String(f.slug)} is not a crew slug`)
    at = crewWorktree(repo, slug)
    if (!existsSync(at)) throw usage(`no crew worktree for ${slug} at ${at}`)
    if (base === undefined) {
      let target = ''
      let targetErr: string | undefined
      try {
        target = settingsOf(repo).target
      } catch (e) {
        if (!(e instanceof CliError)) throw e
        targetErr = e.message
      }
      const mb = target === '' || target.startsWith('-') ? undefined : run(at, ['merge-base', target, 'HEAD'])
      if (mb !== undefined && mb.status === 0 && mb.out !== '') base = mb.out
      else {
        const first = targetErr !== undefined ? `the target could not be read: ${targetErr}` : mb === undefined ? `no usable target (${target === '' ? 'none set' : JSON.stringify(target)})` : `git merge-base ${target} HEAD failed in ${at}${mb.err === '' ? '' : `: ${mb.err.split('\n')[0]}`}`
        const red = f.dir === undefined ? undefined : redRecord(dirOf(f), slug)
        const head = typeof red?.head === 'string' ? red.head : ''
        const second = f.dir === undefined ? 'no --dir, so no red record was read' : red === undefined ? `no red record for ${slug} in ${dirOf(f)}/checks` : head === '' ? `the red record for ${slug} names no head` : commitOf(head) !== undefined ? '' : `the red record head ${head} is not a commit of ${at}`
        // a crew whose base cannot be found is not "lint did not run": it is a failure QC sees
        if (second !== '') return { ok: false, failures: [{ check: 'config-unverified', path: '.claude/truss.json', message: `could not verify the crew's knowledge config: no base for crew ${slug}: ${first}, and ${second}; pass --base`, new: true }], warnings: [], predatingCount: 0, warningCount: 0 }
        base = head
        fallback = true
      }
    }
  }
  if (base !== undefined) {
    const sha = commitOf(base)
    if (sha === undefined) throw usage(`--base ${base} is not a commit of ${at}`)
    base = sha
  }
  if (base === undefined) return knowledgeLint(at, knowledgeCfgOf(repo), undefined)
  // A crew must not loosen the lint that judges it: with a base, the crew is linted against the base commit's config and never
  // against a working tree's. A head config that loosens it, or a side that cannot be read, is a failure, not a lint that did not run.
  const guard = knowledgeConfigGuard(at, base, 'HEAD')
  const res = knowledgeLint(at, guard.baseCfg ?? guard.headCfg ?? knowledgeCfgFrom({}), base)
  const finding = guard.unverified !== undefined
    ? { check: 'config-unverified', message: `could not verify the crew's knowledge config: ${guard.unverified}` }
    : guard.loosened.length > 0
      ? { check: 'config-loosened', message: `the crew loosened its own knowledge lint: ${guard.loosened.join('; ')}. Revert it; the lint runs against the base config` }
      : undefined
  const out: LintResult = finding === undefined ? res : { ...res, ok: false, failures: [...res.failures, { ...finding, path: '.claude/truss.json', new: true }] }
  return { ...out, base, ...(fallback ? { baseFallback: true } : {}) }
}
// Every read the gate makes ignores refs/replace, which a crew's worktree can write and which would show the gate a tree other than the one landing.
const gateGit = (at: string, args: string[]): ReturnType<typeof run> => run(at, ['--no-replace-objects', ...args])
// ADR-0035: .claude/truss.json as a commit holds it, never as a working tree does.
// A forged tree refuses: a symlink, a blob of another mode, a `.claude` that is not a tree, or a path equal to it only when case-folded
// (a case-insensitive checkout would read that one instead). Never echoes a path the tree holds: it is the crew's text.
function committedTrussJson(at: string, rev: string): { raw?: Obj; absent?: boolean; error?: string } {
  const bad = (why: string): { error: string } => ({ error: `.claude/truss.json at ${rev}: ${why}` })
  const fold = (s: string): string => s.toUpperCase().toLowerCase()
  const entries = (treeish: string): { error: string } | { name: string; mode: string; type: string; sha: string }[] => {
    const ls = gateGit(at, ['ls-tree', '-z', '--full-tree', treeish])
    if (ls.status !== 0) return { error: `could not read .claude/truss.json at ${rev}: ${ls.err.split('\n')[0]}` }
    return ls.out.split('\0').filter(Boolean).map((row) => {
      const tab = row.indexOf('\t')
      const [mode = '', type = '', sha = ''] = row.slice(0, tab).split(' ')
      return { name: row.slice(tab + 1), mode, type, sha }
    })
  }
  const top = entries(rev)
  if (!Array.isArray(top)) return top
  let file: { mode: string; sha: string } | undefined
  for (const d of top.filter((e) => fold(e.name) === '.claude')) {
    if (d.type !== 'tree') return bad(d.name === '.claude' ? '.claude is a symlink or a file, not a directory' : 'a path differs from it only by case')
    const kids = entries(d.sha)
    if (!Array.isArray(kids)) return kids
    const hits = kids.filter((e) => fold(e.name) === 'truss.json')
    if (hits.some((e) => d.name !== '.claude' || e.name !== 'truss.json')) return bad('a path differs from it only by case')
    if (d.name === '.claude') file = hits[0]
  }
  if (file === undefined) return { absent: true }
  if (file.mode !== '100644') return bad(`it must be a regular file (mode 100644), found mode ${file.mode}`)
  const show = gateGit(at, ['cat-file', 'blob', file.sha])
  if (show.status !== 0) return { error: `could not read .claude/truss.json at ${rev}: ${show.err.split('\n')[0]}` }
  try {
    const v = JSON.parse(show.out)
    return isObj(v) ? { raw: v } : { error: `.claude/truss.json at ${rev} is not an object` }
  } catch {
    return { error: `.claude/truss.json at ${rev} is not valid JSON` }
  }
}
// The comparison behind both the lint and the merge gate: commits only. `unverified` says a side could not be read (fail closed);
// `loosened` lists what the head loosens, by key and numeric budget only, because a path value is the crew's own text.
function knowledgeConfigGuard(at: string, base: string, head: string): { baseCfg?: KCfg; headCfg?: KCfg; loosened: string[]; unverified?: string } {
  const b = committedTrussJson(at, base)
  const h = committedTrussJson(at, head)
  const baseCfg = b.error === undefined ? knowledgeCfgFrom(b.raw ?? {}) : undefined
  const headCfg = h.error === undefined ? knowledgeCfgFrom(h.raw ?? {}) : undefined
  if (baseCfg === undefined || headCfg === undefined) return { baseCfg, headCfg, loosened: [], unverified: [b.error, h.error].filter((e) => e !== undefined).join('; ') }
  const loosened: string[] = []
  const pathKeys = ['featureMap', 'productDecisions', 'knowledgeDir', 'rulesDir', 'agentsIndex'] as const
  if (h.absent === true && b.raw !== undefined) {
    const set = ['knowledgeBudgets', ...pathKeys].filter((k) => Object.hasOwn(b.raw as Obj, k))
    if (set.length > 0) loosened.push(`.claude/truss.json deleted while the base set ${set.join(', ')}`)
  }
  for (const k of Object.keys(baseCfg.budgets) as (keyof KCfg['budgets'])[]) {
    if (headCfg.budgets[k] > baseCfg.budgets[k]) loosened.push(`knowledgeBudgets.${k} raised from ${baseCfg.budgets[k]} to ${headCfg.budgets[k]}`)
  }
  for (const k of pathKeys) {
    if (headCfg[k] !== baseCfg[k]) loosened.push(`${k} changed`)
  }
  return { baseCfg, headCfg, loosened }
}
const refusalOf = (g: ReturnType<typeof knowledgeConfigGuard>): string | undefined => {
  if (g.unverified !== undefined) return `knowledge config gate: could not verify .claude/truss.json, so the merge is refused: ${g.unverified}`
  if (g.loosened.length > 0) return `knowledge config gate: a crew cannot make this change to its own knowledge lint: ${g.loosened.join('; ')}. If it is right (a real relocation of the knowledge dir, say), the client makes it on main, outside a crew`
  return undefined
}
// Why this head may not merge, or undefined. Used by every merge path, so each gets the same answer.
function knowledgeConfigRefusal(at: string, base: string, head: string): string | undefined {
  return refusalOf(knowledgeConfigGuard(at, base, head))
}
// Why `result` (a commit or tree) may not replace the destination's old tip. With `target` (the destination is an integration branch),
// a result that brings no more than the target itself holds passes: the branch only picked up what the target did.
function landingRefusal(at: string, old: string, result: string, target?: string): string | undefined {
  const g = knowledgeConfigGuard(at, old, result)
  if (g.unverified === undefined && g.loosened.length > 0 && target !== undefined) {
    const t = knowledgeConfigGuard(at, target, result)
    if (t.unverified === undefined && t.loosened.length === 0) return undefined
  }
  return refusalOf(g)
}
type MergeSides = { head: string; old: string; base: string; target?: string }
// Resolves the three commits a merge of `branch` into `into` is judged on and refuses on the branch's own change. Its base is the fork from the
// target, also for an integration branch: `into` may be older than a target the branch already holds, and that change is not the branch's own.
function mergeSides(repo: string, branch: string, into: string): { sides?: MergeSides; why?: string } {
  if (branch.startsWith('-') || into === '' || into.startsWith('-')) return { why: 'knowledge config gate: the branch or target name is not usable' }
  const tip = (b: string): string | undefined => {
    const r = gateGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`])
    return r.status === 0 && r.out !== '' ? r.out : undefined
  }
  const head = tip(branch)
  if (head === undefined) return { why: `knowledge config gate: branch ${branch} does not resolve` }
  const old = tip(into)
  if (old === undefined) return { why: `knowledge config gate: branch ${into} does not resolve` }
  const targetName = settingsOf(repo).target
  const targetTip = tip(targetName)
  if (targetTip === undefined) return { why: `knowledge config gate: branch ${targetName} does not resolve` }
  const base = gateGit(repo, ['merge-base', targetTip, head])
  if (base.status !== 0 || base.out === '') return { why: `knowledge config gate: git merge-base ${targetName} ${branch} failed${base.err === '' ? '' : `: ${base.err.split('\n')[0]}`}` }
  const why = knowledgeConfigRefusal(repo, base.out, head)
  if (why !== undefined) return { why }
  return { sides: { head, old, base: base.out, ...(into === targetName ? {} : { target: targetTip }) } }
}
// `knowledge-config-gate --branch B [--into T]`: the check alone, where the merge happens elsewhere (the integration branch before its PR).
// Exit 0 when B may merge into T (default: the target), 1 when not. The result is a merge-tree of the two tips; git before 2.38 has none, so B's head stands in, which can only refuse more.
function cmdKnowledgeConfigGate(f: Flags): Obj {
  const repo = repoOf(f)
  const branch = need(f, 'branch')
  const into = str(f, 'into') ?? settingsOf(repo).target
  const { sides, why } = mergeSides(repo, branch, into)
  if (sides === undefined) throw refuse({ ok: false, branch, into, why })
  const mt = gateGit(repo, ['merge-tree', '--write-tree', sides.old, sides.head])
  const tree = mt.status === 0 || mt.status === 1 ? mt.out.split('\n')[0]?.trim() : undefined
  const landing = landingRefusal(repo, sides.old, tree === undefined || tree === '' ? sides.head : tree, sides.target)
  if (landing !== undefined) throw refuse({ ok: false, branch, into, why: landing })
  return { ok: true, branch, into, base: sides.base, head: sides.head }
}
// `gated-merge --branch B [--into T] [--ff-only] [--continue]`: the gate and the merge in one process, for the merges neither land nor finish performs.
// A conflict is left for the caller to resolve and `git add`; --continue then judges the resolved index. A refused result is aborted, so nothing lands.
function cmdGatedMerge(f: Flags): Obj {
  const repo = repoOf(f)
  const branch = need(f, 'branch')
  const into = str(f, 'into') ?? settingsOf(repo).target
  for (const k of ['ff-only', 'continue']) if (f[k] !== undefined && f[k] !== true) throw usage(`--${k} takes no value`)
  const ffOnly = f['ff-only'] === true
  const resume = f.continue === true
  if (ffOnly && resume) throw usage('--ff-only and --continue do not go together')
  const no = (why: string, more: Obj = {}): CliError => refuse({ ok: false, merged: false, branch, into, why, ...more })
  const { sides, why } = mergeSides(repo, branch, into)
  if (sides === undefined) throw no(why ?? 'knowledge config gate: refused')
  const { head, old, target } = sides
  const holder = worktreesOf(repo).find((w) => w.branch === into)
  if (ffOnly) {
    if (gateGit(repo, ['merge-base', '--is-ancestor', old, head]).status !== 0) throw no(`not a fast-forward: ${branch} does not contain the tip of ${into}; merge ${into} into it first`)
    const landing = landingRefusal(repo, old, head, target)
    if (landing !== undefined) throw no(landing)
    if (holder !== undefined) {
      const m = run(holder.path, ['merge', '--ff-only', head])
      if (m.status !== 0) throw no(`git merge --ff-only failed: ${(m.err || m.out).split('\n')[0]}`)
    } else if (run(repo, ['update-ref', `refs/heads/${into}`, head, old]).status !== 0) throw no(`${into} moved during the merge; run this again`)
    return { ok: true, merged: true, branch, into, old, head, mode: 'ff-only' }
  }
  if (holder === undefined) throw no(`no worktree has ${into} checked out`)
  const at = holder.path
  const inProgress = (): string => run(at, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).out
  if (resume) {
    if (inProgress() !== head) throw no(`no merge of ${branch} is in progress in ${into}'s worktree`)
  } else {
    if (inProgress() !== '') throw no(`a merge is already in progress in ${into}'s worktree`)
    // By name, so the message is git's own "Merge branch 'x'"; MERGE_HEAD is then held to the head the gate read.
    const m = run(at, ['merge', '--no-ff', '--no-commit', '--no-edit', branch])
    if (m.status !== 0) {
      const files = run(at, ['-c', 'core.quotepath=off', 'diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
      if (files.length > 0) throw no('merge conflict: resolve it, git add the files, then run this command again with --continue', { conflict: true, files })
      run(at, ['merge', '--abort'])
      throw no(`git merge failed: ${(m.err || m.out).split('\n')[0]}`)
    }
    if (inProgress() === '') return { ok: true, merged: true, upToDate: true, branch, into, old, head: old, mode: 'no-ff' }
    if (inProgress() !== head) {
      run(at, ['merge', '--abort'])
      throw no(`${branch} moved during the merge; run this again`)
    }
  }
  const gate = (): void => {
    const tree = gateGit(at, ['write-tree'])
    if (tree.status !== 0 || tree.out === '') throw no(`unresolved paths remain in ${into}'s worktree: ${tree.err.split('\n')[0]}`)
    const landing = landingRefusal(at, old, tree.out, target)
    if (landing === undefined) return
    run(at, ['merge', '--abort'])
    throw no(landing)
  }
  // Refused text for one hook, run by git so core.hooksPath and git's own sh apply. Git before 2.36 has no `git hook`: only a hook that exists then stops the merge.
  const hookRefusal = (name: string, args: string[] = []): string | undefined => {
    const h = run(at, ['hook', 'run', '--ignore-missing', name, ...(args.length > 0 ? ['--', ...args] : [])])
    if (h.status === 0) return undefined
    if (/is not a git command/.test(h.err)) return existsSync(run(at, ['rev-parse', '--path-format=absolute', '--git-path', `hooks/${name}`]).out) ? `the ${name} hook cannot be run: git hook needs git 2.36 or later` : undefined
    const said = h.err || h.out
    return `the ${name} hook refused the merge commit${said === '' ? ', printing nothing' : `: ${said}`}`
  }
  // Git keeps the conflict resolution only while MERGE_HEAD stands, so a refusal on --continue leaves the merge for the retry; a clean merge has nothing to keep.
  const stopped = (why: string): CliError => {
    if (resume) return no(`${why}. The resolved index and MERGE_HEAD are kept: fix that, git add any change, then run this command again with --continue to retry`)
    run(at, ['merge', '--abort'])
    return no(why)
  }
  gate() // first, so a loosening is cleared whatever a hook would say
  // The hooks raw git runs: `git merge` runs pre-merge-commit, `git merge --continue` is `git commit` and runs pre-commit, both then commit-msg.
  // Run here because `git commit` would pick pre-commit for both, and `merge --no-commit` runs neither; hence --no-verify below.
  const msgFile = run(at, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_MSG']).out
  const hookWhy = hookRefusal(resume ? 'pre-commit' : 'pre-merge-commit') ?? hookRefusal('commit-msg', [msgFile])
  if (hookWhy !== undefined) throw stopped(hookWhy)
  gate() // again, since a hook can change the index, and this is the tree that lands
  const c = run(at, ['commit', '--no-edit', '--no-verify', '--cleanup=strip'])
  if (c.status !== 0) throw stopped(`git commit failed: ${c.err || c.out || `exit ${c.status} with no output, as from a prepare-commit-msg hook`}`)
  return { ok: true, merged: true, branch, into, old, head: run(at, ['rev-parse', 'HEAD']).out, mode: 'no-ff' }
}
// The target's tip just before `head` reached it and the tip that first held it, from the target's reflog (a commit graph cannot tell them apart after a
// fast-forward). A raw merge leaves this behind; an expired or disabled reflog does not, and that fails closed.
function preMergeOf(repo: string, target: string, head: string): { old?: string; landed?: string; why?: string } {
  const log = gateGit(repo, ['log', '-g', '--format=%H', `refs/heads/${target}`])
  if (log.status !== 0) return { why: `could not read the reflog of ${target}: ${log.err.split('\n')[0]}` }
  let landed: string | undefined
  for (const sha of log.out.split('\n').filter(Boolean)) {
    if (gateGit(repo, ['merge-base', '--is-ancestor', head, sha]).status === 0) landed = sha
    else return landed === undefined ? { why: `the reflog of ${target} is inconsistent` } : { old: sha, landed }
  }
  return { why: `the reflog of ${target} does not reach back to before the merge` }
}
// `knowledge-migrate [--apply]`: moves the product calls out of the personas into productDecisions; never commits.
function cmdKnowledgeMigrate(f: Flags): Obj {
  const repo = repoOf(f)
  if (typeof f.apply === 'string' && f.apply !== 'true') throw usage('--apply takes no value')
  return knowledgeMigrate(repo, knowledgeCfgOf(repo), f.apply === true || f.apply === 'true')
}
// `rules-index`: every rule file and its `paths` globs.
function cmdRulesIndex(f: Flags): Obj {
  const repo = repoOf(f)
  return knowledgeRulesIndex(repo, knowledgeCfgOf(repo))
}

// ==== main ====

const CORE_COMMANDS: Record<string, (f: Flags) => Obj> = {
  'crew-decision': cmdCrewDecision, 'decision-reply': cmdDecisionReply, 'decision-replies': cmdDecisionReplies, 'decision-ack': cmdDecisionAck, 'decision-checkpoint': cmdDecisionCheckpoint,
  'knowledge-lint': cmdKnowledgeLint, 'knowledge-config-gate': cmdKnowledgeConfigGate, 'gated-merge': cmdGatedMerge, 'knowledge-migrate': cmdKnowledgeMigrate, 'rules-index': cmdRulesIndex,
  'knowledge-commit': cmdKnowledgeCommit, 'crew-learned': cmdCrewLearned, decisions: cmdDecisions,
  settings: cmdSettings, 'plan-args': cmdPlanArgs, 'plan-write': cmdPlanWrite, 'plan-check': cmdPlanCheck, approve: cmdApprove, start: (f) => (checkArgsFile(f), argsFileOut(f, cmdStart(f))),
  sync: cmdSync, check: cmdCheck, integrate: cmdIntegrate, 'mark-merged': cmdMarkMerged, 'owns-check': cmdOwnsCheck, 'owns-extend': cmdOwnsExtend, 'tests-check': cmdTestsCheck, finish: cmdFinish, land: cmdLand, doctor: cmdDoctor,
  admit: cmdAdmit, reap: cmdReap, decide: cmdDecide, 'persona-install': cmdPersonaInstall,
  heavy: () => {
    throw usage('heavy is async: run it from the command line')
  },
}
// A plugin module's command key never replaces a core command or another module's: main refuses and names the keys.
const PLUGIN_COMMANDS: Record<string, (f: Flags) => Obj>[] = [INBOX_COMMANDS, COST_COMMANDS, QUEUE_COMMANDS, WORKTYPE_COMMANDS]
const SHADOWED: string[] = []
const COMMANDS: Record<string, (f: Flags) => Obj> = { ...CORE_COMMANDS }
for (const group of PLUGIN_COMMANDS) {
  for (const [k, fn] of Object.entries(group)) {
    if (Object.hasOwn(COMMANDS, k)) SHADOWED.push(k)
    else COMMANDS[k] = fn
  }
}

// `decision-reply <id> ack|change [--note T]` takes two words before or among its flags: each word that is not a flag or a flag's
// value becomes the next of `names` as a flag.
function positionalsToFlags(argv: string[], names: string[]): string[] {
  const out: string[] = []
  let n = 0
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      out.push(a)
      const next = argv[i + 1]
      if (!a.includes('=') && next !== undefined && !next.startsWith('--')) out.push(argv[++i] as string)
    } else if (n < names.length) {
      out.push(`--${names[n++]}`, a)
    } else {
      out.push(a)
    }
  }
  return out
}

// Runs one command and returns what it printed and its exit code.
export function main(argv: string[]): { body: Obj; code: number } {
  try {
    const [command, ...rest] = argv
    if (SHADOWED.length > 0) throw refuse({ error: `a plugin command key shadows a core command: ${SHADOWED.join(', ')}` })
    const fn = command === undefined ? undefined : COMMANDS[command]
    if (fn === undefined) throw usage(`unknown command: ${command ?? '(none)'}; commands: ${Object.keys(COMMANDS).join(', ')}`)
    const argv2 = command === 'decision-reply' ? positionalsToFlags(rest, ['id', 'reply']) : command === 'resolve' || command === 'mark-applied' ? positionalsToFlags(rest, ['id']) : rest
    return { body: fn(parseFlags(argv2)), code: 0 }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}

const isMain = ((): boolean => {
  try {
    return process.argv[1] !== undefined && pathToFileURL(realpathSync(process.argv[1])).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return false
  }
})()
// ADR-0022 U5 (item 22): the `truss-status: <short JSON>` line `--status-line` adds after the result. It holds only the
// booleans ok, merged and admitted, head as a string, env cut to 200 characters, and ran from heavy.ran.
export function statusLine(body: Obj): string {
  const s: Obj = {}
  for (const k of ['ok', 'merged', 'admitted']) if (typeof body[k] === 'boolean') s[k] = body[k]
  if (typeof body.head === 'string') s.head = body.head
  if (typeof body.env === 'string') s.env = body.env.slice(0, 200)
  if (isObj(body.heavy) && typeof body.heavy.ran === 'boolean') s.ran = body.heavy.ran
  return `truss-status: ${JSON.stringify(s)}`
}
// Takes the boolean --status-line flag out of argv (for heavy, only before its `--`, so the command after it is untouched).
export function takeStatusFlag(argv: string[]): { on: boolean; argv: string[] } {
  const cut = argv.indexOf('--')
  const head = cut < 0 ? argv : argv.slice(0, cut)
  const rest = cut < 0 ? [] : argv.slice(cut)
  return { on: head.includes('--status-line'), argv: [...head.filter((a) => a !== '--status-line'), ...rest] }
}
// start's admission: a busy usage lock with no reading (StoreBusy from budgetVerdict, ADR-0038 amendment 2026-11-11) is never an
// admit. start holds that crew with why `store busy: usage` and still reports the crews it already started in this call.
function heldOnBusy(f: () => Admission): Admission {
  try {
    return f()
  } catch (e) {
    if (!(e instanceof StoreBusy)) throw e
    return { admitted: false, parallelism: 0, running: 0, freeMB: null, minFreeMB: 0, why: String(e.body.error) }
  }
}
if (isMain) {
  const { on, argv } = takeStatusFlag(process.argv.slice(2))
  const { body, code } = argv[0] === 'heavy' ? await heavyMain(argv.slice(1)) : main(argv)
  // ADR-0032: persona-install refuses with one stderr line (and no stdout), not the JSON error object the other commands print
  if (argv[0] === 'persona-install' && code !== 0) process.stderr.write(`persona-install: ${typeof body.error === 'string' ? body.error : JSON.stringify(body)}\n`.replace(/\n(?=.)/g, ' '))
  else process.stdout.write(JSON.stringify(body) + '\n' + (on ? statusLine(body) + '\n' : ''))
  process.exitCode = code
}
