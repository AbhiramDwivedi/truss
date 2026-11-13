// The plan commands: settings, plan-args, plan-write, plan-check and approve. Moved unchanged from bin/factory.ts (0.31.0
// item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { configOf, isObj, need, readText, refuse, str, usage, withLock } from '../store.ts'
import type { Flags, Obj } from '../store.ts'
import { profilesOf, workTypeErrors } from '../worktypes.ts'
import { fencedBlock, parsePlan } from '../../hooks/register.ts'
import { ltcPlan, ltcPlanGate } from '../guard.ts'
import { goalOf, RUN_GOAL } from '../../hooks/intake.ts'
import { stripBlanketSuite } from '../testmap.ts'
import { approvalProof, confirmApproval, onPlanApprove } from '../inbox.ts'
import { buildPersonas, parsePersonaFile, PERSONA_KEBAB, personaFault } from './personas.ts'
import { excludeScratch, retireBranch, retireWorktree, worktreesOf } from './retire.ts'
import type { RetireCtx, RetireWhy } from './retire.ts'
import { runOf } from './runs.ts'
import { appendDecision, archPath, dirOf, docKeysOf, intOr, knowledgeArgsOf, loadPlan, patchPlan, PLUGIN, repoOf, rolesWithTypes, run, savePlan, scriptPathFor, sessionScriptsDir, settingsOf } from './shared.ts'
import { goalSections, uxSaysOff } from './start.ts'

export function cmdSettings(f: Flags): Obj {
  return settingsOf(repoOf(f))
}

export function cmdPlanArgs(f: Flags): Obj {
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
      scriptPath: scriptPathFor(PLUGIN, 'plan.js', str(f, 'scripts-dir') ?? sessionScriptsDir(repo, dir)), personas: buildPersonas(repo).personas, workTypes: profilesOf(cfg).profiles,
      ...(existsSync(`${repo}/${featureMap}`) ? { featureMap } : {}),
      ...knowledgeArgsOf(repo, false),
    },
    brief,
  }
}

// The result text of the agent labelled `label` in a run: the last `result` journal line; a schema result is its `report` field.
export function cmdPlanWrite(f: Flags): Obj {
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
  const fencedMd = fencedBlock(message, '````markdown plan.md')
  // a stub or pointer field ("See plan.json.") is shorter than the fenced block and has no crew table: the fenced plan wins then
  const hasTable = (s: string): boolean => /^\s*\|.*\|\s*$/m.test(s)
  const stubMd = fieldMd !== undefined && fencedMd !== undefined && fieldMd.length < fencedMd.length && hasTable(fencedMd) && !hasTable(fieldMd)
  const md = fieldMd !== undefined && !stubMd ? fieldMd : fencedMd
  if (json === undefined || md === undefined) no(json === undefined ? 'no plan.json block' : 'no plan.md block')
  if (parsePlan(json as string) === undefined) no('the plan.json block is not a plan')
  const carried = JSON.parse((json as string).startsWith('﻿') ? (json as string).slice(1) : (json as string))
  if (!isObj(carried)) no('the plan.json block is not an object')
  // An unapproved plan is overwritten; an approved one with a running or planned crew is refused; otherwise (archive) it moves to plan-<approvedAt>.json/.md.
  // seen is the approvedAt the unlocked check saw; an approve that lands after it (a different value) is refused, never archived.
  const keepExisting = (archive: boolean, seen: unknown = null): unknown => {
    if (!existsSync(`${dir}/plan.json`)) return null
    let existing
    try {
      existing = parsePlan(readFileSync(`${dir}/plan.json`, 'utf8'))
    } catch {
      return no('kept the existing plan: it could not be read')
    }
    if (existing === undefined) return no('kept the existing plan: it is not a readable plan')
    if (existing.approvedAt === null) return null
    if (archive && existing.approvedAt !== seen) return no('kept the existing plan: it is approved')
    const live = existing.crews.filter((c: Obj) => c.status === 'running' || c.status === 'planned')
    if (live.length > 0) return no(`kept the existing plan: crew ${live.map((c: Obj) => String(c.slug)).join(', ')} of the earlier run is ${live.some((c: Obj) => c.status === 'running') ? 'running' : 'planned, not finished'}`)
    if (!archive) return existing.approvedAt
    const stamp = String(existing.approvedAt).replace(/[^A-Za-z0-9]/g, '').slice(0, 20) || 'run'
    let name = `plan-${stamp}`
    for (let n = 2; existsSync(`${dir}/${name}.json`) || existsSync(`${dir}/${name}.md`); n++) name = `plan-${stamp}-${n}`
    renameSync(`${dir}/plan.json`, `${dir}/${name}.json`)
    if (existsSync(`${dir}/plan.md`)) renameSync(`${dir}/plan.md`, `${dir}/${name}.md`)
    return existing.approvedAt
  }
  const seenApproved = keepExisting(false)
  // test-only sync point (unset in production): after the unlocked first check, write <gate>/checked, then wait for <gate>/go; a timeout fails closed
  const gate = process.env.TRUSS_TEST_PLAN_WRITE_GATE
  if (gate !== undefined && gate !== '') {
    writeFileSync(`${gate}/checked`, '')
    const until = Date.now() + 30000
    while (!existsSync(`${gate}/go`)) {
      if (Date.now() > until) no('kept the existing plan: the test gate timed out')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
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
    keepExisting(true, seenApproved)
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
export const SLUG = /^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$/

export function cmdPlanCheck(f: Flags): Obj {
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
  // a bare-directory owns entry (`dir/`) is read as `dir/**` by owns-check and the stage split; say so, so a plan that meant it is explicit
  for (const c of crews) for (const g of Array.isArray(c.owns) ? c.owns : []) if (typeof g === 'string' && g.endsWith('/')) warnings.push(`crew ${name(c)}: owns entry ${g} is a bare directory, read as ${g}**; write ${g}** to say so`)
  // 0.31.0 item 1: the green check runs the tests the diff reaches and the full suite runs before merge, so a trailing whole-suite
  // step only slows every check; factory check cuts it (stripBlanketSuite), and the plan should drop it
  for (const c of crews) if (typeof c.acceptanceTest === 'string' && stripBlanketSuite(c.acceptanceTest).blanket) warnings.push(`crew ${name(c)}: the acceptance test ends with the whole test suite (npm test); the green check runs the tests the diff reaches and the full suite runs before merge, so drop that step`)
  // R-132: a file owned (by exact path, not glob) by more than half of a goal's crews, in a goal of 3 crews or more, is a hotspot
  const byGoal = new Map<string, any[]>()
  for (const c of crews) byGoal.set(goalOf(c), [...(byGoal.get(goalOf(c)) ?? []), c])
  for (const [g, gc] of byGoal) {
    if (gc.length < 3) continue
    const owners = new Map<string, Set<string>>()
    for (const c of gc) for (const o of Array.isArray(c.owns) ? c.owns : []) if (typeof o === 'string' && !/[*?[\]{}]/.test(o) && !o.endsWith('/')) owners.set(o, (owners.get(o) ?? new Set()).add(name(c)))
    for (const [p, s] of owners) if (s.size * 2 > gc.length) warnings.push(`hotspot: ${p} is owned by ${s.size} of ${gc.length} crews${g === RUN_GOAL ? '' : ` of goal ${g}`}; propose a refactor goal first or one crew that owns it instead of serial merges`)
  }
  return { ok: true, unproved: crews.filter((c) => c.acceptanceTestProved === false).map(name), warnings }
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

export function cmdApprove(f: Flags): Obj {
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
