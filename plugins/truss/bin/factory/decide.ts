// The decide and goal-check commands. Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose
// top-level await would make an import cycle.
import path from 'node:path'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { constants as osConstants, tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { CliError, commonDir, flat, isObj, readText, refuse, str, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { localTime } from '../../hooks/register.ts'
import { dirOf, FACTORY, gitOrFail, parseFlags, repoOf, run } from './cli.ts'
import { loadPlan } from './plan-file.ts'
import { settingsFor } from './settings.ts'
import { appendDecision, appendDecisionLine } from './log.ts'
import { heavyMain } from './heavy.ts'

// ==== decide ====

// ADR-0027 F-73: the PM's one route to D/decisions.md. Three forms, exactly one per call:
//   --line '<decision> | <reason> | <checker> | <outcome>'          -> `- HH:MM | <decision> | <reason> | <checker> | <outcome>`
//   --checker <n> --recommend <answer|defer|pass> --text T --outcome O -> `- HH:MM | checker-<n> RECOMMEND <answer>: T | O`
//   --checker <n> --recommend <worth|trim|drop> --text T --outcome O   -> `- HH:MM | checker-<n> WORTH <worth>: T | O` (bug G)
//   --run '<goal>'                                                   -> `## Run <UTC start> | <goal>`
// The clock stamps every line. Each refusal exits 2 and writes nothing; no form writes a continuation line.
const RECOMMENDS = ['answer', 'defer', 'pass']
// A goal item's worth review before planning: plan-args refuses until the run section holds one of these (plan.ts worthGate)
const WORTHS = ['worth', 'trim', 'drop']
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
    const worth = WORTHS.includes(vals.recommend)
    if (!worth && !RECOMMENDS.includes(vals.recommend)) throw usage(`--recommend must be one of ${[...RECOMMENDS, ...WORTHS].join(', ')}, got ${vals.recommend}`)
    if (vals.text.trim() === '') throw usage('--text is empty')
    if (vals.outcome.trim() === '') throw usage('--outcome is empty')
    line = `- ${localTime(Date.now())} | checker-${vals.checker} ${worth ? 'WORTH' : 'RECOMMEND'} ${vals.recommend}: ${vals.text.trim()} | ${vals.outcome.trim()}`
  } else {
    const goal = vals.run.trim()
    if (goal === '') throw usage('--run needs a goal')
    line = `## Run ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} | ${goal}`
  }
  appendDecisionLine(dir, line)
  return { ok: true, form, line }
}
// The goalCheck command a plan names, its label, and the target's commit. Refuses (exit 2) when the plan or goal has no goalCheck.
function goalCheckOf(f: Flags): { dir: string; repo: string; goalId: string | undefined; command: string; label: string; target: string; sha: string } {
  const dir = dirOf(f)
  const repo = repoOf(f)
  const plan = loadPlan(dir)
  const goalId = str(f, 'goal')
  let command: unknown = plan.goalCheck
  if (goalId !== undefined) {
    const g = (Array.isArray(plan.goals) ? plan.goals : []).find((x: Obj) => isObj(x) && x.id === goalId)
    if (!g) throw usage(`no goal ${goalId} in the plan`)
    command = g.goalCheck
  }
  if (typeof command !== 'string' || command.trim() === '') throw usage(goalId === undefined ? 'the plan has no goalCheck' : `goal ${goalId} has no goalCheck`)
  const target = settingsFor(f, repo).target
  const at = str(f, 'at')
  const sha = gitOrFail(repo, ['-c', 'core.quotepath=off', 'rev-parse', '--verify', `${at ?? target}^{commit}`])
  return { dir, repo, goalId, command, label: goalId === undefined ? 'goalCheck' : `goalCheck of ${goalId}`, target, sha }
}

