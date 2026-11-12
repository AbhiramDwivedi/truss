// @ts-nocheck
// truss 0.29.0 resume-guard, the lock and CLI half: R-89 "Only one finisher runs per crew" (a crew lease under the truss dir, taken with
// createExclusive: takeLease / refreshLease / releaseLease in bin/store.ts; `finish` and `start --resume` refuse a crew whose lease is
// live) and R-90 "A resume merges the target into the crew branch before the crew restarts" (`start --resume` merges the target in).
//
// Written from the spec before the build. Every case drives bin/factory.ts through the CLI (harness runCli / mkEnv) and loads store.ts
// with a dynamic import inside the case, so the file loads on base code and each case fails for the real reason. Nothing is imported from
// bin/factory.ts. No Windows or macOS host runs this: the platform cases pass the platform option and fixture fs, they do not run there.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import * as nodeFs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  addCrewWorktree, appendEvent, crew, factorySpawn, git, gitStatus, head, mkEnv, mkRun, planObj, putFile, writeGoal, writePlan,
} from './fixtures/workflow-run/harness.ts'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const STORE = path.join(HERE, '..', 'bin', 'store.ts')
const HOUR = 3_600_000
const MIN = 60_000
const CFG = { merge: 'sequential', target: 'main' }
const iso = (ms: number): string => new Date(ms).toISOString()
const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const tmpDir = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'truss-r029-')))
const fsErr = (code: string): Error => Object.assign(new Error(`${code}: injected`), { code })

/** store.ts with the lease exports asserted, so a base-code run fails on the missing export and not on a module-load error. */
async function leaseStore(): Promise<any> {
  const s: any = await import(pathToFileURL(STORE).href)
  for (const n of ['takeLease', 'refreshLease', 'releaseLease', 'LEASE_STALE_MS', 'LEASE_REFRESH_MS']) {
    assert.ok(s[n] !== undefined, `bin/store.ts exports ${n} (R-89: one finisher per crew is a lease taken with createExclusive)`)
  }
  return s
}

const leasePath = (dir: string, name: string): string => path.join(dir, 'locks', `${name}.lease`)
function plantLease(dir: string, name: string, over: Record<string, unknown> = {}): void {
  const now = Date.now()
  mkdirSync(path.join(dir, 'locks'), { recursive: true })
  writeFileSync(leasePath(dir, name), JSON.stringify({ pid: process.pid, host: os.hostname(), since: now, refreshed: now, token: 'planted-token', ...over }))
}
// A pid that is not alive: spawn a child, wait for it to exit, reuse its pid.
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ['-e', ''], { windowsHide: true })
  assert.ok(r.pid > 0)
  return r.pid
}

// ---------------------------------------------------------------------------------------------------------------
// the CLI half: finish and start --resume refuse a crew whose finisher is live

function runningWorld(slug = 'x') {
  const env = mkEnv({ config: CFG })
  writePlan(env.dir, planObj([crew(slug, { status: 'running' })], { approvedAt: iso(Date.now() - 4 * HOUR) }))
  writeGoal(env.dir, slug, {})
  const wt = addCrewWorktree(env.repo, slug)
  appendEvent(env.dir, factorySpawn(slug, iso(Date.now() - 3 * HOUR)))
  return { env, wt }
}
function deadRun(env: any, runId: string, agents: any[], agoMs = 2 * HOUR) {
  const endMs = Date.now() - agoMs
  return mkRun(env.transcripts, runId, agents.map((a) => ({ startTs: iso(endMs - MIN), endTs: iso(endMs), ...a })), { journalMtimeMs: endMs })
}
const member = (task: string, branch: string, marker = 'DONE') => ({ task, marker, branch, commit: 'c0ffee', proof: 'ran it', text: 'ok' })
const answersFile = (dir: string): string => {
  const p = path.join(dir, 'answers.json')
  writeFileSync(p, '[]')
  return p
}

test('a second finish for one crew is refused while its finisher is live', () => {
  const { env } = runningWorld('x')
  const run = deadRun(env, 'wf_fin', [{ label: 'x-builder', metaModel: 'sonnet', effort: 'medium', result: member('t1', 'truss-x') }])
  const resultFile = path.join(tmpDir(), 'result.json')
  writeFileSync(resultFile, JSON.stringify([{ slug: 'x', state: 'passed', text: 'ok' }]))
  plantLease(env.dir, 'finisher-x')
  const r = env.run('finish', { transcript: run.dir, result: resultFile })
  assert.equal(r.status, 1, say(r))
  assert.ok(Array.isArray(r.json?.refused) && r.json.refused.some((e: any) => e.slug === 'x' && e.why === 'finisher live'), `finish refuses crew x with why 'finisher live'; ${say(r)}`)
  assert.ok(!(r.json?.merged ?? []).includes('x'), 'a crew with a live finisher is not merged')
})

