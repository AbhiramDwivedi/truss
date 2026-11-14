// The start command, with resume: crew entries, crew state from earlier runs, carried answers and the --args-file form.
// Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import
// cycle.
import path from 'node:path'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CliError, configOf, flat, isObj, listOf, need, parseLabel, readJson, refuse, str, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { releaseLease, takeLease, writeJsonAtomic } from '../lock.ts'
import { profilesOf } from '../worktypes.ts'
import { parsePlan, planVerdict, unbannered } from '../../hooks/register.ts'
import { goalOf, RUN_GOAL } from '../../hooks/intake.ts'
import { acceptanceCommand, goalSections } from './goal-file.ts'
import { guardedOf, isTestPath, mergeIn, operationInProgress } from './crew.ts'
import { CREW_STATE, learnedOf, readQuiet, setCrewState } from './decisions.ts'
import { redRecord } from './finish.ts'
import { buildPersonas } from './personas.ts'
import { admission, heldOnBusy } from './admit.ts'
import { excludeScratch } from './retire.ts'
import { crewRunsOf, directionOf, eventsOf, factorySpawned, firstLine, isLive, labelFromOf, promptTask, runOf, runsNextTo, spentOf } from './runs.ts'
import type { RunAgent, WfRun } from './runs.ts'
import { archPath, baseOf, crewWorktree, gitOrFail, intOr, PLUGIN, repoOf, run, startDirOf } from './cli.ts'
import { loadPlan, patchPlan } from './plan-file.ts'
import { docKeysOf, knowledgeArgsOf, settingsOf } from './settings.ts'
import { appendDecision, appendEvent } from './log.ts'
import { modelsOf, roleDefaults, rolesWithTypes, scriptPathAuto } from './roles.ts'
import { loadWarned, memberWarnings, roleWarnings, saveWarned, stressWarnings, useSessionStart } from './warnings.ts'

// ==== start ====

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
export type Members = Partial<Record<'builder' | 'tester', { model: string; effort: string }>>
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

// ADR-0052: claims a planned crew under the plan lock (planned to running, only if plan.json still says planned), then creates
// its worktree. Undefined when another process claimed the crew first. A worktree failure hands the claim back before it throws.
function claimedWorktree(dir: string, repo: string, slug: string, target: string): string | undefined {
  let won = false
  patchPlan(dir, (p) => {
    const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug)
    if (e !== undefined && e.status === 'planned') {
      e.status = 'running'
      delete e.engine
      e.owner = { pid: process.pid, token: randomUUID() }
      won = true
    }
  })
  if (!won) return undefined
  try {
    return ensureWorktree(repo, slug, target)
  } catch (err) {
    patchPlan(dir, (p) => { const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug); if (e !== undefined && e.status === 'running') { e.status = 'planned'; delete e.owner } })
    throw err
  }
}

