// @ts-nocheck
// truss 0.26.0 small-fixes crew: regression cases for items 11, 12, 13 and 20 of the goal, written from the spec before the fixes.
// Each case is red on the code before the fix for the reason its body names. The two win32/darwin kill cases run injected `platform` and `ops`
// seams of killTree; no macOS or Windows host ran them. The QC FAIL long-term-cost case belongs to workflows.check.ts-side task tests-wf.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { killTree } from '../bin/notify-run.ts'
import { createExclusive, sharedDir, withLock, writeJsonAtomic } from '../bin/store.ts'
import { REAL_PLUGIN, crew, flat, mkEnv, mkRepo, planObj, pluginCopy, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const REPO_ROOT = path.resolve(REAL_PLUGIN, '../..')
const CONFIG = { architecture: 'docs/architecture.md', adr: 'docs/adr' }
const itemsDir = (repo: string): string => `${flat(sharedDir(repo))}/queue/items`
const items = (repo: string): any[] => {
  const d = itemsDir(repo)
  return existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(`${d}/${n}`, 'utf8'))) : []
}
const byTitle = (repo: string, title: string): any => items(repo).find((i) => i.title === title)
const q = (env: any, command: string, flags: Record<string, string> = {}, extraEnv: Record<string, string> = {}, plugin = env.plugin) => {
  const args: string[] = []
  for (const [k, v] of Object.entries({ dir: env.dir, repo: env.repo, ...flags })) args.push(`--${k}`, String(v))
  return runCli(`${plugin}/bin/factory.ts`, command, args, env.repo, { TRUSS_TRANSCRIPTS_ROOT: env.transcripts, ...extraEnv })
}
const realRepo = (opts: Parameters<typeof mkRepo>[0] = {}): string => flat(realpathSync(mkRepo(opts)))

// ---- item 11: the notify kill ----

test('fixes-026: the notify kill reaches a setsid grandchild', { skip: process.platform !== 'linux' && 'the walk reads /proc and the grandchild is a setsid leader (Linux only)' }, async () => {
  // The parent leads a detached group (as notify-run's child does). Its grandchild is detached too (libuv calls setsid), so it leaves the group.
  // Both hold the write end of the test's stdout pipe: the pipe closes only when the whole tree is dead.
  const code = [
    `const { spawn } = require('node:child_process')`,
    `const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })`,
    `console.log('GRANDCHILD ' + g.pid)`,
    `setInterval(() => {}, 1000)`,
  ].join('\n')
  const parent = spawn(process.execPath, ['-e', code], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  const closed = new Promise<boolean>((resolve) => parent.stdout.on('close', () => resolve(true)))
  let gpid = 0
  try {
    let buf = ''
    gpid = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('the grandchild never reported')), 15000)
      parent.stdout.on('data', (d) => {
        buf += d
        const m = /GRANDCHILD (\d+)/.exec(buf)
        if (m) (clearTimeout(t), resolve(Number(m[1])))
      })
    })
    killTree(parent.pid as number, 'linux', { spawnSync, kill: (p, s) => process.kill(p, s as NodeJS.Signals) })
    const ended = await Promise.race([closed, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 4000))])
    assert.equal(ended, true, `the setsid grandchild ${gpid} outlived killTree`)
  } finally {
    for (const p of [gpid, parent.pid as number]) {
      try { if (p > 0) process.kill(p, 'SIGKILL') } catch { /* already dead */ }
    }
  }
})

/** Ops that record each call; `tree` maps a pid to its children, `pgrep` shapes the walk tool's answer. */
function recorder(tree: Record<number, number[]>, pgrep: 'ok' | 'enoent-result' | 'enoent-throw' = 'ok') {
  const calls: { cmd: string; args: string[] }[] = []
  const kills: { pid: number; signal: string }[] = []
  const ops = {
    spawnSync(cmd: string, args: string[]) {
      calls.push({ cmd, args })
      if (cmd !== 'pgrep') return { status: 0, stdout: '', stderr: '' }
      if (pgrep === 'enoent-throw') throw Object.assign(new Error('spawn pgrep ENOENT'), { code: 'ENOENT' })
      if (pgrep === 'enoent-result') return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawn pgrep ENOENT'), { code: 'ENOENT' }) }
      const kids = tree[Number(args[args.indexOf('-P') + 1])] ?? []
      return { status: kids.length > 0 ? 0 : 1, stdout: kids.map((k) => `${k}\n`).join(''), stderr: '' }
    },
    kill(pid: number, signal: string) {
      kills.push({ pid, signal })
      return true
    },
  }
  return { ops, calls, kills }
}