test('start --resume is refused while the crew finisher is live', () => {
  const { env } = runningWorld('x')
  const run = deadRun(env, 'wf_res', [{ label: 'x-builder', result: member('t1', 'truss-x', 'BLOCKED') }])
  plantLease(env.dir, 'finisher-x')
  const r = env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile(tmpDir()) })
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json?.why, 'finisher live', say(r))
})

// ---------------------------------------------------------------------------------------------------------------
// the lock itself

test('a finisher lock left by a dead process is recovered', async () => {
  const { takeLease } = await leaseStore()
  const dir = tmpDir()
  const pid = deadPid()
  plantLease(dir, 'finisher-x', { pid, token: 'dead-token' })
  const got = takeLease(dir, 'finisher-x', { host: os.hostname() })
  assert.ok(got !== null && typeof got.token === 'string', `a lease whose pid (${pid}) is dead on this host is recovered; got ${JSON.stringify(got)}`)
  assert.notEqual(got.token, 'dead-token')
  assert.equal(takeLease(dir, 'finisher-x', { host: os.hostname() }), null, 'the recovered lease is live again')
})

test('a finisher lease written by another host is recovered only after its staleness window', async () => {
  const { takeLease, LEASE_STALE_MS } = await leaseStore()
  assert.equal(typeof LEASE_STALE_MS, 'number')
  const dir = tmpDir()
  const t0 = 1_700_000_000_000
  // a live-looking pid (ours) but another host: the pid means nothing here, so only age decides
  plantLease(dir, 'finisher-x', { host: 'some-other-host', since: t0, refreshed: t0 })
  assert.equal(takeLease(dir, 'finisher-x', { host: 'this-host', now: () => t0 + 1000 }), null, 'fresh: refused')
  assert.equal(takeLease(dir, 'finisher-x', { host: 'this-host', now: () => t0 + LEASE_STALE_MS - 1 }), null, 'just inside the window: refused')
  const got = takeLease(dir, 'finisher-x', { host: 'this-host', now: () => t0 + LEASE_STALE_MS + 1 })
  assert.ok(got !== null && typeof got.token === 'string', 'older than the window: taken')
})

test('the finisher lease refresh interval is shorter than its staleness window', async () => {
  const { takeLease, refreshLease, releaseLease, LEASE_STALE_MS, LEASE_REFRESH_MS } = await leaseStore()
  assert.equal(typeof LEASE_STALE_MS, 'number')
  assert.equal(typeof LEASE_REFRESH_MS, 'number')
  assert.ok(LEASE_REFRESH_MS > 0 && LEASE_REFRESH_MS < LEASE_STALE_MS, `refresh ${LEASE_REFRESH_MS} < stale ${LEASE_STALE_MS}`)
  // the refresh keeps a lease live: one refreshed every interval never goes stale, and only the holder's token refreshes it
  const dir = tmpDir()
  const t0 = 1_700_000_000_000
  const mine = takeLease(dir, 'finisher-x', { host: 'h', now: () => t0 })
  assert.ok(mine !== null, 'taken')
  assert.equal(refreshLease(dir, 'finisher-x', 'not-my-token', { now: () => t0 + LEASE_REFRESH_MS }), false, 'a foreign token does not refresh')
  assert.equal(refreshLease(dir, 'finisher-x', mine.token, { now: () => t0 + LEASE_REFRESH_MS }), true)
  assert.equal(JSON.parse(readFileSync(leasePath(dir, 'finisher-x'), 'utf8')).refreshed, t0 + LEASE_REFRESH_MS, 'refreshed is rewritten')
  assert.equal(takeLease(dir, 'finisher-x', { host: 'h2', now: () => t0 + LEASE_REFRESH_MS + LEASE_STALE_MS - 1 }), null, 'refreshed lease is live')
  releaseLease(dir, 'finisher-x', 'not-my-token')
  assert.ok(existsSync(leasePath(dir, 'finisher-x')), 'release removes only its own lease')
  releaseLease(dir, 'finisher-x', mine.token)
  assert.ok(!existsSync(leasePath(dir, 'finisher-x')), 'the holder releases it')
})

