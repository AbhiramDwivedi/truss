// truss ADR-0009 Decision 1: the factory CLI. Run as `node <plugin>/bin/factory.ts <command> [flags]`. Every command
// prints one JSON object on one line; exit 0 = done, 1 = a gate or expectation refused, 2 = usage or I/O error
// ({"error": "..."}). Node built-ins and ../hooks/register.ts only.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { goalOf, RUN_GOAL } from '../hooks/intake.ts'
import { fencedBlock, qcFails, qcK, localTime, parsePlan, planVerdict } from '../hooks/register.ts'
import type { QcFile } from '../hooks/register.ts'

// ==== core ====

export class CliError extends Error {
  code: number
  body: Record<string, unknown>
  constructor(code: number, body: Record<string, unknown>) {
    super(typeof body.error === 'string' ? body.error : JSON.stringify(body))
    this.code = code
    this.body = body
  }
}
const usage = (message: string): CliError => new CliError(2, { error: message })
const refuse = (body: Record<string, unknown>): CliError => new CliError(1, body)

type Flags = Record<string, string | boolean | string[]>
type Obj = Record<string, any>

const PLUGIN = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replace(/\\/g, '/')
const flat = (p: string): string => String(p).replace(/\\/g, '/')

// Flags as `--key value`; a flag with no value is true; a repeated flag becomes a list.
function parseFlags(argv: string[]): Flags {
  const flags: Flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw usage(`unexpected argument: ${a}`)
    const key = a.slice(2)
    const next = argv[i + 1]
    const value: string | boolean = next === undefined || next.startsWith('--') ? true : (i++, next)
    const old = flags[key]
    flags[key] = old === undefined ? value : [...(Array.isArray(old) ? old : [String(old)]), String(value)]
  }
  return flags
}
const str = (f: Flags, key: string): string | undefined => {
  const v = f[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw usage(`--${key} needs a value`)
  return v
}
const need = (f: Flags, key: string): string => {
  const v = str(f, key)
  if (v === undefined || v === '') throw usage(`missing --${key}`)
  return v
}
const listOf = (f: Flags, key: string): string[] => {
  const v = f[key]
  if (v === undefined) return []
  if (v === true) throw usage(`--${key} needs a value`)
  return Array.isArray(v) ? v : [String(v)]
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
const dirOf = (f: Flags): string => flat(need(f, 'dir'))

const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf8')
  } catch (e) {
    throw usage(`cannot read ${flat(p)}: ${(e as Error).message}`)
  }
}
const readJson = (p: string): any => {
  const text = readText(p)
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
  } catch {
    throw usage(`${flat(p)} is not JSON`)
  }
}
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

// A Workflow label as {slug, role, n}: strip a trailing -<n> (n >= 2) first, the last segment is the role, the rest the slug. Undefined when it has no role segment.
export function parseLabel(label: string): { slug: string; role: string; n: number } | undefined {
  if (typeof label !== 'string') return undefined
  let rest = label
  let n = 1
  const m = /-(\d+)$/.exec(rest)
  if (m) {
    n = Number(m[1])
    if (n < 2) return undefined
    rest = rest.slice(0, m.index)
  }
  const cut = rest.lastIndexOf('-')
  if (cut <= 0 || cut === rest.length - 1) return undefined
  return { slug: rest.slice(0, cut), role: rest.slice(cut + 1), n }
}