test('fixes-026: the notify kill walks children with pgrep on the darwin fixture', () => {
  const r = recorder({ 4242: [4300, 4301], 4300: [4400] })
  killTree(4242, 'darwin', r.ops)
  const walked = r.calls.filter((c) => c.cmd === 'pgrep').map((c) => c.args.join(' '))
  assert.ok(walked.includes('-P 4242'), `no pgrep -P 4242 in ${JSON.stringify(r.calls)}`)
  assert.ok(walked.includes('-P 4300'), 'a child is walked too, so a grandchild is found')
  const killed = new Set(r.kills.map((k) => Math.abs(k.pid)))
  for (const p of [4242, 4300, 4301, 4400]) assert.ok(killed.has(p), `pid ${p} was not killed: ${JSON.stringify(r.kills)}`)
  assert.ok(r.kills.every((k) => k.signal === 'SIGKILL'))
  assert.ok(!r.calls.some((c) => c.cmd === 'taskkill'))
})

test('fixes-026: the notify kill falls back safely when the process walk tool is missing', () => {
  for (const mode of ['enoent-result', 'enoent-throw'] as const) {
    const r = recorder({ 4242: [4300] }, mode)
    assert.doesNotThrow(() => killTree(4242, 'darwin', r.ops), mode)
    // new behaviour: the walk was attempted, and its failure left the group kill in place
    assert.ok(r.calls.some((c) => c.cmd === 'pgrep'), `${mode}: pgrep was never tried`)
    assert.ok(r.kills.some((k) => Math.abs(k.pid) === 4242 && k.signal === 'SIGKILL'), `${mode}: the child's group was not killed: ${JSON.stringify(r.kills)}`)
  }
})

test('fixes-026: the notify kill uses taskkill on the win32 fixture', () => {
  // Regression guard: win32 already used taskkill /T /F before the fix (the tree walk is taskkill's own), so this case is green on old code.
  const r = recorder({ 4242: [4300] })
  killTree(4242, 'win32', r.ops)
  assert.deepEqual(r.calls.map((c) => [c.cmd, ...c.args]), [['taskkill', '/T', '/F', '/PID', '4242']])
  assert.deepEqual(r.kills, [])
})

// ---- item 11: inbox id collisions ----