// `goal-check --dir D --repo R [--goal ID]` runs the plan's goalCheck (or the goal's own) at the target head. A goalCheck is a suite
// run, so it goes through the heavy background job (heavyMain, the path green's full suite takes): detached, holding a heavy slot,
// with the slot wait scaled by slotWaitMs, and the caller waits at most HEAVY_ATTACH_MS, under the 600 s Bash limit (0.31.0 item 1).
// A wait that runs out prints `goalCheck still running after N s` and leaves the job running; the same line, run again, collects
// its result. A job past TRUSS_HEAVY_RUN_MS is stopped by the heavy wrapper (ADR-0054), which may SIGKILL goal-check-job before it
// cleans up, so this caller removes the worktree and temp dir the job recorded and logs its decision line (collectGoalCheck).
// A job left behind when the caller goes away is stopped by Claude Code's TaskStop. One JSON line, ok or not.
export async function goalCheckMain(argv: string[]): Promise<{ body: Obj; code: number }> {
  let g: ReturnType<typeof goalCheckOf>
  try {
    g = goalCheckOf(parseFlags(argv))
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
  const slug = g.goalId === undefined ? 'goalcheck' : `goalcheck-${g.goalId}`
  const inner = [process.execPath, ...process.execArgv, FACTORY, 'goal-check-job', '--dir', g.dir, '--repo', g.repo, '--at', g.sha, ...(g.goalId === undefined ? [] : ['--goal', g.goalId])]
  const r = await heavyMain(['--dir', g.dir, '--repo', g.repo, '--slug', slug, '--label', slug, '--cwd', g.repo, '--', ...inner])
  const h = isObj(r.body.heavy) ? r.body.heavy : {}
  const base = { ok: false, goal: g.goalId ?? null, target: g.target, head: g.sha }
  if (h.pending === true) {
    const s = Math.round(Number(h.ageMs ?? h.waitedMs ?? 0) / 1000)
    return { body: { ...base, pending: true, job: h.job, error: `${g.label} still running after ${s} s; run the same goal-check again to wait for its result` }, code: 1 }
  }
  collectGoalCheck(g, h)
  if (h.ran === false) return { body: { ...base, error: `${g.label} did not run: ${String(h.why)}` }, code: 1 }
  const { heavy: _, ...rest } = r.body
  // the run limit stopped the job (ADR-0054): the PM must see timedOut, not a bare failure, and the body may be only a tail
  if (h.timedOut === true) return { body: { ...base, ...rest, ok: false, timedOut: true, limitNote: h.limitNote }, code: r.code === 0 ? 1 : r.code }
  return { body: rest, code: r.code }
}

export async function goalCheckJobMain(argv: string[]): Promise<{ body: Obj; code: number }> {
  try {
    return { body: await cmdGoalCheckJob(parseFlags(argv)), code: 0 }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}

// `goal-check-job --dir D --repo R --at SHA [--goal ID]` (internal, the heavy job goalCheckMain starts): runs the goalCheck with
// `bash -c` in a temporary detached worktree at SHA, never in the main checkout, removes the worktree, and logs one decision line.
// It never pushes or moves a branch, and has no time limit of its own: the heavy job runs it in the background.
// The command runs under spawnSync. When the heavy job stops the group at the run limit (ADR-0054) it SIGKILLs the group after
// KILL_GRACE_MS, so this process may die before its cleanup: it records its temp worktree in goalCheckRecord first, and
// collectGoalCheck (run by goalCheckMain, outside the stopped group) removes what a dead job left and logs the decision line.
export function cmdGoalCheckJob(f: Flags): Obj {
  if (str(f, 'at') === undefined) throw usage('goal-check-job needs --at <sha>; run goal-check instead')
  const { dir, repo, goalId, command, label, target, sha } = goalCheckOf(f)
  const wt = flat(path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'truss-goalcheck-'))), 'wt'))
  const rec = goalCheckRecord(dir, goalId, sha)
  mkdirSync(path.dirname(rec), { recursive: true })
  writeFileSync(rec, JSON.stringify({ wt, label, target, sha }))
  const out = `${path.dirname(wt)}/out.txt`
  let status = 1
  let tail = ''
  try {
    gitOrFail(repo, ['-c', 'core.quotepath=off', 'worktree', 'add', '-q', '--detach', wt, sha])
    // a goal-check started under node --test must not hand NODE_TEST_CONTEXT to a node --test the check runs (it would skip every file)
    const { NODE_TEST_CONTEXT: _, ...env } = process.env
    const fd = openSync(out, 'w')
    let errMsg = ''
    try {
      const r = spawnSync('bash', ['-c', command], { cwd: wt, env, stdio: ['ignore', fd, fd], windowsHide: true })
      if (r.error) errMsg = r.error.message
      status = r.status ?? (r.signal === null ? 1 : 128 + (osConstants.signals[r.signal] ?? 0))
    } finally {
      closeSync(fd)
    }
    tail = `${readFileSync(out, 'utf8')}${errMsg === '' ? '' : `\n${errMsg}`}`.slice(-4000)
  } finally {
    cleanGoalCheck(repo, wt)
  }
  // a run the limit stopped never gets here: SIGTERM ends this process under spawnSync, and collectGoalCheck logs it with the
  // limit the wrapper used (h.limitNote), so the decision line and the JSON give the same number
  appendDecision(dir, `${label} ${status === 0 ? 'passed' : `failed (exit ${status})`} at ${target} ${sha.slice(0, 12)} | run by factory goal-check in a temporary worktree`)
  rmSync(rec, { force: true })
  const body = { ok: status === 0, goal: goalId ?? null, target, head: sha, exit: status, output: tail }
  if (!body.ok) throw refuse(body)
  return body
}

