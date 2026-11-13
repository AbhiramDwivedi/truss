// Helpers every factory command module shares: flag parsing, git, the plan file, settings, knowledge config, events, roles.
// Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import
// cycle.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { commonDir, configOf, flat, isObj, listOf, need, readJson, repoPathOf, str, transcriptsOf, usage, withLock, writeJsonAtomic } from '../store.ts'
import type { Flags, Obj } from '../store.ts'
import { budgetsOf, rulesIndex as knowledgeRulesIndex } from '../knowledge.ts'
import type { KCfg } from '../knowledge.ts'
import { localTime } from '../../hooks/register.ts'

export const PLUGIN = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))).replace(/\\/g, '/')
// The CLI file itself, which heavy and gates run again as a child process.
export const FACTORY = fileURLToPath(new URL('../factory.ts', import.meta.url))

// Flags as `--key value` or `--key=value` (the `=` form is the safe one for a value that starts with `--`); a flag with no value
// is true; a repeated flag becomes a list.
export function parseFlags(argv: string[]): Flags {
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
export function run(cwd: string, args: string[]): { status: number; out: string; err: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (r.error) throw usage(`git failed to run: ${r.error.message}`)
  return { status: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }
}
export function gitOrFail(cwd: string, args: string[]): string {
  const r = run(cwd, args)
  if (r.status !== 0) throw usage(`git ${args.join(' ')} failed: ${r.err || r.out}`)
  return r.out
}

export function repoOf(f: Flags): string {
  const given = str(f, 'repo')
  if (given !== undefined && given !== '') return flat(given)
  const r = run(process.cwd(), ['rev-parse', '--show-toplevel'])
  if (r.status !== 0) throw usage('no --repo and the cwd is not in a git repository')
  return flat(r.out)
}
// ADR-0027 F-67 item 2: every command but start refuses a relative --dir, since a relative one resolves against
// whatever cwd ran it. start (and start --resume) resolve it themselves through startDirOf, as ADR-0019 item 18 left them.
export const startDirOf = (f: Flags): string => flat(need(f, 'dir'))
export const dirOf = (f: Flags): string => {
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
export function patchPlan(dir: string, change: (plan: Obj) => void): Obj {
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
export const intOr = (v: unknown, dflt: number, min: number): number => (Number.isInteger(v) && (v as number) >= min ? (v as number) : dflt)

// The knowledge step's doc keys (ADR-0033) as stage.js args: only the ones set to a valid path. adrDir falls back to `adr`, the
// ADR directory key init already writes.
export function docKeysOf(repo: string): { featureMap?: string; adrDir?: string } {
  const cfg = configOf(repo)
  const featureMap = repoPathOf(cfg.featureMap)
  const adrDir = repoPathOf(cfg.adrDir) ?? repoPathOf(cfg.adr)
  return { ...(featureMap === undefined ? {} : { featureMap }), ...(adrDir === undefined ? {} : { adrDir }) }
}
// ADR-0035: the path-scoped knowledge keys of truss.json, each a valid repo path or its default.
export function knowledgeCfgOf(repo: string): KCfg {
  return knowledgeCfgFrom(configOf(repo))
}
export function knowledgeCfgFrom(cfg: Obj): KCfg {
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
export function knowledgeArgsOf(repo: string, withRules: boolean): Obj {
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
export function appendDecisionLine(dir: string, line: string): void {
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

// The roles table copied for args, with `--type role=agentType` laid on the roles marked typeFromProject: true; resolver follows the role its typeFromProject names.
// The roles table's model and effort for a role; every spawn event carries both, never null (a stage.js agent() call always sets them).
export function roleDefaults(roles: Obj, role: string): { model: string; effort: string } {
  const r = isObj(roles[role]) ? roles[role] : {}
  return { model: typeof r.model === 'string' ? r.model : 'sonnet', effort: typeof r.effort === 'string' ? r.effort : 'medium' }
}
export function rolesWithTypes(plugin: string, types: string[], cfgRoles?: unknown): Obj {
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
export function modelsOf(f: Flags, roles: Obj): Record<string, string> {
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
export function scriptPathFor(plugin: string, script: string, scriptsDir: string | undefined): string {
  const src = `${plugin}/workflows/${script}`
  if (scriptsDir === undefined) return src
  if (!existsSync(src)) throw usage(`${src} does not exist`)
  mkdirSync(scriptsDir, { recursive: true })
  const to = `${flat(scriptsDir)}/truss-${script}`
  copyFileSync(src, to)
  return to
}
// The session scripts dir the Workflow tool accepts: <dirname of the main transcript>/<sid>/workflows/scripts, where <sid> is the path
// segment directly under <git common dir>/truss/ of the truss dir (a wave subdir is allowed). undefined when the session is not found.
export function sessionScriptsDir(repo: string, dir: string): string | undefined {
  const rel = path.relative(`${flat(commonDir(repo))}/truss`, path.resolve(dir))
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  const sid = flat(rel).split('/')[0] as string
  const main = transcriptsOf(sid).main
  return main === null ? undefined : `${path.posix.dirname(flat(main))}/${sid}/workflows/scripts`
}
// The architecture doc as an absolute path (the key `architecture` of truss.json, repo-relative, default docs/architecture.md).
export const archPath = (repo: string, rel: unknown): string => path.isAbsolute(String(rel)) ? flat(String(rel)) : `${repo}/${typeof rel === 'string' && rel !== '' ? rel : 'docs/architecture.md'}`