test('fixes-026: a colliding inbox id is redrawn under the lock', () => {
  const repo = realRepo({ config: CONFIG })
  const common = `${repo}/.git`
  // A preload that makes the first two 3-byte draws of every process 'aabbcc' then 'ddeeff': two separate processes both draw aabbcc first.
  const pre = `${tmp('fixes-id-')}/pre.mjs`
  writeFileSync(pre, [
    `import { createRequire, syncBuiltinESMExports } from 'node:module'`,
    `const c = createRequire(import.meta.url)('node:crypto')`,
    `const seq = ['aabbcc', 'ddeeff']`,
    `const real = c.randomBytes`,
    `c.randomBytes = (n, ...r) => (n === 3 && seq.length > 0 ? Buffer.from(seq.shift(), 'hex') : real(n, ...r))`,
    `syncBuiltinESMExports()`,
    '',
  ].join('\n'))
  const nodeOptions = `--import=${pathToFileURL(pre).href}`
  const ids: string[] = []
  for (const n of [1, 2]) {
    const dir = `${common}/truss/sess-${n}`
    mkdirSync(dir, { recursive: true })
    const r = runCli(`${pluginCopy()}/bin/factory.ts`, 'escalate', ['--repo', repo, '--dir', dir, '--kind', 'scope-change', '--title', `collide ${n}`], repo, { NODE_OPTIONS: nodeOptions })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    ids.push(r.json.id)
  }
  assert.match(ids[0], /^E-\d{8}-aabbcc$/, 'the preload drew the first id')
  assert.notEqual(ids[1], ids[0], 'the second item reused the first id')
  const rows = readFileSync(`${sharedDir(repo)}/inbox.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.op === 'open')
  assert.deepEqual(rows.map((r) => r.id), ids, 'two open rows, two distinct ids')
})

// ---- item 12: the queue ----

test('fixes-026: a closed issue leaves the new state', () => {
  const env = mkEnv({ config: { ...CONFIG, intake: { sources: ['gh'] } } })
  const fixture = `${tmp('fixes-gh-')}/issues.json`
  const issue = (n: number) => ({ number: n, title: `issue ${n}`, body: '', url: `https://example.invalid/${n}`, author: { login: 'alice' } })
  writeFileSync(fixture, JSON.stringify({ issues: [issue(1), issue(2)], collaborators: ['alice'] }))
  const first = q(env, 'intake', { source: 'gh' }, { TRUSS_GH_FIXTURE: fixture })
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.equal(byTitle(env.repo, 'issue 2').state, 'new')
  writeFileSync(fixture, JSON.stringify({ issues: [issue(1)], collaborators: ['alice'] })) // issue 2 closed: gh lists open issues only
  const again = q(env, 'intake', { source: 'gh' }, { TRUSS_GH_FIXTURE: fixture })
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.notEqual(byTitle(env.repo, 'issue 2').state, 'new', 'the closed issue is still claimable')
  assert.equal(byTitle(env.repo, 'issue 1').state, 'new', 'the open issue is untouched')
})

test('fixes-026: a ticked line leaves the new state', () => {
  const env = mkEnv({ config: CONFIG, files: { 'docs/queue.md': '- [ ] keep me\n- [ ] tick me\n' } })
  assert.equal(q(env, 'intake', { source: 'md' }).status, 0)
  assert.equal(byTitle(env.repo, 'tick me').state, 'new')
  writeFileSync(`${env.repo}/docs/queue.md`, '- [ ] keep me\n- [x] tick me\n')
  const again = q(env, 'intake', { source: 'md' })
  assert.equal(again.status, 0, again.stdout + again.stderr)
  assert.notEqual(byTitle(env.repo, 'tick me').state, 'new', 'the ticked line is still claimable')
  assert.equal(byTitle(env.repo, 'keep me').state, 'new', 'the unticked line is untouched')
})

test('fixes-026: a held running item does not block the session queue', () => {
  // Reading of "a held running item blocks the session's queue" (c review item 3-6): the session kept an item `running` (unattended step 7, crews
  // held) and its next queue-next call must go on to the next new item instead of handing the running one back for ever.
  const env = mkEnv({ config: CONFIG })
  const session = path.basename(env.dir)
  mkdirSync(itemsDir(env.repo), { recursive: true })
  const plant = (id: string, over: Record<string, unknown>) => writeFileSync(`${itemsDir(env.repo)}/${id}.json`, JSON.stringify({
    v: 1, id, key: `md:${id}`, source: 'md', title: `planted ${id}`, text: `planted ${id}`, url: null, author: null,
    addedAt: '2026-11-01T00:00:00.000Z', state: 'new', session: null, claimedAt: null, history: [], ...over,
  }, null, 2) + '\n')
  plant('Q-aaaaaaaaaaaa', { state: 'running', session, claimedAt: new Date().toISOString() })
  plant('Q-bbbbbbbbbbbb', { addedAt: '2026-11-02T00:00:00.000Z' })
  const r = q(env, 'queue-next')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.json.item?.id, 'Q-bbbbbbbbbbbb', `the running item blocked the queue: ${r.stdout}`)
})

/** A `gh` on PATH that logs each call's args to GH_STUB_LOG and answers `issue list` from GH_STUB_ISSUES (a Node script; win32 gets a .cmd shim). */
function ghStub(): { bin: string; log: string; issues: string } {
  const d = flat(realpathSync(tmp('fixes-ghbin-')))
  const script = `${d}/gh`
  writeFileSync(script, [
    '#!/usr/bin/env node',
    `const fs = require('node:fs')`,
    `const a = process.argv.slice(2)`,
    `fs.appendFileSync(process.env.GH_STUB_LOG, a.join(' ') + '\\n')`,
    `if (a[0] === 'issue') process.stdout.write(fs.readFileSync(process.env.GH_STUB_ISSUES, 'utf8'))`,
    '',
  ].join('\n'))
  chmodSync(script, 0o755)
  writeFileSync(`${d}/gh.cmd`, `@"${process.execPath}" "${script}" %*\r\n`)
  return { bin: d, log: `${d}/calls.log`, issues: `${d}/issues.json` }
}