const RACE_WORKER = `
import { pathToFileURL } from 'node:url'
const [store, dir, rounds] = process.argv.slice(1)
const { takeLease } = await import(pathToFileURL(store).href)
process.stdout.write('ready\\n')
await new Promise((res) => process.stdin.once('data', res))
const won = []
for (let i = 0; i < Number(rounds); i++) if (takeLease(dir, 'race-' + i) !== null) won.push(i)
process.stdout.write(JSON.stringify(won) + '\\n')
process.exit(0)
`

test('the finisher lock is exclusive across two processes', async () => {
  await leaseStore()
  const dir = tmpDir()
  const script = path.join(tmpDir(), 'race-worker.mjs')
  writeFileSync(script, RACE_WORKER)
  const ROUNDS = 150
  const kids = [0, 1].map(() => {
    const c = spawn(process.execPath, [script, STORE, dir, String(ROUNDS)], { windowsHide: true })
    const st = { out: '', err: '', ready: null as null | (() => void), done: null as any }
    st.done = new Promise((res) => c.on('close', (code) => res(code)))
    st.ready = new Promise<void>((res) => c.stdout.on('data', (d) => { st.out += d; if (st.out.includes('ready\n')) res() }))
    c.stderr.on('data', (d) => (st.err += d))
    return { c, st }
  })
  await Promise.all(kids.map((k) => k.st.ready))
  for (const k of kids) k.c.stdin.write('go\n')
  const codes = await Promise.all(kids.map((k) => k.st.done))
  for (const [i, k] of kids.entries()) assert.equal(codes[i], 0, k.st.err)
  const wins = kids.map((k) => JSON.parse(k.st.out.split('\n').filter((l) => l.startsWith('['))[0]))
  for (let i = 0; i < ROUNDS; i++) {
    const n = wins.filter((w) => w.includes(i)).length
    assert.equal(n, 1, `round ${i}: exactly one process holds the lease, got ${n}`)
  }
})

