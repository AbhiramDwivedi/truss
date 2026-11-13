// The heavy and heavy-job commands: a heavy run in a background job that the caller attaches to. Moved unchanged from
// bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { CliError, flat, isObj, need, readText, usage } from '../store.ts'
import type { Obj } from '../store.ts'
import { groupAlive, releaseHeavySlot } from '../../resources/index.ts'
import { acquireSlot, explicitWaitMs, GROUPS, pidAlive, recordHeavyTime, slotsAt, slotWaitMs } from './resources.ts'
import { dirOf, FACTORY, parseFlags, run } from './shared.ts'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// How long the heavy caller waits for its job's result before it returns pending: TRUSS_HEAVY_ATTACH_MS, else 540 s, under the
// 600000 ms Bash timeout stage.js sets. A run that takes longer goes on in the background; the same line, run again, collects it.
export const HEAVY_ATTACH_MS = 540000
const attachMsOf = (env: Record<string, string | undefined> = process.env): number => {
  const v = env.TRUSS_HEAVY_ATTACH_MS
  const n = v === undefined || v.trim() === '' ? NaN : Number(v)
  return Number.isInteger(n) && n >= 0 ? n : HEAVY_ATTACH_MS
}
const JOBS = (dir: string): string => `${dir}/resources/jobs`
const FACTORY_ARG = /(^|[\\/])factory(\.ts)?$/
// The job key: crew, label, worktree, its HEAD and the command, with a factory command's --dir, --repo and --status-line left
// out, so the gates call and stage.js's own heavy line for the same check share one job. A new head is a new job.
function jobKey(slug: string, label: string, cwd: string, cmd: string[]): string {
  const at = cmd.findIndex((a) => FACTORY_ARG.test(a))
  const parts: string[] = []
  const tail = at < 0 ? cmd : cmd.slice(at + 1)
  for (let i = 0; i < tail.length; i++) {
    if (at >= 0 && (tail[i] === '--dir' || tail[i] === '--repo')) i++
    else if (at >= 0 && tail[i] === '--status-line') continue
    else parts.push(tail[i] as string)
  }
  const head = run(cwd, ['rev-parse', 'HEAD'])
  return createHash('sha256').update([slug, label, cwd, head.status === 0 ? head.out : '', ...parts].join('\0')).digest('hex').slice(0, 16)
}
const readObj = (p: string): Obj | undefined => {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

// The one async command: runs argv (after the first `--`) as a background job (heavyJobMain), through the heavy slot unless the
// command is `factory check`, which takes the slot itself and only for a full suite (0.31.0 items 1-2: targeted runs don't take
// it). Waits up to HEAVY_ATTACH_MS for the result; a run still going returns {heavy: {pending: true}} with exit 1.
export async function heavyMain(argv: string[]): Promise<{ body: Obj; code: number }> {
  try {
    const cut = argv.indexOf('--')
    const cmd = cut < 0 ? [] : argv.slice(cut + 1)
    const f = parseFlags(cut < 0 ? argv : argv.slice(0, cut))
    const dir = path.resolve(dirOf(f))
    const slug = need(f, 'slug')
    const label = need(f, 'label')
    const cwd = flat(need(f, 'cwd'))
    if (cmd.length === 0) throw usage('heavy needs a command after --')
    // --dir and --repo are relative to this process's cwd; the child runs in the crew worktree, where a relative
    // .git/truss/... does not exist (.git is a file there), so hand it absolute paths.
    // Only when the command is factory itself; any other command's --dir is its own and passes unchanged.
    const isFactory = cmd.some((a) => FACTORY_ARG.test(a))
    const argv2 = cmd.map((a, i) => (isFactory && i > 0 && (cmd[i - 1] === '--dir' || cmd[i - 1] === '--repo') ? path.resolve(a) : a))
    const at = argv2.findIndex((a) => FACTORY_ARG.test(a))
    const isCheck = at >= 0 && argv2[at + 1] === 'check'
    const explicit = explicitWaitMs(f)
    const slots = slotsAt(cwd)
    const key = jobKey(slug, label, cwd, argv2)
    const jdir = `${JOBS(dir)}/${key}`
    const t0 = Date.now()
    const waitLimit = explicit ?? slotWaitMs(dir)
    // budgetMs: how long the job may take in all, the slot wait plus slotWaitMs for the run itself (slotWaitMs is at least twice
    // the longest recent slot run). stage.js polls a pending job until its age reaches this, so the two never disagree.
    const job = { cmd: argv2, cwd, slug, label, slots, slot: !isCheck, waitLimit, budgetMs: waitLimit + slotWaitMs(dir), ...(explicit !== undefined ? { env: { TRUSS_HEAVY_WAIT_MS: String(explicit) } } : {}) }
    const attach = attachMsOf()
    for (let restarts = 0; ; ) {
      startJob(dir, key, job)
      while (!existsSync(`${jdir}/result.json`) && Date.now() - t0 < attach && jobAlive(jdir)) await sleep(200)
      if (existsSync(`${jdir}/result.json`) || Date.now() - t0 >= attach) break
      // the job died with no result (killed, or the host rebooted): start it once more, then give up
      if (restarts++ >= 1) return { body: { heavy: { label, ran: false, waitedMs: Date.now() - t0, why: 'the heavy job ended without a result' } }, code: 1 }
      rmSync(jdir, { recursive: true, force: true })
    }
    const res = readObj(`${jdir}/result.json`)
    if (res === undefined) {
      // the job as started (this call's or an earlier one's): its start time and budget, not this call's
      const started = readObj(`${jdir}/job.json`) ?? {}
      const ageMs = Date.now() - (typeof started.since === 'number' ? started.since : t0)
      const budgetMs = typeof started.budgetMs === 'number' ? started.budgetMs : job.budgetMs
      const why = `still running after ${Math.round(ageMs / 1000)} s in the background (job ${key}); run the same command again to wait for its result`
      return { body: { heavy: { label, pending: true, job: key, waitedMs: Date.now() - t0, ageMs, budgetMs, why } }, code: 1 }
    }
    try {
      if (res.ran === false) return { body: { heavy: { label, ran: false, waitedMs: res.waitedMs, waitLimitMs: res.waitLimitMs, why: res.why } }, code: 1 }
      const exit = Number.isInteger(res.exit) ? (res.exit as number) : 1
      const stdout = readText(`${jdir}/out.txt`) ?? ''
      let meta: Obj = { label, waitedMs: res.waitedMs, exit, slots }
      let parsed: unknown
      try {
        // a factory child run with --status-line prints its truss-status line after the JSON result; parse the result alone
        parsed = JSON.parse(stdout.replace(/\ntruss-status: [^\n]*\n?$/, '\n'))
      } catch {
        parsed = undefined
      }
      if (isObj(parsed)) {
        // a check that waited out the slot for its full suite reports it as heavy's own busy slot
        if (isObj(parsed.slot) && parsed.slot.ran === false) meta = { ...meta, ran: false, waitedMs: parsed.slot.waitedMs, waitLimitMs: parsed.slot.waitLimitMs, why: parsed.slot.why }
        return { body: { ...parsed, heavy: meta }, code: exit }
      }
      const lines = (stdout + (readText(`${jdir}/err.txt`) ?? '')).split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      return { body: { heavy: meta, tail: lines.slice(-40).join('\n') }, code: exit }
    } finally {
      rmSync(jdir, { recursive: true, force: true })
    }
  } catch (e) {
    if (e instanceof CliError) return { body: e.body, code: e.code }
    return { body: { error: e instanceof Error ? e.message : String(e) }, code: 2 }
  }
}

// A job dir is alive while it has a result or its wrapper's pid runs. The spawner writes pid.json itself the moment spawn returns
// (startJob), so a wrapper slow to start on a loaded host never looks dead. Before that, job.json names the spawner, and the job is
// alive while the spawner runs. A dir with neither file is the instant between mkdir and the job.json write: alive for 10 s.
export function jobAlive(jdir: string): boolean {
  if (existsSync(`${jdir}/result.json`)) return true
  const p = readObj(`${jdir}/pid.json`)
  if (p !== undefined) return pidAlive(p.pid)
  const j = readObj(`${jdir}/job.json`)
  if (j !== undefined) return pidAlive(j.spawner)
  try {
    return Date.now() - statSync(jdir).mtimeMs < 10000
  } catch {
    return false
  }
}

// Makes the job dir (exclusive mkdir) and starts its wrapper, detached so the runner's Bash timeout can't kill it. A live job of
// the same key is attached to, never started twice; a dead one without a result is replaced.
function startJob(dir: string, key: string, job: Obj): void {
  const jdir = `${JOBS(dir)}/${key}`
  mkdirSync(JOBS(dir), { recursive: true })
  try {
    mkdirSync(jdir)
  } catch (e: any) {
    if (e.code !== 'EEXIST') throw e
    if (jobAlive(jdir)) return
    rmSync(jdir, { recursive: true, force: true })
    mkdirSync(jdir)
  }
  writeFileSync(`${jdir}/job.json`, JSON.stringify({ ...job, since: Date.now(), spawner: process.pid }))
  const self = [...process.execArgv, FACTORY, 'heavy-job', '--dir', dir, '--job', key]
  const child = spawn(process.execPath, self, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
  // the spawner records the wrapper's pid, not the wrapper: no window where a live job has no pid on disk
  if (child.pid !== undefined) writeFileSync(`${jdir}/pid.json`, JSON.stringify({ pid: child.pid }))
  else writeFileSync(`${jdir}/result.json`, JSON.stringify({ ran: false, waitedMs: 0, why: 'the heavy job could not be started' }))
}

// `heavy-job --dir D --job KEY` (internal, started by heavyMain): takes the slot when the job needs it, runs the command in its
// own process group with output to the job dir, releases the slot the moment the command ends, records a slot run's time for
// slotWaitMs, and writes result.json last (atomically), which is what the caller waits for.
export async function heavyJobMain(argv: string[]): Promise<{ body: Obj; code: number }> {
  const f = parseFlags(argv)
  const dir = need(f, 'dir')
  const jdir = `${JOBS(dir)}/${need(f, 'job')}`
  const done = (r: Obj): void => {
    writeFileSync(`${jdir}/result.tmp`, JSON.stringify(r))
    renameSync(`${jdir}/result.tmp`, `${jdir}/result.json`)
  }
  const job = readObj(`${jdir}/job.json`)
  if (job === undefined || !Array.isArray(job.cmd) || job.cmd.length === 0) {
    done({ ran: false, waitedMs: 0, why: 'the heavy job has no command' })
    return { body: { ok: false }, code: 1 }
  }
  const slug = String(job.slug)
  const label = String(job.label)
  let token: string | null = null
  try {
    let waitedMs = 0
    if (job.slot === true) {
      const a = acquireSlot(dir, { label, slug }, Number(job.slots), Number(job.waitLimit))
      waitedMs = a.waitedMs
      if (a.token === null) {
        done({ ran: false, waitedMs, waitLimitMs: job.waitLimit, why: `waited ${waitedMs} ms (limit ${job.waitLimit} ms) for the heavy slot and free memory` })
        return { body: { ok: false }, code: 1 }
      }
      token = a.token
    }
    const outFd = openSync(`${jdir}/out.txt`, 'w')
    const errFd = openSync(`${jdir}/err.txt`, 'w')
    const t1 = Date.now()
    let pgid: number | undefined
    const exit = await new Promise<number>((resolve) => {
      const env = { ...process.env, ...(isObj(job.env) ? (job.env as Record<string, string>) : {}) }
      const child = spawn(job.cmd[0], job.cmd.slice(1), { cwd: String(job.cwd), env, detached: true, stdio: ['ignore', outFd, errFd], windowsHide: true })
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
    if (token !== null) {
      releaseHeavySlot(dir, token)
      token = null
      recordHeavyTime(dir, { label, slug, ms: Date.now() - t1 })
    }
    if (pgid !== undefined && !groupAlive(pgid)) rmSync(`${GROUPS(dir)}/${pgid}.json`, { force: true })
    done({ ran: true, exit, waitedMs, ms: Date.now() - t1 })
    return { body: { ok: exit === 0 }, code: 0 }
  } catch (e) {
    done({ ran: false, waitedMs: 0, why: `the heavy job failed: ${e instanceof Error ? e.message : String(e)}` })
    return { body: { ok: false }, code: 1 }
  } finally {
    if (token !== null) releaseHeavySlot(dir, token)
  }
}