test('fixes-026: intake reads stored issues in one gh call', () => {
  const env = mkEnv({ config: { ...CONFIG, intake: { sources: ['gh'] } } })
  const gh = ghStub()
  const list = [1, 2, 3].map((n) => ({ number: n, title: `issue ${n}`, body: '', url: `https://example.invalid/${n}`, author: { login: `user${n}` } }))
  writeFileSync(gh.issues, JSON.stringify(list))
  writeFileSync(gh.log, '')
  const e = { PATH: `${gh.bin}${path.delimiter}${process.env.PATH}`, GH_STUB_LOG: gh.log, GH_STUB_ISSUES: gh.issues }
  const first = q(env, 'intake', { source: 'gh' }, e)
  assert.equal(first.status, 0, first.stdout + first.stderr)
  assert.equal(items(env.repo).length, 3, 'the stub gh is on PATH and the issues were stored')
  assert.ok(items(env.repo).every((i) => i.state === 'new'), 'the stub answers every collaborator check with success')
  writeFileSync(gh.log, '')
  const again = q(env, 'intake', { source: 'gh' }, e)
  assert.equal(again.status, 0, again.stdout + again.stderr)
  const calls = readFileSync(gh.log, 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(calls.map((c) => c.split(' ').slice(0, 2).join(' ')), ['issue list'], `stored issues cost more than one gh call: ${JSON.stringify(calls)}`)
})

test('fixes-026: an unchecked intake config source is refused', () => {
  const env = mkEnv({ config: { ...CONFIG, intake: { sources: ['bogus'] } }, files: { 'docs/queue.md': '- [ ] x\n' } })
  const r = q(env, 'intake')
  assert.ok(r.status === 1 || r.status === 2, `a source of truss.json that is neither md nor gh was run: exit ${r.status} ${r.stdout}`)
  assert.match(r.stdout, /bogus|source/i)
  assert.equal(items(env.repo).length, 0)
})

// ---- item 20: factory decide --run on a fresh session ----

test('fixes-026: factory decide run creates the session dir under common truss', () => {
  const repo = realRepo({ config: CONFIG })
  const dir = `${repo}/.git/truss/sess-fresh`
  assert.equal(existsSync(dir), false)
  const r = runCli(`${pluginCopy()}/bin/factory.ts`, 'decide', ['--repo', repo, '--dir', dir, '--run', 'a fresh goal'], repo)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(existsSync(dir), 'decide did not make the session dir')
  assert.match(readFileSync(`${dir}/decisions.md`, 'utf8'), /^## Run \S+ \| a fresh goal$/m)
})

test('fixes-026: factory decide run refuses a dir outside common truss', () => {
  // The refusal exists on old code too, so the negative half is a guard; the new behaviour is that the positive case above makes a dir while these do not.
  const repo = realRepo({ config: CONFIG })
  const elsewhere = flat(realpathSync(tmp('fixes-out-')))
  for (const dir of [`${elsewhere}/truss/sess-x`, `${repo}/.git/other/sess-x`, `${repo}/.git/truss/../escape`]) {
    const r = runCli(`${pluginCopy()}/bin/factory.ts`, 'decide', ['--repo', repo, '--dir', dir, '--run', 'goal'], repo)
    assert.equal(r.status, 2, `${dir}: ${r.stdout}${r.stderr}`)
    assert.match(r.json.error, /--dir is not a directory/)
    assert.equal(existsSync(dir), false, `${dir} was created`)
  }
  assert.equal(existsSync(`${repo}/.git/escape`), false)
  // positive control: the same repo's own session dir is made
  const ok = runCli(`${pluginCopy()}/bin/factory.ts`, 'decide', ['--repo', repo, '--dir', `${repo}/.git/truss/sess-ok`, '--run', 'goal'], repo)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.ok(existsSync(`${repo}/.git/truss/sess-ok`))
})

// ---- item 13: a0 gaps ----

test('fixes-026: a command key cannot shadow a core factory command', () => {
  const d = tmp('fixes-shadow-')
  cpSync(pluginCopy(), d, { recursive: true })
  renameSync(`${d}/bin/queue.ts`, `${d}/bin/queue-real.ts`)
  writeFileSync(`${d}/bin/queue.ts`, [
    `import { QUEUE_COMMANDS as REAL } from './queue-real.ts'`,
    `export * from './queue-real.ts'`,
    `export const QUEUE_COMMANDS = { ...REAL, admit: () => ({ shadowed: true }) }`,
    '',
  ].join('\n'))
  const r = runCli(`${d}/bin/factory.ts`, 'admit', [], d)
  assert.ok(!/"shadowed":\s*true/.test(r.stdout), 'the plugin command replaced core admit silently')
  assert.notEqual(r.status, 0)
  assert.match(r.stdout + r.stderr, /admit/, 'the failure does not name the shadowed key')
})

test('fixes-026: orphan tmp files are swept', () => {
  const dir = flat(realpathSync(tmp('fixes-tmp-')))
  const dead = spawnSync(process.execPath, ['-e', '']).pid as number
  const old = new Date(Date.now() - 3600_000)
  const orphan = `${dir}/state.json.${dead}-${randomUUID()}.tmp`
  const live = `${dir}/other.json.${process.pid}-${randomUUID()}.tmp`
  writeFileSync(orphan, '{')
  utimesSync(orphan, old, old)
  writeFileSync(live, '{')
  // the store sweeps on its writes and locks: touch all three entry points
  withLock(dir, 'sweep', () => undefined)
  writeJsonAtomic(`${dir}/state.json`, { n: 1 })
  createExclusive(`${dir}/once.json`, { n: 1 })
  assert.equal(existsSync(orphan), false, 'the orphan tmp of a dead writer is still there')
  assert.equal(existsSync(live), true, 'a tmp of a live writer was swept')
  assert.deepEqual(JSON.parse(readFileSync(`${dir}/state.json`, 'utf8')), { n: 1 })
})

test('fixes-026: an ownerless lock clears inside the default wait', () => {
  const dir = flat(realpathSync(tmp('fixes-lock-')))
  const lock = `${dir}/locks/x.lock`
  mkdirSync(lock, { recursive: true }) // no owner.json: a writer died between mkdir and the owner write
  // 2 s old: the default 5 s wait ends at 7 s of age, short of the 10 s ownerless limit, so old code reports StoreBusy
  const two = new Date(Date.now() - 2000)
  utimesSync(lock, two, two)
  const t0 = Date.now()
  let got: unknown
  try {
    got = withLock(dir, 'x', () => 'held')
  } catch (e) {
    assert.fail(`StoreBusy after ${Date.now() - t0} ms on a 2 s old ownerless lock: ${(e as Error).message}`)
  }
  assert.equal(got, 'held')
})

test('fixes-026: repeated admits under one budget hold write one event', () => {
  const env = mkEnv({ config: { ...CONFIG, budget: { sessionUsd: 1 } } })
  const d = tmp('fixes-budget-')
  cpSync(pluginCopy(), d, { recursive: true })
  const lay = (name: string, override: string): void => {
    renameSync(`${d}/bin/${name}.ts`, `${d}/bin/${name}-real.ts`)
    writeFileSync(`${d}/bin/${name}.ts`, `export * from './${name}-real.ts'\n${override}`)
  }
  lay('cost', `export function budgetVerdict() { return { held: true, scope: 'session', spentUsd: null, limitUsd: 1, why: 'the session budget of 1 USD is spent' } }\n`)
  lay('inbox', `export function escalate(repo, dir, input) { return { id: 'E-20261110-a1b2c3', kind: input.kind, deduped: false, code: 'ABCDEF', notified: null } }\n`)
  writePlan(env.dir, planObj([crew('alpha')]))
  for (let i = 0; i < 3; i++) {
    const r = runCli(`${d}/bin/factory.ts`, 'admit', ['--dir', env.dir, '--repo', env.repo, '--slug', 'alpha'], env.repo)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.equal(r.json.budget, true, 'the hold is a budget hold every time')
  }
  const holds = readFileSync(`${env.dir}/events.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'budget-hold')
  assert.equal(holds.length, 1, `${holds.length} budget-hold events for one hold`)
})

// ---- item 6: the feature map ----

test('fixes-026: the feature map states the sessionUsd ruling', () => {
  const text = readFileSync(`${REPO_ROOT}/docs/features.md`, 'utf8')
  const start = text.indexOf('## Cost meter and budgets')
  assert.ok(start >= 0, 'the Cost meter and budgets entry is gone')
  const rest = text.slice(start + 3)
  const end = rest.search(/\n## /)
  const entry = end < 0 ? rest : rest.slice(0, end)
  assert.match(entry, /(?<!un)attended[^.\n]*\bcapped by `sessionUsd`/i, 'the entry does not say attended sessions are capped by sessionUsd')
  assert.match(entry, /one typed raise/i, 'the entry does not say one typed raise lifts the hold')
})

// ---- item 13: a QC FAIL keeps its long-term costs (stubbed agents; the exec helper is a minimal copy of workflows.check.ts exec) ----

const ROLES_026 = {
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}

async function runStage026(labels: Record<string, any>) {
  const HEAD = 'a1'.repeat(20)
  const stagePath = `${flat(REAL_PLUGIN)}/workflows/stage.js`
  const body = readFileSync(stagePath, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const rj = (obj: any) => ({ exit: 0, stdout: JSON.stringify(obj) })
  const unscripted: string[] = []
  const agent = async (prompt: string, opts: any = {}) => {
    await new Promise((r) => setImmediate(r))
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const mh = prompt.match(/factory\.ts\s+heavy\b([^\n`]*)/)
      let m: any = null
      if (mh) {
        const cut = mh[1].indexOf(' -- ')
        m = cut >= 0 ? mh[1].slice(cut + 4).match(/factory\.ts\s+(check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/) : null
      } else {
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decision-ack|decisions)\b([^\n`]*)/)
      }
      if (!m) throw new Error(`unparsable runner prompt for label ${opts.label}`)
      const expect = (m[2].match(/--expect\s+([^\s`]+)/) || [])[1]
      const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
      return m[1] === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 })
        : m[1] === 'reap' ? rj({ reaped: [], skipped: [] })
        : m[1] === 'check' ? rj(mh ? { ...plain, heavy: { label: 'a-check', waitedMs: 0, exit: 0 } } : plain)
        : m[1] === 'owns-check' ? rj({ ok: true, outside: [] })
        : m[1] === 'tests-check' ? rj({ ok: true, tests: [] })
        : rj({ merged: true })
    }
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    return structuredClone(labels[opts.label])
  }
  const parallel = async (thunks: any[]) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (list: any[], ...stages: any[]) => Promise.all(list.map(async (item, i) => {
    try { let prev = item; for (const st of stages) prev = await st(prev, item, i); return prev } catch { return null }
  }))
  const crewEntry = {
    slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
    acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
    worktree: '/wt/a', branch: 'truss/a', base: 'd4'.repeat(20), architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
    resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
  }
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: flat(REAL_PLUGIN), target: 'main', reworkAllowance: 0, roles: ROLES_026, scriptPath: stagePath, crews: [crewEntry] } }
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  assert.deepEqual(unscripted, [], `unscripted label(s): ${unscripted.join(', ')}`)
  return result
}