test('the finisher lock holds under linux, darwin and win32 platform fixtures', async () => {
  const { takeLease, releaseLease } = await leaseStore()
  for (const platform of ['linux', 'darwin', 'win32']) {
    const dir = tmpDir()
    const opts = { platform, host: 'h1' }
    const a = takeLease(dir, 'finisher-x', opts)
    assert.ok(a !== null && typeof a.token === 'string', `${platform}: taken`)
    assert.equal(takeLease(dir, 'finisher-x', opts), null, `${platform}: a live lease holds`)
    assert.ok(!path.relative(dir, leasePath(dir, 'finisher-x')).startsWith('..'), `${platform}: lease sits under the dir`)
    releaseLease(dir, 'finisher-x', a.token, opts)
    const b = takeLease(dir, 'finisher-x', opts)
    assert.ok(b !== null, `${platform}: retaken after release`)
    // a dead pid on the same host is stale under the platform
    plantLease(dir, 'finisher-y', { pid: deadPid(), host: 'h1' })
    assert.ok(takeLease(dir, 'finisher-y', opts) !== null, `${platform}: dead pid recovered`)
    // an age-stale lease by an injected clock
    const t0 = 1_700_000_000_000
    plantLease(dir, 'finisher-z', { host: 'h2', since: t0, refreshed: t0 })
    assert.ok(takeLease(dir, 'finisher-z', { ...opts, now: () => t0 + 24 * HOUR }) !== null, `${platform}: age-stale recovered`)
  }
  // win32: removal of the stale lease first fails with EPERM, then EACCES (a held or AV-scanned file). It never throws out of takeLease
  // and a later call takes the lease.
  for (const code of ['EPERM', 'EACCES']) {
    const dir = tmpDir()
    plantLease(dir, 'finisher-x', { pid: deadPid(), host: 'h1' })
    let injected = 0
    const failFirst = (name: string) => (...a: any[]) => {
      if (injected < 1 && String(a[0]).includes('.lease')) {
        injected++
        throw fsErr(code)
      }
      return (nodeFs as any)[name](...a)
    }
    const fs = { rmSync: failFirst('rmSync'), unlinkSync: failFirst('unlinkSync'), rmdirSync: failFirst('rmdirSync'), renameSync: failFirst('renameSync') }
    let first: any
    assert.doesNotThrow(() => { first = takeLease(dir, 'finisher-x', { platform: 'win32', host: 'h1', fs }) }, `win32 ${code} on removal does not throw out of takeLease`)
    assert.ok(first === null || typeof first?.token === 'string', `win32 ${code}: a token or null`)
    const again = first ?? takeLease(dir, 'finisher-x', { platform: 'win32', host: 'h1' })
    assert.ok(again !== null && typeof again.token === 'string', `win32 ${code}: the stale lease is recovered`)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// R-90: start --resume merges the target into the crew branch

test('start --resume merges the target into the crew branch before it returns', () => {
  const { env, wt } = runningWorld('x')
  putFile(wt, 'crew/a.txt', 'a\n', 'crew a')
  const run = deadRun(env, 'wf_merge', [{ label: 'x-builder', result: member('t1', 'truss-x', 'BLOCKED') }])
  // the target moves after the crew worktree forked
  putFile(env.repo, 'moved/on-main.txt', 'main moved\n', 'main moves on')
  const mainHead = head(env.repo)
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', mainHead, 'truss-x']), 1, 'precondition: the crew branch lacks the new main head')
  const r = env.run('start', { slug: 'x', resume: 'answers', transcript: run.dir, answers: answersFile(tmpDir()) })
  assert.equal(r.status, 0, say(r))
  assert.equal(gitStatus(wt, ['merge-base', '--is-ancestor', mainHead, 'HEAD']), 0, `the crew HEAD contains main's head ${mainHead}; ${say(r)}`)
  assert.equal(git(wt, ['status', '--porcelain']), '', 'the worktree is clean')
})

// ---------------------------------------------------------------------------------------------------------------
// task tests-stage appends the stage.js cases below this line

// R-90 in stage.js: a resumed run syncs with the target before any member. A minimal stubbed-agent harness, modelled on
// workflows.check.ts exec(): stage.js is loaded as text and run as an AsyncFunction; every agent() call is recorded.
const STAGE_JS = path.join(HERE, '..', 'workflows', 'stage.js')
const SHEAD = 'a1'.repeat(20)
const SBASE = 'd4'.repeat(20)
const SPATCH = 'e5'.repeat(20)
const SPASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${SHEAD}\nPatch: ${SPATCH}\n`
const SROLES = {
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}
const sT1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1', after: [] }
const sB1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1', after: ['write-tests'] }
const sDone = (branch: string) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch })
const sEntry = (o: any = {}) => ({
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'], acceptanceTest: 'node --test tests/a.check.ts',
  highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE', worktree: '/wt/a', branch: 'truss/a', base: SBASE, architecture: '/proj/docs/ARCH.md',
  adrs: [], resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const rjson = (obj: any) => ({ exit: 0, stdout: JSON.stringify(obj) })
const tickS = () => new Promise((r) => setImmediate(r))

/** Runs stage.js for one crew entry. `syncs` answers the n-th `sync` runner call (default merged). Returns the ordered timeline of
 *  runner commands (`runner:<cmd>[:<expect>]`) and agent labels, plus the calls with their prompts. */
async function runStageCrew(e: any, syncs: any[] = []) {
  const body = readFileSync(STAGE_JS, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls: any[] = []
  const timeline: string[] = []
  let syncN = 0
  const agent = async (prompt: string, opts: any = {}) => {
    calls.push({ prompt, opts, label: opts.label })
    await tickS()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const mh = prompt.match(/factory\.ts\s+heavy\b([^\n`]*)/)
      const src = mh ? (mh[1].includes(' -- ') ? mh[1].slice(mh[1].indexOf(' -- ') + 4) : '') : prompt
      const m = src.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decision-ack|decisions)\b([^\n`]*)/)
      if (!m) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      const cmd = m[1]
      const expect = (m[2].match(/--expect\s+([^\s`]+)/) || [])[1]
      if (cmd !== 'admit' && cmd !== 'reap') timeline.push(`runner:${cmd}${cmd === 'check' ? ':' + expect : ''}`)
      if (cmd === 'sync') {
        const s = syncs[syncN++]
        if (s !== undefined) return rjson(s)
        return rjson({ merged: true })
      }
      if (cmd === 'admit') return rjson({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
      if (cmd === 'reap') return rjson({ reaped: [], skipped: [] })
      if (cmd === 'check') return rjson(expect === 'red' ? { ok: true } : { ok: true, head: SHEAD })
      if (cmd === 'owns-check') return rjson({ ok: true, outside: [] })
      if (cmd === 'tests-check') return rjson({ ok: true, tests: [] })
      return rjson({ merged: true })
    }
    const labels: any = { 'a-tester': sDone('feat/t'), 'a-builder': sDone('feat/b'), 'a-resolver': sDone('feat/r'), 'a-qc': SPASS }
    if (!Object.hasOwn(labels, opts.label)) throw new Error(`unscripted label: ${opts.label}`)
    timeline.push(`agent:${opts.label}`)
    return structuredClone(labels[opts.label])
  }
  const parallel = async (thunks: any[]) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items: any[], ...stages: any[]) =>
    Promise.all(items.map(async (item, i) => { try { let p = item; for (const st of stages) p = await st(p, item, i); return p } catch { return null } }))
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: path.join(HERE, '..'), target: 'main', reworkAllowance: 2, roles: SROLES, scriptPath: STAGE_JS, crews: [e] } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  return { result, calls, timeline }
}
const firstIdx = (tl: string[], pred: (s: string) => boolean): number => tl.findIndex(pred)
const isMember = (s: string): boolean => s === 'agent:a-tester' || s === 'agent:a-builder'