// ADR-0052 Decision 1: the claim's owner is dead when its pid no longer exists (ESRCH); EPERM means the process lives. A claim
// with no owner (a plan written before 0.32.0) has no live process to wait for, so it counts as dead.
function ownerDead(owner: unknown): boolean {
  if (!isObj(owner) || !Number.isInteger(owner.pid)) return true
  try {
    process.kill(owner.pid as number, 0)
    return false
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

// ADR-0052 Decision 1: a start that died after claimedWorktree set the crew running and before its spawn event leaves a
// running workflow crew that no start form can restart (no spawn event, so it is neither stale nor resumable). Such a crew
// never ran anything, so it goes back to planned, in plan.json and in the in-memory plan, and the loop below starts it.
// A direct (solo or lean) crew writes no spawn event, so its sign of a start that died is a dead owner and no crew worktree.
function reclaimOrphans(dir: string, repo: string, plan: Obj, merge: string, noWorkflow: boolean): void {
  const orphaned = (c: Obj): boolean => isDirect(c) ? !existsSync(crewWorktree(repo, String(c.slug))) : factorySpawned(dir, String(c.slug)) === undefined
  const orphans = plan.crews.filter((c: unknown) => {
    if (!isObj(c) || c.status !== 'running' || c.engine === 'project-manager' || !orphaned(c) || !ownerDead(c.owner)) return false
    if (isDirect(c)) return true
    const goalFile = `${dir}/goals/${String(c.slug)}.md`
    if (!existsSync(goalFile)) return false
    return engineOf(goalSections(readFileSync(goalFile, 'utf8')), merge, noWorkflow).engine === 'workflow'
  }) as Obj[]
  if (orphans.length === 0) return
  const slugs = new Set(orphans.map((c) => String(c.slug)))
  patchPlan(dir, (p) => {
    for (const e of p.crews) if (isObj(e) && slugs.has(String(e.slug)) && e.status === 'running' && e.engine !== 'project-manager' && orphaned(e) && ownerDead(e.owner)) { e.status = 'planned'; delete e.owner }
  })
  for (const c of orphans) c.status = 'planned'
  for (const s of slugs) appendDecision(dir, `crew ${s} was left running by a start that died before its spawn event; set back to planned and started again`)
}

export type StartCtx = { dir: string; repo: string; roles: Obj; settings: { merge: string; target: string; source: string }; plan: Obj; scriptPath: string; arch: string; adrs: string[]; models: Record<string, string> }
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
  // the goal file is what crews read and the PM edits, so its `## Acceptance test` section wins over plan.json's acceptanceTest
  // (stageOut warns when the two differ); without the section, the plan's command goes in the entry so the prompts still print it
  const atInGoal = has('Acceptance test')
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
// The refusal reason for a goal file whose `## Acceptance test` section is malformed (not exactly one fenced code block), else
// undefined. `factory check` refuses the same section with the same message, so the PM sees it before a crew runs.
export function acceptanceRefusal(goalFile: string): string | undefined {
  if (!existsSync(goalFile)) return undefined
  const r = acceptanceCommand(readFileSync(goalFile, 'utf8'))
  return typeof r === 'object' ? `goal file ${flat(goalFile)}: ${r.error}` : undefined
}
function stageOut(c: StartCtx, entries: Obj[], projectManagers: Obj[], refused: Obj[], stale: Obj[], unfinished: Obj[], held: Obj[] = [], direct: Obj[] = []): Obj {
  const w = loadWarned(c.dir)
  const found = buildPersonas(c.repo)
  const warnings = [...stressWarnings(c, [...entries, ...projectManagers].map((e) => String(e.slug)), w), ...roleWarnings(c, entries, w, found.personas), ...memberWarnings(c, entries), ...found.warnings]
  saveWarned(c.dir, w)
  return {
    truss: { kind: 'stage', platform: process.platform, dir: c.dir, repo: c.repo, plugin: PLUGIN, target: c.settings.target, reworkAllowance: intOr(c.plan.reworkAllowance, 2, 0), roles: c.roles, personas: found.personas, ...docKeysOf(c.repo), ...knowledgeArgsOf(c.repo, true), scriptPath: c.scriptPath, crews: entries, ...(typeof c.plan.approvedAt === 'string' ? { approvedAt: c.plan.approvedAt } : {}) },
    held, projectManagers, ...(direct.length > 0 ? { direct } : {}), refused, stale, unfinished, warnings,
  }
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
    if (!Array.isArray(a) || !a.every((x) => isObj(x) && typeof x.at === 'string' && typeof x.text === 'string')) throw usage('--answers must be a JSON array of {"at","text"} (and an optional "role")')
    // 0.32.0: an answer ordering a test change carries "role": "tester", so a test-writer builds it before the stopped task reruns
    const bad = a.find((x) => isObj(x) && x.role !== undefined && x.role !== 'tester')
    if (bad !== undefined) throw usage(`--answers: the answer at ${String((bad as Obj).at)} has role ${JSON.stringify((bad as Obj).role)}; role must be "tester" or absent`)
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
  const atDeny = acceptanceRefusal(goalFile)
  if (atDeny !== undefined) return stageOut(c, [], [], [{ slug, reason: atDeny }], [], [])
  // R-89: one finisher per crew; a live finisher lease refuses the resume
  const lease = takeLease(c.dir, `finisher-${slug}`)
  if (lease === null) throw refuse({ slug, why: 'finisher live' })
  try {
    const wt = ensureWorktree(c.repo, slug, c.settings.target)
    // R-90: the target goes into the crew branch as cmdSync does; a conflict is aborted (the worktree stays clean) and stage.js re-syncs it to the resolver
    let syncConflicts: string[] | undefined
    // ADR-0026 item 58: an operation left unconcluded in the worktree (the resolver's merge, partly or fully resolved) is never merged
    // into or aborted; its unmerged paths (none when all are staged) go to the resolver as the sync conflicts, which concludes it
    const pending = operationInProgress(wt)
    if (pending !== undefined) syncConflicts = run(wt, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)
    else try {
      mergeIn(wt, [c.settings.target])
    } catch (e) {
      if (!(e instanceof CliError) || e.code !== 1 || !Array.isArray(e.body.conflicts)) throw e
      syncConflicts = e.body.conflicts as string[]
      run(wt, ['merge', '--abort'])
    }
    // A stale crew whose branch has no commit beyond the base starts from step 1.
    const noWork = kind === 'stale' && Number(run(wt, ['rev-list', '--count', `${baseOf(wt, c.settings.target)}..HEAD`]).out) === 0
    const rebuild = kind !== 'merge-ready' && !noWork
    // done counts only from the run of the chosen plan on, so a re-split's task names never match an older plan's members
    const plan = rebuild ? plannerTasks(runs, slug) : { tasks: [], from: 0 }
    // 0.29.0 item 5: every earlier ruling still unbuilt rides along, so a PM's new answers file never drops one
    // 0.31.0 item 6: the new answers come first and their count goes on the entry, so stage.js builds a new ruling at qc once
    const fresh = answers.length
    // bug J: --withdraw-answers carries no stored ruling, so the crew's answers and the store are exactly the fresh ones
    answers = f['withdraw-answers'] === true ? (answers as Answer[]).map((a) => ({ at: a.at, text: a.text, ...(a.role === 'tester' ? { role: 'tester' as const } : {}) })) : carriedAnswers(c.dir, slug, answers as Answer[], runs, plan.from, wt, c.settings.target, rebuild)
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
    if (syncConflicts !== undefined) entry.syncConflicts = syncConflicts
    entry.freshAnswers = fresh
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
    saveAnswers(c.dir, slug, answers as Answer[], runs)
    return missing.length > 0 ? { ...out, missingWorktrees: missing } : out
  } finally {
    releaseLease(c.dir, `finisher-${slug}`, lease.token)
  }
}

// 0.29.0 item 5: the crew's answers store, <dir>/crews/<slug>/answers.json. Each row is one ruling {at, text} plus `after`, the
// id of the crew's newest Workflow run when the ruling was given (null when the resume had no runs), and `ts`.
type Answer = { at: string; text: string; role?: 'tester' }
type StoredAnswer = Answer & { after: string | null; ts: string }
const ANSWERS_FILE = (dir: string, slug: string): string => `${CREW_STATE(dir, slug)}/answers.json`
const sameAnswer = (a: Answer, b: Answer): boolean => a.at === b.at && a.text === b.text && a.role === b.role
function storedAnswers(dir: string, slug: string): StoredAnswer[] {
  const v = readQuiet(ANSWERS_FILE(dir, slug))
  return Array.isArray(v) ? v.filter((x): x is StoredAnswer => isObj(x) && typeof x.at === 'string' && typeof x.text === 'string').map((x) => ({ at: x.at, text: x.text, ...(x.role === 'tester' ? { role: 'tester' as const } : {}), after: typeof x.after === 'string' ? x.after : null, ts: typeof x.ts === 'string' ? x.ts : '' })) : []
}

// The answers a resume hands stage.js: the new ones first, then each stored one that is still unbuilt and not repeated. A stored
// answer at a task name is built once a run that started after it finished that task (doneTasks over the runs after `after`); a
// built one is dropped, since re-sending it would re-run a finished task. An answer at a step name (red, split, green, qc, a
// stress or UX step) is a standing ruling and always rides along. When `after` names no run of the crew, the answer counts as
// unbuilt: carrying a ruling twice costs one rerun, losing one costs a QC round.
function carriedAnswers(dir: string, slug: string, fresh: Answer[], runs: WfRun[], from: number, wt: string, target: string, rebuild: boolean): Answer[] {
  const out: Answer[] = fresh.map((a) => ({ at: a.at, text: a.text, ...(a.role === 'tester' ? { role: 'tester' as const } : {}) }))
  const taskNames = new Set(rebuild ? plannerTasks(runs, slug).tasks.filter(isObj).map((t: Obj) => String(t.name)) : [])
  const builtAfter = new Map<string, string[]>()
  for (const a of storedAnswers(dir, slug)) {
    if (out.some((x) => sameAnswer(x, a))) continue
    if (taskNames.has(a.at)) {
      const at = a.after === null ? -1 : runs.findIndex((r) => r.id === a.after)
      if (at >= 0) {
        const key = String(at)
        if (!builtAfter.has(key)) builtAfter.set(key, doneTasks(runs.slice(Math.max(from, at + 1)), slug, wt, target))
        if ((builtAfter.get(key) ?? []).includes(a.at)) continue
      }
    }
    out.push({ at: a.at, text: a.text, ...(a.role === 'tester' ? { role: 'tester' as const } : {}) })
  }
  return out
}

// Writes the answers this resume used back to the store: a row already stored keeps its `after` and `ts`, a new one gets the
// newest run's id. Rows a resume dropped as built are dropped from the store too.
function saveAnswers(dir: string, slug: string, used: Answer[], runs: WfRun[]): void {
  const old = storedAnswers(dir, slug)
  const newest = runs.length > 0 ? runs[runs.length - 1].id : null
  const now = new Date().toISOString()
  const rows: StoredAnswer[] = used.map((a) => old.find((o) => sameAnswer(o, a)) ?? { at: a.at, text: a.text, ...(a.role === 'tester' ? { role: 'tester' as const } : {}), after: newest, ts: now })
  if (rows.length === 0 && old.length === 0) return
  mkdirSync(CREW_STATE(dir, slug), { recursive: true })
  writeJsonAtomic(ANSWERS_FILE(dir, slug), rows)
}

export function cmdStart(f: Flags): Obj {
  if (f['withdraw-answers'] !== undefined && (f['withdraw-answers'] !== true || str(f, 'answers') === undefined)) throw usage('start --withdraw-answers is a flag that needs --answers F (with --resume answers)')
  const dir = path.resolve(startDirOf(f))
  const repo = path.resolve(repoOf(f))
  useSessionStart(dir, str(f, 'transcript'))
  const roles = rolesWithTypes(PLUGIN, listOf(f, 'type'), configOf(repo).roles)
  const settings = settingsOf(repo, dir)
  const plan = loadPlan(dir)
  excludeScratch(repo)
  const scriptPath = scriptPathAuto(PLUGIN, 'stage.js', str(f, 'scripts-dir'), repo, dir)
  const arch = archPath(repo, plan.architecture)
  const adrDir = `${path.posix.dirname(arch)}/adr`
  const adrs = existsSync(adrDir) ? readdirSync(adrDir).filter((n) => n.endsWith('.md')).sort().map((n) => `${adrDir}/${n}`) : []
  const models = modelsOf(f, roles)
  const ctx: StartCtx = { dir, repo, roles, settings, plan, scriptPath, arch, adrs, models }
  const slugFlag = str(f, 'slug')
  const resumeFlag = str(f, 'resume')
  if (resumeFlag === undefined && slugFlag === undefined) reclaimOrphans(dir, repo, plan, settings.merge, f['no-workflow'] === true)
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
      const wt = claimedWorktree(dir, repo, slug, settings.target)
      if (wt === undefined) continue // another start process claimed this crew first
      crew.status = 'running'
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
      // ADR-0052: stamp the crew as the project manager's, so a later start's reclaim does not take its by-hand running for a dead start's
      patchPlan(dir, (p) => { const e = p.crews.find((x: Obj) => isObj(x) && x.slug === slug); if (e !== undefined && e.status === 'planned') e.engine = 'project-manager' })
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
    const atDeny = acceptanceRefusal(goalFile)
    if (atDeny !== undefined) {
      refused.push({ slug, reason: atDeny })
      continue
    }
    const wt = claimedWorktree(dir, repo, slug, settings.target)
    if (wt === undefined) continue // another start process claimed this crew first
    crew.status = 'running'
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
export function checkArgsFile(f: Flags): void {
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

export function argsFileOut(f: Flags, out: Obj): Obj {
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