test('fixes-026: a QC FAIL still returns its long-term costs', async () => {
  const L1 = 'LONG-TERM-COST: new public flag --x | later: every caller keeps it | reversal: costly'
  const L2 = 'LONG-TERM-COST: new dependency foo | later: upgrades | reversal: cheap'
  const qcText = `VERDICT: FAIL\n\n## Findings\n- FINDING-1: broken\n\n## Notes\n${L1}\n  - ${L2}\n`
  const task = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1', after: [] }
  const done = (branch: string) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF', text: `finished ${branch}` })
  const res = (await runStage026({
    'a-planner': { tasks: [task], stop: null }, 'a-tester': done('feat/t'), 'a-builder': done('feat/b'), 'a-qc': qcText,
  }))[0]
  // rework allowance 0: the FAIL ends the crew without a fix round, so it is stopped (BLOCKED at qc), not passed
  assert.notEqual(res.state, 'passed', JSON.stringify(res))
  assert.ok(Array.isArray(res.longTermCosts), `a failed crew's result has no longTermCosts: ${JSON.stringify(res)}`)
  assert.equal(res.longTermCosts.length, 2, JSON.stringify(res.longTermCosts))
  assert.ok(res.longTermCosts[0].includes(L1), res.longTermCosts[0])
  assert.ok(res.longTermCosts[1].includes(L2), res.longTermCosts[1])
})