// Where goal-check-job records its temp worktree until it has cleaned up and logged: one file per goal and commit.
function goalCheckRecord(dir: string, goalId: string | undefined, sha: string): string {
  return path.join(dir, 'goalchecks', `${goalId ?? 'plan'}-${sha.slice(0, 12)}.json`.replace(/[^\w.-]/g, '_'))
}

// Removes a goal-check temp worktree (if still registered), prunes, and deletes its temp dir. Safe to run twice.
function cleanGoalCheck(repo: string, wt: string): void {
  run(repo, ['-c', 'core.quotepath=off', 'worktree', 'remove', '--force', wt])
  run(repo, ['-c', 'core.quotepath=off', 'worktree', 'prune'])
  rmSync(path.dirname(wt), { recursive: true, force: true })
}

// Run by goalCheckMain once the heavy job has a result: when the job left its record, it died before cleaning up (the run limit
// SIGKILLed its group), so this removes its worktree and temp dir and logs the decision line the job did not.
function collectGoalCheck(g: { dir: string; repo: string; goalId: string | undefined; label: string; target: string; sha: string }, h: Obj): void {
  const rec = goalCheckRecord(g.dir, g.goalId, g.sha)
  let r: unknown
  try {
    r = JSON.parse(readText(rec) ?? '')
  } catch {
    return
  }
  if (!isObj(r)) return
  const wt = typeof r.wt === 'string' ? r.wt : ''
  // only a temp dir this command made: never delete a path the record merely names
  if (path.basename(wt) === 'wt' && path.basename(path.dirname(wt)).startsWith('truss-goalcheck-')) cleanGoalCheck(g.repo, wt)
  const exit = Number.isInteger(h.exit) ? Number(h.exit) : 1
  const verdict = h.timedOut === true ? `stopped by the run limit (exit ${exit}); ${String(h.limitNote)}` : `failed (exit ${exit}; the job ended before it could clean up)`
  appendDecision(g.dir, `${g.label} ${verdict} at ${g.target} ${g.sha.slice(0, 12)} | run by factory goal-check in a temporary worktree`)
  rmSync(rec, { force: true })
}