// The plan object from D/plan.json (usage error when missing or unreadable).
export function loadPlan(dir: string): Obj {
  const plan = readJson(`${dir}/plan.json`)
  if (!isObj(plan) || !Array.isArray(plan.crews)) throw usage(`${dir}/plan.json is not a plan`)
  return plan
}
// Writes the plan object back to D/plan.json, 2-space JSON with a trailing newline.
export function savePlan(dir: string, plan: Obj): void {
  writeFileSync(`${dir}/plan.json`, JSON.stringify(plan, null, 2) + '\n')
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
// The repo's .claude/truss.json as an object ({} when absent).
function configOf(repo: string): Obj {
  const p = `${repo}/.claude/truss.json`
  if (!existsSync(p)) return {}
  const v = readJson(p)
  return isObj(v) ? v : {}
}
const intOr = (v: unknown, dflt: number, min: number): number => (Number.isInteger(v) && (v as number) >= min ? (v as number) : dflt)

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
  const p = `${dir}/decisions.md`
  const old = existsSync(p) ? readFileSync(p, 'utf8') : ''
  appendFileSync(p, `${old === '' || old.endsWith('\n') ? '' : '\n'}- ${localTime(Date.now())} | ${text} | none | followed\n`)
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
// The crew's repair spend: its QC FAIL reports only (client ruling: stress-test rounds add nothing).
export function spentOf(dir: string, slug: string, since = 0): number {
  return qcFails(slug, countedQc(dir, slug, reportsOf(dir, slug)), since)
}
// {role: next free label number} from the crew's report files: `<slug>-qc.md` and `-qc-2.md` give {"qc": 3}.
export function labelFromOf(dir: string, slug: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of reportsOf(dir, slug)) {
    const p = parseLabel(f.name.replace(/\.md$/, ''))
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
function rolesWithTypes(plugin: string, types: string[]): Obj {
  const roles = readRoles(plugin)
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
  const cfg = configOf(repo)
  return {
    truss: {
      kind: 'plan', dir, repo, plugin: PLUGIN, schema: `${PLUGIN}/docs/plan.schema.json`, architecture: archPath(repo, cfg.architecture),
      maxParallelCrews: intOr(cfg.maxParallelCrews, 4, 1), reworkAllowance: intOr(cfg.reworkAllowance, 2, 0), roles: readRoles(PLUGIN),
      scriptPath: scriptPathFor(PLUGIN, 'plan.js', str(f, 'scripts-dir')),
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
  const json = fencedBlock(message, '````json plan.json')
  const md = fencedBlock(message, '````markdown plan.md')
  if (json === undefined || md === undefined) no(json === undefined ? 'no plan.json block' : 'no plan.md block')
  if (parsePlan(json as string) === undefined) no('the plan.json block is not a plan')
  const carried = JSON.parse((json as string).startsWith('﻿') ? (json as string).slice(1) : (json as string))
  if (!isObj(carried)) no('the plan.json block is not an object')
  if (existsSync(`${dir}/plan.json`)) {
    let existing
    try {
      existing = parsePlan(readFileSync(`${dir}/plan.json`, 'utf8'))
    } catch {
      return no('kept the existing plan: it could not be read')
    }
    if (existing === undefined) no('kept the existing plan: it is not a readable plan')
    else if (existing.approvedAt !== null) no('kept the existing plan: it is approved')
  }
  writeFileSync(`${dir}/plan.json`, JSON.stringify({ ...carried, approvedAt: null }, null, 2) + '\n')
  writeFileSync(`${dir}/plan.md`, md as string)
  return { written: true }
}

const SLUG = /^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$/
const literalOf = (g: string): string => g.slice(0, g.search(/[*?[]/) === -1 ? g.length : g.search(/[*?[]/))
const globsOverlap = (a: string, b: string): boolean => a === b || literalOf(a).startsWith(literalOf(b)) || literalOf(b).startsWith(literalOf(a))

function cmdPlanCheck(f: Flags): Obj {
  const plan = loadPlan(dirOf(f))
  const errors: string[] = []
  const crews: Obj[] = plan.crews.filter(isObj)
  const name = (c: Obj): string => (typeof c.slug === 'string' ? c.slug : '?')
  if (plan.version !== 2 && plan.version !== 3) errors.push('plan: version must be 2 or 3')
  const goalIds: string[] = []
  if (plan.version === 3 || plan.version === 2) {
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
        })
      }
    }
  }
  const hasStage0 = crews.some((c) => c.stage === 0 && goalOf(c) === RUN_GOAL)
  if ((plan.approval === 'client') !== hasStage0) errors.push(`plan: approval must be client exactly when a stage-0 crew exists (approval ${JSON.stringify(plan.approval)}, stage-0 crews ${hasStage0 ? 'exist' : 'do not'})`)
  for (const c of crews) {
    const s = name(c)
    if (typeof c.slug !== 'string' || !SLUG.test(c.slug)) errors.push(`${s}: slug does not match the slug pattern`)
    else if (c.slug === 'truss') errors.push(`${s}: truss is a reserved slug`)
    if (c.goal !== undefined) {
      if (plan.version === 2) errors.push(`${s}: goal is version 3 only`)
      else if (plan.version === 3 && (typeof c.goal !== 'string' || (c.goal !== RUN_GOAL && !goalIds.includes(c.goal)))) errors.push(`${s}: goal ${JSON.stringify(c.goal)} is neither ${RUN_GOAL} nor a goal in the plan's goals`)
    }
    if (plan.approvedAt === null && c.status !== 'planned') errors.push(`${s}: status must be planned on an unapproved plan, not ${JSON.stringify(c.status)}`)
  }
  for (let i = 0; i < crews.length; i++) {
    for (let j = i + 1; j < crews.length; j++) {
      if (crews[i].stage !== crews[j].stage || goalOf(crews[i]) !== goalOf(crews[j])) continue
      for (const ga of Array.isArray(crews[i].owns) ? crews[i].owns : []) {
        for (const gb of Array.isArray(crews[j].owns) ? crews[j].owns : []) {
          if (typeof ga === 'string' && typeof gb === 'string' && globsOverlap(ga, gb)) errors.push(`${name(crews[i])}: owns ${ga} overlaps ${name(crews[j])}'s ${gb} in stage ${crews[i].stage}`)
        }
      }
    }
  }
  if (errors.length > 0) throw refuse({ ok: false, errors })
  return { ok: true, unproved: crews.filter((c) => c.acceptanceTestProved === false).map(name) }
}

function cmdApprove(f: Flags): Obj {
  const dir = dirOf(f)
  const by = need(f, 'by')
  if (by !== 'client' && by !== 'auto') throw usage('--by must be client or auto')
  const repo = repoOf(f)
  const plan = loadPlan(dir)
  if (plan.approvedAt !== null && plan.approvedAt !== undefined) throw refuse({ error: `the plan is already approved (${String(plan.approvedAt)})` })
  const s = settingsOf(repo)
  const approvedAt = new Date().toISOString()
  savePlan(dir, { ...plan, approvedAt })
  appendDecision(dir, `plan approved (${by}): merge ${s.merge}, target ${s.target} from ${s.source}; approvedAt ${approvedAt}; scope frozen | the plan is approved by ${by}, so crews may start`)
  return { approvedAt }
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
  writeFileSync(`${dir}/checks/${slug}-${n}.json`, JSON.stringify({ command: crew.acceptanceTest, exit, head, tail }) + '\n', { flag: 'wx' })
  const ok = expect === 'red' ? exit !== 0 : exit === 0
  const body = { ok, exit, head, tail }
  if (!ok) throw refuse(body)
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
function cmdIntegrate(f: Flags): Obj {
  const branch = need(f, 'branch')
  const c = crewCtx(f)
  const trailers = unparsedTrailers(c.wt, branch)
  if (trailers.length > 0) throw refuse({ merged: false, conflicts: [], trailers })
  return mergeIn(c.wt, ['--no-ff', branch])
}
function cmdOwnsCheck(f: Flags): Obj {
  const c = crewCtx(f)
  const crew = loadPlan(c.dir).crews.find((x: Obj) => isObj(x) && x.slug === c.slug)
  if (crew === undefined) throw usage(`no crew ${c.slug} in the plan`)
  const owns: string[] = Array.isArray(crew.owns) ? crew.owns.filter((g: unknown) => typeof g === 'string') : []
  const files = gitOrFail(c.wt, ['diff', '--name-only', `${baseOf(c.wt, c.target)}...HEAD`]).split('\n').filter(Boolean)
  const outside = files.filter((file) => !owns.some((g) => path.matchesGlob(file, g)))
  if (outside.length > 0) throw refuse({ ok: false, outside })
  return { ok: true }
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
// The engine a goal file asks for: workflow only when `## Engine` starts with the word workflow; else foreman with the reason.
function engineOf(sections: Record<string, string>, merge: string, noWorkflow: boolean): { engine: 'workflow' | 'foreman'; reason: string } {
  if (merge === 'single') return { engine: 'foreman', reason: 'merge mode single runs on the foreman path' }
  if (noWorkflow) return { engine: 'foreman', reason: 'no Workflow tool in this session' }
  const text = sections.Engine
  if (text === undefined || text === '') return { engine: 'foreman', reason: 'the goal file has no ## Engine section' }
  const m = /^(\w+)[\s:,.\-]*([\s\S]*)$/.exec(text)
  if (m?.[1].toLowerCase() === 'workflow') return { engine: 'workflow', reason: '' }
  return { engine: 'foreman', reason: (m?.[2] ?? '').trim() || 'the goal file says foreman' }
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

type StartCtx = { dir: string; repo: string; roles: Obj; settings: { merge: string; target: string; source: string }; plan: Obj; scriptPath: string; arch: string; adrs: string[] }
const NEED_TRANSCRIPT = 'start needs --transcript T (a Workflow run dir; the runs root is its parent) to read the runs of this session'

// A crew entry for stage.js; `resume`, `tasks`, `done` and `answers` are the restart facts (fresh start: null and empty).
function crewEntry(c: StartCtx, crew: Obj, wt: string, extra: { resume: string | null; tasks?: unknown[]; done?: string[]; answers?: unknown[] }): Obj {
  const slug = String(crew.slug)
  const goalFile = `${c.dir}/goals/${slug}.md`
  const sections = goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '')
  return {
    slug, stage: crew.stage, goalFile, goal: (sections[''] ?? '').replace(/^# .*\n?/, '').trim(), owns: crew.owns ?? [], acceptanceTest: crew.acceptanceTest ?? '',
    highImpact: (sections['High-impact paths'] ?? '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').replace(/`/g, '').trim()).filter((l) => l !== '' && !/^none\.?$/i.test(l)),
    stressTest: /^(yes|true)\b/i.test(sections['Stress test'] ?? ''), scope: sections['Approved scope'] ?? '', worktree: wt, branch: `truss-${slug}`,
    base: baseOf(wt, c.settings.target), architecture: c.arch, adrs: c.adrs, resume: extra.resume, tasks: extra.tasks ?? [], done: extra.done ?? [], answers: extra.answers ?? [],
    spent: spentOf(c.dir, slug), labelFrom: labelFromOf(c.dir, slug),
  }
}
function stageOut(c: StartCtx, entries: Obj[], foremen: Obj[], refused: Obj[], stale: Obj[], unfinished: Obj[]): Obj {
  return {
    truss: { kind: 'stage', dir: c.dir, repo: c.repo, plugin: PLUGIN, target: c.settings.target, reworkAllowance: intOr(c.plan.reworkAllowance, 2, 0), roles: c.roles, scriptPath: c.scriptPath, crews: entries },
    foremen, refused, stale, unfinished,
  }
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
// Names of the tasks whose member result is DONE and whose branch is an ancestor of the crew branch (git decides, not the report),
// over the given runs: a task done in an earlier run, and passed in `done` to a later one that never re-ran it, stays done.
function doneTasks(runs: WfRun[], slug: string, wt: string): string[] {
  const done: string[] = []
  for (const a of runs.flatMap((r) => r.agents)) {
    const r = a.result
    if (parseLabel(a.label)?.slug !== slug || !isObj(r) || r.marker !== 'DONE' || typeof r.branch !== 'string' || typeof r.task !== 'string') continue
    if (run(wt, ['merge-base', '--is-ancestor', r.branch, `truss-${slug}`]).status === 0 && !done.includes(r.task)) done.push(r.task)
  }
  return done
}

// start --slug S --resume answers|merge-ready|stale: one crew entry, or a refusal {slug, why}.
function cmdStartResume(f: Flags, c: StartCtx, slug: string, kind: string): Obj {
  if (!['answers', 'merge-ready', 'stale'].includes(kind)) throw usage(`--resume needs answers, merge-ready or stale, got ${kind}`)
  const transcript = str(f, 'transcript') ?? ''
  if ((kind === 'answers' || kind === 'stale') && transcript === '') throw usage(`--resume ${kind} needs --transcript T: ${NEED_TRANSCRIPT}`)
  let answers: unknown[] = []
  if (kind === 'answers') {
    const a = readJson(need(f, 'answers'))
    if (!Array.isArray(a) || !a.every((x) => isObj(x) && typeof x.at === 'string' && typeof x.text === 'string')) throw usage('--answers must be a JSON array of {"at","text"}')
    answers = a
  }
  const crew = c.plan.crews.find((x: unknown) => isObj(x) && x.slug === slug)
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
  } else if (kind === 'answers') {
    const t = runOf(transcript)
    const all = runsNextTo(transcript)
    runs = crewRunsOf(all.some((r) => r.id === t.id) ? all : [...all, t], slug)
  }
  const wt = ensureWorktree(c.repo, slug, c.settings.target)
  // A stale crew whose branch has no commit beyond the base starts from step 1.
  const noWork = kind === 'stale' && Number(run(wt, ['rev-list', '--count', `${baseOf(wt, c.settings.target)}..HEAD`]).out) === 0
  const rebuild = kind !== 'merge-ready' && !noWork
  // done counts only from the run of the chosen plan on, so a re-split's task names never match an older plan's members
  const plan = rebuild ? plannerTasks(runs, slug) : { tasks: [], from: 0 }
  const entry = crewEntry(c, crew, wt, { resume: kind, tasks: plan.tasks, done: rebuild ? doneTasks(runs.slice(plan.from), slug, wt) : [], answers })
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
    appendEvent(c.dir, { event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' })
    appendDecision(c.dir, `restarted stale workflow crew ${slug} | its stage.js run died; same worktree and branch; ${entry.spent} repair round(s) already spent`)
  }
  return stageOut(c, [entry], [], [], [], [])
}

function cmdStart(f: Flags): Obj {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const roles = rolesWithTypes(PLUGIN, listOf(f, 'type'))
  const settings = settingsOf(repo)
  const plan = loadPlan(dir)
  const scriptPath = scriptPathFor(PLUGIN, 'stage.js', str(f, 'scripts-dir'))
  const arch = archPath(repo, plan.architecture)
  const adrDir = `${path.posix.dirname(arch)}/adr`
  const adrs = existsSync(adrDir) ? readdirSync(adrDir).filter((n) => n.endsWith('.md')).sort().map((n) => `${adrDir}/${n}`) : []
  const ctx: StartCtx = { dir, repo, roles, settings, plan, scriptPath, arch, adrs }
  const slugFlag = str(f, 'slug')
  const resumeFlag = str(f, 'resume')
  if (slugFlag !== undefined || resumeFlag !== undefined) {
    if (!slugFlag || !resumeFlag) throw usage('start --slug and --resume go together')
    return cmdStartResume(f, ctx, slugFlag, resumeFlag)
  }
  const stageArg = need(f, 'stage')
  const noWorkflow = f['no-workflow'] === true
  const crews: Obj[] = plan.crews.filter(isObj)
  const open = crews.filter((c) => c.status === 'planned' || c.status === 'running').map((c) => c.stage).filter((w) => typeof w === 'number')
  if (open.length === 0) throw refuse({ error: 'no stage has a planned or running crew' })
  const next = Math.min(...open)
  // A plan with a goals array gets per-goal stages; a plan without one takes the single global next stage, as before.
  const hasGoals = Array.isArray(plan.goals) && plan.goals.length > 0
  const goalNext = new Map<string, number>()
  for (const c of crews) {
    if ((c.status !== 'planned' && c.status !== 'running') || typeof c.stage !== 'number') continue
    const g = goalOf(c)
    goalNext.set(g, Math.min(goalNext.get(g) ?? Infinity, c.stage))
  }
  if (!hasGoals && stageArg !== 'next' && Number(stageArg) !== next) throw refuse({ error: `stage ${stageArg} is not the next stage: ${next}` })
  if (hasGoals && stageArg !== 'next' && ![...goalNext.values()].includes(Number(stageArg))) {
    throw refuse({ error: `stage ${stageArg} is not the next stage of any goal: ${[...goalNext].map(([g, w]) => `${g} ${w}`).join(', ')}` })
  }
  const startsNow = (crew: Obj): boolean => (hasGoals ? goalNext.get(goalOf(crew)) === crew.stage && (stageArg === 'next' || Number(stageArg) === crew.stage) : crew.stage === next)
  const cap = intOr(plan.maxParallelCrews, 4, 1)
  let slots = cap - crews.filter((c) => c.status === 'running').length
  const wasRunning = crews.filter((c) => c.status === 'running')
  const foremen: Obj[] = []
  const refused: Obj[] = []
  const entries: Obj[] = []
  for (const crew of crews) {
    if (!startsNow(crew) || crew.status !== 'planned') continue
    if (slots <= 0) break
    const slug = String(crew.slug)
    const goalFile = `${dir}/goals/${slug}.md`
    const sections = goalSections(existsSync(goalFile) ? readFileSync(goalFile, 'utf8') : '')
    const { engine, reason } = engineOf(sections, settings.merge, noWorkflow)
    if (engine === 'foreman') {
      const foremanVerdict = hasGoals ? planVerdict(parsePlan(JSON.stringify(plan)) as any, slug) : undefined
      if (foremanVerdict !== undefined) {
        refused.push({ slug, reason: foremanVerdict.deny })
        continue
      }
      foremen.push({ slug, reason })
      slots--
      continue
    }
    const verdict = planVerdict(parsePlan(JSON.stringify(plan)) as any, slug)
    if (verdict !== undefined) {
      refused.push({ slug, reason: verdict.deny })
      continue
    }
    const wt = ensureWorktree(repo, slug, settings.target)
    crew.status = 'running'
    savePlan(dir, plan)
    appendEvent(dir, { event: 'spawn', crew: slug, agent: slug, agentId: null, type: 'workflow-crew', model: null, effort: null, by: 'factory' })
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
  return stageOut(ctx, entries, foremen, refused, stale, unfinished)
}

// --args-file P (absolute): start writes its whole output to P, the same one line, and prints a short pointer instead,
// so the stage args never fill the PM's Bash output. A Workflow script has no file system and the Workflow gate reads
// args.truss from the call, so the PM still Reads P and passes that object as the Workflow's args.
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
  return { argsFile: flat(p), scriptPath: out.truss.scriptPath, crews: out.truss.crews.map((e: Obj) => e.slug), foremen: out.foremen, refused: out.refused, stale: out.stale, unfinished: out.unfinished }
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
    if ((facts.effort === 'high' || facts.effort === 'xhigh') && parsed !== undefined) bad(`effort ${facts.effort} on role ${parsed.role}`)
    if (parsed !== undefined && (parsed.role === 'qc' || parsed.role === 'stress') && agentType !== 'truss:qc-engineer') bad(`${parsed.role} ran as ${agentType ?? 'an unknown type'}, not truss:qc-engineer`)
    if (parsed !== undefined && parsed.role === 'qc' && facts.tools.some((t) => t.name === 'Write' || t.name === 'Edit')) bad('a QC used Write or Edit')
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
    const file = `${dir}/reports/${slug}/${a.label}.md`
    mkdirSync(`${dir}/reports/${slug}`, { recursive: true })
    if (existsSync(file) && readFileSync(file, 'utf8') !== text) {
      bad('a report file with different text already exists; not overwritten')
    } else {
      if (!existsSync(file)) writeFileSync(file, text)
      const when = facts.lastTs === undefined ? NaN : Date.parse(facts.lastTs)
      if (Number.isFinite(when)) utimesSync(file, when / 1000, when / 1000)
    }
    const by = `workflow:${wfRun.id}`
    if (!events.some((e) => e.event === 'spawn' && e.agentId === a.agentId && e.by === by)) {
      appendEvent(dir, { event: 'spawn', crew: slug, agent: a.label, agentId: a.agentId, type: agentType ?? 'general-purpose', model: facts.model ?? null, effort: facts.effort ?? null, by })
    }
    const marker = markerOf(text)
    if (!events.some((e) => e.event === 'report' && e.crew === slug && e.agent === a.label && (e.marker ?? null) === marker)) {
      appendEvent(dir, { event: 'report', crew: slug, agent: a.label, marker })
    }
  }
  return audits
}

// Session audit: every Workflow run of the session at or after the run start, in scope as ADR-0009 "finish, session audit" says.
function sessionAudit(dir: string, rootDir: string, thisRunId: string, factorySlugs: Set<string>, waived: Set<string>): Audit[] {
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
function worktreesOf(repo: string): { path: string; branch: string | undefined }[] {
  const out: { path: string; branch: string | undefined }[] = []
  for (const block of run(repo, ['worktree', 'list', '--porcelain']).out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const p = lines.find((l) => l.startsWith('worktree '))
    if (p === undefined) continue
    const b = lines.find((l) => l.startsWith('branch '))
    out.push({ path: flat(p.slice('worktree '.length)), branch: b === undefined ? undefined : b.slice('branch refs/heads/'.length) })
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

// The lowest-numbered D/checks/<slug>-<n>.json: the red record. undefined when none.
function redRecord(dir: string, slug: string): Obj | undefined {
  const d = `${dir}/checks`
  if (!existsSync(d)) return undefined
  const re = new RegExp(`^${slug.replace(/[^a-z0-9-]/g, '\\$&')}-(\\d+)\\.json$`)
  const found = readdirSync(d).flatMap((n) => {
    const m = re.exec(n)
    return m?.[1] === undefined ? [] : [{ n: Number(m[1]), name: n }]
  }).sort((x, y) => x.n - y.n)[0]
  if (found === undefined) return undefined
  try {
    const v = JSON.parse(readFileSync(`${d}/${found.name}`, 'utf8'))
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

type Outcome = { merged?: true; rework?: string; blocked?: string; refused?: string }

// Merge step for one crew whose newest QC is a clean PASS (ADR-0009 steps 1 to 5). Fails closed: any doubt is a refusal.
function mergeCrew(f: Flags, dir: string, repo: string, target: string, crew: Obj, ruling: QcRuling, audits: Audit[], fails: number): Outcome {
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
  const allowance = intOr(plan.reworkAllowance, 2, 0)
  if (fails > allowance) return { refused: `rework allowance spent: ${fails} QC FAILs, allowance ${allowance}` }
  const red = redRecord(dir, slug)
  if (red === undefined || !Number.isInteger(red.exit) || red.exit === 0) return { refused: 'no red record: the lowest-numbered checks file is missing or has exit 0' }
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
  const patch = head === '' || base === '' ? undefined : patchOf(wt, base, head)
  if (ruling.head === undefined || ruling.patch === undefined || head === '' || patch === undefined) return { refused: 'patch id unavailable' }
  if (mergeHeadVerdict(plan, ruling, head, patch) !== undefined) return { rework: 'reqc' }
  if (head !== ruling.head) {
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
    if (run(onTarget.path, ['merge', '--ff-only', `refs/heads/truss-${slug}`]).status !== 0) return { rework: 'target moved' }
  } else if (run(repo, ['update-ref', targetRef, head, oldSha]).status !== 0) return { rework: 'target moved' }
  // step 5: record, then clean up
  const fresh = loadPlan(dir)
  const entry = fresh.crews.find((c: Obj) => isObj(c) && c.slug === slug)
  if (entry !== undefined) entry.status = 'merged'
  savePlan(dir, fresh)
  appendDecision(dir, `crew ${slug} merged into ${target} at ${head} | QC PASS on ${ruling.head}, red record exit ${red.exit}, patch ${patch}, acceptance test green on the merged head`)
  const own = new Set(fresh.crews.filter(isObj).map((c: Obj) => `truss-${c.slug}`))
  for (const w of worktreesOf(repo)) {
    if (w.path === wt || w.branch === undefined || own.has(w.branch) || !w.branch.startsWith(`truss-${slug}-`)) continue
    if (run(repo, ['merge-base', '--is-ancestor', `refs/heads/${w.branch}`, `refs/heads/truss-${slug}`]).status === 0) run(repo, ['worktree', 'remove', w.path])
  }
  run(repo, ['worktree', 'remove', wt])
  return { merged: true }
}

function cmdFinish(f: Flags): Obj {
  const repo = repoOf(f)
  need(f, 'transcript')
  const settings = settingsOf(repo)
  if (settings.merge === 'single') throw usage('single merge mode runs on the foreman path')
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
  const roles = readRoles(PLUGIN)
  const wfRun = runOf(tdir)
  const factoryCrews: Obj[] = plan.crews.filter((c: Obj) => isObj(c) && typeof c.slug === 'string' && c.status === 'running' && factorySpawned(dir, c.slug) !== undefined)
  const factorySlugs = new Set(factoryCrews.map((c) => c.slug as string))
  const inRun = factoryCrews.filter((c) => wfRun.agents.some((a) => parseLabel(a.label)?.slug === c.slug))
  const out = { merged: [] as string[], rework: [] as Obj[], blocked: [] as Obj[], refused: [] as Obj[], audit: [] as Obj[], incomplete: [] as string[], stopped: [] as Obj[] }
  const finishWith = (): Obj => {
    const body = { merged: out.merged, rework: out.rework, blocked: out.blocked, refused: out.refused, audit: out.audit, incomplete: out.incomplete, stopped: out.stopped }
    if (out.refused.length > 0 || out.rework.length > 0 || out.blocked.length > 0 || out.audit.length > 0) throw refuse(body)
    return body
  }

  // every running crew whose result is not `passed`, or that the run holds with no result at all, is listed so the PM
  // can't miss it; why is the stop text's first line (the full text is in the result file). It never changes the exit code.
  for (const c of results === undefined ? [] : factoryCrews) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined && !inRun.includes(c)) continue
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

  const audits = recordRun(dir, wfRun, factorySlugs, roles)
  for (const a of audits) out.audit.push({ label: a.label, why: a.why })

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
  for (const c of inRun) {
    const res = results.find((r) => r.slug === c.slug)
    if (res === undefined || res.state !== 'passed') continue
    const files = reportsOf(dir, c.slug)
    const newest = latestQc(c.slug, files, since)
    const ruling = newest === undefined ? undefined : qcRuling(newest.text)
    if (ruling === undefined || ruling.verdict !== 'PASS' || ruling.unscoped > 0) continue
    const r = mergeCrew(f, dir, repo, settings.target, c, ruling, audits, qcFails(c.slug, countedQc(dir, c.slug, files), since))
    if (r.merged) out.merged.push(c.slug)
    else if (r.rework !== undefined) out.rework.push({ slug: c.slug, why: r.rework })
    else if (r.blocked !== undefined) out.blocked.push({ slug: c.slug, why: r.blocked })
    else out.refused.push({ slug: c.slug, why: r.refused ?? 'refused' })
  }
  return finishWith()
}

// ==== main ====

const COMMANDS: Record<string, (f: Flags) => Obj> = {
  settings: cmdSettings, 'plan-args': cmdPlanArgs, 'plan-write': cmdPlanWrite, 'plan-check': cmdPlanCheck, approve: cmdApprove, start: (f) => argsFileOut(f, cmdStart(f)),
  sync: cmdSync, check: cmdCheck, integrate: cmdIntegrate, 'owns-check': cmdOwnsCheck, finish: cmdFinish,
}

// Runs one command and returns what it printed and its exit code.
export function main(argv: string[]): { body: Obj; code: number } {
  try {
    const [command, ...rest] = argv
    const fn = command === undefined ? undefined : COMMANDS[command]
    if (fn === undefined) throw usage(`unknown command: ${command ?? '(none)'}; commands: ${Object.keys(COMMANDS).join(', ')}`)
    return { body: fn(parseFlags(rest)), code: 0 }
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
if (isMain) {
  const { body, code } = main(process.argv.slice(2))
  process.stdout.write(JSON.stringify(body) + '\n')
  process.exitCode = code
}