test('a resumed stage run syncs with the target before any member starts', async () => {
  for (const e of [sEntry({ resume: 'answers', tasks: [sT1, sB1] }), sEntry({ resume: 'stale', tasks: [sT1, sB1] })]) {
    const r = await runStageCrew(e)
    const sync = r.timeline.indexOf('runner:sync')
    const syncCall = r.calls.find((c) => /factory\.ts\s+sync\b/.test(c.prompt))
    assert.ok(sync >= 0, `${e.resume}: sync is run on a resumed run; timeline ${r.timeline.join(' > ')}`)
    assert.ok(syncCall.prompt.includes('sync --slug a'), `${e.resume}: sync --slug a`)
    const members = firstIdx(r.timeline, isMember)
    assert.ok(members >= 0, `${e.resume}: a member ran`)
    assert.ok(sync < members, `${e.resume}: sync before the first member; timeline ${r.timeline.join(' > ')}`)
    const factoryCalls = r.timeline.filter((s) => s.startsWith('runner:') && s !== 'runner:decisions')
    assert.equal(factoryCalls[0], 'runner:sync', `${e.resume}: sync is the first factory call after the decisions restore; ${factoryCalls.join(' > ')}`)
    for (const k of ['runner:check:red']) {
      const i = r.timeline.indexOf(k)
      assert.ok(i < 0 || sync < i, `${e.resume}: sync before ${k}`)
    }
  }
})

test('a target merge conflict on resume goes to the resolver and starts no member', async () => {
  const e = sEntry({ resume: 'answers', tasks: [sT1, sB1] })
  const r = await runStageCrew(e, [{ merged: false, conflicts: ['SYNC-CONFLICT.ts'] }, { merged: true }])
  const syncs = r.timeline.map((s, i) => (s === 'runner:sync' ? i : -1)).filter((i) => i >= 0)
  assert.equal(syncs.length >= 2, true, `sync runs twice (conflict, then again); timeline ${r.timeline.join(' > ')}`)
  const resolver = r.timeline.indexOf('agent:a-resolver')
  assert.ok(resolver > syncs[0] && resolver < syncs[1], `the resolver runs between the two syncs; timeline ${r.timeline.join(' > ')}`)
  const p = r.calls.find((c) => c.label === 'a-resolver').prompt
  assert.ok(p.includes('/wt/a'), 'the resolver works in the crew worktree')
  assert.ok(p.includes('SYNC-CONFLICT.ts'), 'the resolver is told the conflicting file')
  const members = firstIdx(r.timeline, isMember)
  assert.ok(members < 0 || syncs[1] < members, 'no member before the second sync')

  // still not merged after the resolver: BLOCKED at R1, no member spawned
  const r2 = await runStageCrew(e, [{ merged: false, conflicts: ['SYNC-CONFLICT.ts'] }, { merged: false }, { merged: false }])
  assert.equal(r2.result[0].state, 'stopped', JSON.stringify(r2.result[0]))
  assert.equal(r2.result[0].tag, 'BLOCKED')
  assert.equal(r2.result[0].at, 'R1')
  assert.ok(r2.timeline.includes('agent:a-resolver'), 'the resolver ran')
  assert.equal(firstIdx(r2.timeline, isMember), -1, 'no member was spawned')
})
