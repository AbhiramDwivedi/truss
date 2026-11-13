// The decide and goal-check commands. Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose
// top-level await would make an import cycle.
import path from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { commonDir, flat, isObj, refuse, str, usage } from '../store.ts'
import type { Flags, Obj } from '../store.ts'
import { localTime } from '../../hooks/register.ts'
import { appendDecision, appendDecisionLine, dirOf, gitOrFail, loadPlan, repoOf, run, settingsOf } from './shared.ts'

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
// The goalCheck time limit: 10 minutes, or TRUSS_GOALCHECK_TIMEOUT_MS (a positive integer) when set.
export function goalCheckLimitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TRUSS_GOALCHECK_TIMEOUT_MS)
  return Number.isInteger(n) && n > 0 ? n : 600000
}
// goalCheckSupervisor: argv = command, cwd, limit ms. Runs `bash -c command`, keeps the last 4000 characters of its output and, at
// the limit, kills the whole process tree: the child leads its own process group on POSIX (kill -pid), and on Windows
// `taskkill /T /F` ends the tree. Prints one JSON line {status, timedOut, tail}.
const GOALCHECK_SUPERVISOR = `
const { spawn, spawnSync } = require('node:child_process')
const [command, cwd, limit] = process.argv.slice(1)
const win = process.platform === 'win32'
const c = spawn('bash', ['-c', command], { cwd, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let tail = ''
let timedOut = false
let done = false
const add = (b) => { tail = (tail + b).slice(-4000) }
c.stdout.on('data', add)
c.stderr.on('data', add)
const killTree = () => {
  try {
    if (win) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-c.pid, 'SIGKILL')
  } catch {}
}
const timer = setTimeout(() => { timedOut = true; killTree() }, Number(limit))
const finish = (status) => {
  if (done) return
  done = true
  clearTimeout(timer)
  if (!timedOut) killTree()
  console.log(JSON.stringify({ status, timedOut, tail }))
  process.exit(0)
}
c.on('error', (e) => { add(e.message + '\\n'); finish(1) })
c.on('exit', (code) => { setTimeout(() => finish(code === null ? 1 : code), timedOut ? 0 : 50) })
`
// `goal-check --dir D --repo R [--goal ID]` runs the plan's goalCheck (or the goal's own) at the target head in a temporary detached
// worktree, never in the main checkout, and never pushes or moves a branch. One JSON line, one decision line, ok or not.
export function cmdGoalCheck(f: Flags): Obj {
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
  const target = settingsOf(repo).target
  const sha = gitOrFail(repo, ['-c', 'core.quotepath=off', 'rev-parse', '--verify', `${target}^{commit}`])
  const wt = flat(path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'truss-goalcheck-'))), 'wt'))
  const label = goalId === undefined ? 'goalCheck' : `goalCheck of ${goalId}`
  let status = 1
  let tail = ''
  let added = false
  let timedOut = false
  try {
    gitOrFail(repo, ['-c', 'core.quotepath=off', 'worktree', 'add', '-q', '--detach', wt, sha])
    added = true
    const limit = goalCheckLimitMs()
    // the check runs under a small node supervisor (goalCheckSupervisor), so the whole process tree can be killed at the limit
    const r = spawnSync(process.execPath, ['-e', GOALCHECK_SUPERVISOR, command, wt, String(limit)], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: limit + 30000 })
    let v: Obj | undefined
    try {
      v = JSON.parse(r.stdout)
    } catch {}
    if (v === undefined) {
      status = 1
      tail = `${r.error ? `${r.error.message}\n` : ''}${r.stderr ?? ''}`.slice(-4000)
    } else {
      status = typeof v.status === 'number' ? v.status : 1
      tail = String(v.tail ?? '').slice(-4000)
      if (v.timedOut === true) {
        timedOut = true
        status = 1
      }
    }
  } finally {
    if (added) run(repo, ['-c', 'core.quotepath=off', 'worktree', 'remove', '--force', wt])
    run(repo, ['-c', 'core.quotepath=off', 'worktree', 'prune'])
    rmSync(path.dirname(wt), { recursive: true, force: true })
  }
  const error = timedOut ? `${label} timed out after ${Math.round(goalCheckLimitMs() / 1000)} s and was killed` : undefined
  appendDecision(dir, `${label} ${status === 0 ? 'passed' : timedOut ? `timed out (${Math.round(goalCheckLimitMs() / 1000)} s)` : `failed (exit ${status})`} at ${target} ${sha.slice(0, 12)} | run by factory goal-check in a temporary worktree`)
  const body = { ok: status === 0, goal: goalId ?? null, target, head: sha, exit: status, ...(error ? { error } : {}), output: tail }
  if (status !== 0) throw refuse(body)
  return body
}
