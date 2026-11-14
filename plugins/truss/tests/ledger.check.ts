// @ts-nocheck
// truss 0.25.0 wave 2, b-cost: the merge ledger (contract-025 section 4, ADR-0038). Written from the contract before the code.
// finish and land run as child processes; the 8-process case spawns real children.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import * as reg from '../hooks/register.ts'
import { ledgerAppend } from '../bin/ledger.ts'
import { sharedDir } from '../bin/core.ts'
import { REAL_PLUGIN, addCrewWorktree, appendEvent, crew, factorySpawn, git, head, mkEnv, mkRepo, mkRun, planObj, putFile, qcReport, runCli, tmp, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const WORKER = new URL('./fixtures/cost/ledger-worker.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const MODEL = 'zz-synthetic-model'
// synthetic prices, written into the temp repo's config at test time; never committed
const PRICING = { [MODEL]: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0 } }
const KEYS = ['base', 'costUsd', 'crew', 'goal', 'head', 'kind', 'process', 'qc', 'red', 'session', 'target', 'ts', 'v', 'workType']
const say = (r) => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`
const ledgerOf = (repo) => `${sharedDir(repo)}/ledger.jsonl`
const rowsOf = (repo) => (existsSync(ledgerOf(repo)) ? readFileSync(ledgerOf(repo), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)) : [])

/** Writes one agent transcript of crew `slug` under `root`: `inTok` input and `outTok` output tokens of MODEL, attributed by worktreePath. */
function crewTranscript(root, sid, repo, slug, inTok, outTok) {
  const d = `${root}/proj/${sid}/subagents`
  mkdirSync(d, { recursive: true })
  writeFileSync(`${d}/agent-${slug}1.meta.json`, JSON.stringify({ agentType: 'general-purpose', description: `${slug}-builder`, worktreePath: `${repo}/.claude/worktrees/truss-${slug}` }))
  const line = { type: 'assistant', agentId: `${slug}1`, sessionId: sid, timestamp: new Date().toISOString(), message: { id: 'msg_ledger_1', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  writeFileSync(`${d}/agent-${slug}1.jsonl`, JSON.stringify(line) + '\n')
}

/** A world with a running solo crew `a` holding one commit; `config` is the repo's truss.json. */
function soloWorld(config) {
  const env = mkEnv({ config })
  writePlan(env.dir, planObj([crew('a', { status: 'running', process: 'solo', workType: 'docs' })], { version: 4 }))
  writeGoal(env.dir, 'a')
  const wt = addCrewWorktree(env.repo, 'a')
  putFile(wt, 'src/a/a.ts', 'a\n', 'work a')
  const root = tmp('ledger-tr-')
  return { env, wt, root, land: () => runCli(env.factory, 'land', ['--dir', env.dir, '--repo', env.repo, '--slug', 'a'], env.repo, { TRUSS_TRANSCRIPTS_ROOT: root }) }
}

function patchId(cwd, base, hd) {
  const [diffCmd, idCmd] = reg.PATCH_COMMAND.split(' | ').map((s) => s.replace('<base>', base).replace('<head>', hd).split(' '))
  const d = spawnSync(diffCmd[0], diffCmd.slice(1), { cwd, encoding: 'utf8', windowsHide: true })
  const p = spawnSync(idCmd[0], idCmd.slice(1), { cwd, input: d.stdout, encoding: 'utf8', windowsHide: true })
  return reg.patchIdOf(p.stdout)
}

test('ledger: finish appends one ledger row', () => {
  const env = mkEnv({ config: { merge: 'sequential', target: 'main' } })
  writePlan(env.dir, planObj([crew('s', { status: 'running' })], { approvedAt: '2026-10-01T00:00:00.000Z' }))
  appendEvent(env.dir, factorySpawn('s', new Date(Date.now() - 3 * 3600_000).toISOString()))
  const wt = addCrewWorktree(env.repo, 's')
  putFile(wt, 'src/s/a.ts', 's\n', 'work')
  putFile(wt, 'src/s/final.ts', 'final\n', 'final')
  const base = git(wt, ['merge-base', 'main', 'HEAD'])
  const hd = head(wt)
  mkdirSync(`${env.dir}/checks`, { recursive: true })
  writeFileSync(`${env.dir}/checks/s-1.json`, JSON.stringify({ command: 'true', exit: 1, head: hd, tail: '' }))
  const qc = { label: 's-qc', agentType: 'truss:qc-engineer', metaModel: 'opus', model: 'claude-opus-5-5', effort: 'medium', result: qcReport({ head: hd, patch: patchId(wt, base, hd) }) }
  const run = mkRun(env.transcripts, 'wf_led00000-aaa', [qc])
  const resFile = `${env.dir}/result.json`
  writeFileSync(resFile, JSON.stringify([{ slug: 's', state: 'passed', head: hd, base, qc: 's-qc' }]))
  const empty = tmp('ledger-tr-')
  const r = runCli(env.factory, 'finish', ['--dir', env.dir, '--repo', env.repo, '--transcript', run.dir, '--result', resFile], env.repo, { TRUSS_TRANSCRIPTS_ROOT: empty })
  assert.deepEqual(r.json?.merged, ['s'], say(r))
  const rows = rowsOf(env.repo)
  assert.equal(rows.length, 1, `one ledger row expected: ${JSON.stringify(rows)}`)
  assert.equal(rows[0].kind, 'merge')
  assert.equal(rows[0].crew, 's')
  assert.equal(rows[0].head, git(env.repo, ['rev-parse', 'refs/heads/main']))
})

test('ledger: land appends one ledger row', () => {
  const w = soloWorld({ merge: 'sequential', target: 'main' })
  const r = w.land()
  assert.equal(r.json?.merged, true, say(r))
  const rows = rowsOf(w.env.repo)
  assert.equal(rows.length, 1, `one ledger row expected: ${JSON.stringify(rows)}`)
  assert.equal(rows[0].crew, 'a')
  assert.equal(rows[0].kind, 'merge')
  assert.equal(rows[0].process, 'solo')
  assert.equal(rows[0].workType, 'docs')
  assert.equal(rows[0].head, git(w.env.repo, ['rev-parse', 'refs/heads/main']))
  assert.equal(rows[0].session, w.env.dir.split('/').pop())
})

test('ledger: a priced row has exactly the keys v, ts, kind, session, crew, goal, workType, process, qc, red, target, base, head and costUsd, with kind merge', () => {
  const w = soloWorld({ merge: 'sequential', target: 'main', pricing: PRICING })
  crewTranscript(w.root, w.env.dir.split('/').pop(), w.env.repo, 'a', 1_000_000, 1_000_000)
  const r = w.land()
  assert.equal(r.json?.merged, true, say(r))
  const rows = rowsOf(w.env.repo)
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.deepEqual(Object.keys(rows[0]).sort(), KEYS)
  assert.equal(rows[0].kind, 'merge')
  assert.equal(rows[0].v, 1)
  assert.equal(typeof rows[0].costUsd, 'number')
  assert.ok(Math.abs(rows[0].costUsd - 3) < 1e-9, `1 MTok in at 1 plus 1 MTok out at 2 is 3: ${rows[0].costUsd}`)
})

test('ledger: a crew with no recorded spend gets costUsd null and a costWhy, never 0, and no other extra key', () => {
  const w = soloWorld({ merge: 'sequential', target: 'main', pricing: PRICING })
  const r = w.land()
  assert.equal(r.json?.merged, true, say(r))
  const rows = rowsOf(w.env.repo)
  assert.equal(rows.length, 1, JSON.stringify(rows))
  assert.equal(rows[0].costUsd, null)
  assert.notEqual(rows[0].costUsd, 0)
  assert.equal(typeof rows[0].costWhy, 'string')
  assert.ok(rows[0].costWhy.length > 0)
  assert.deepEqual(Object.keys(rows[0]).sort(), [...KEYS, 'costWhy'].sort())
})

test('ledger: an append leaves every earlier row byte for byte unchanged', () => {
  const repo = mkRepo()
  const row = (n) => ({ v: 1, ts: '2026-11-10T10:00:00.000Z', kind: 'merge', session: 's', crew: `c${n}`, goal: 'g', workType: null, process: 'full', qc: true, red: true, target: 'main', base: 'b', head: 'h', costUsd: null, costWhy: 'not recorded' })
  ledgerAppend(repo, row(1))
  ledgerAppend(repo, row(2))
  const before = readFileSync(ledgerOf(repo), 'utf8')
  assert.equal(before.split('\n').filter((l) => l !== '').length, 2, 'two rows after two appends')
  // a hand-written odd row (key order, spacing) must survive too
  appendFileSync(ledgerOf(repo), '{"v":1,  "kind":"merge","crew":"odd"}\n')
  const odd = readFileSync(ledgerOf(repo), 'utf8')
  ledgerAppend(repo, row(3))
  const after = readFileSync(ledgerOf(repo), 'utf8')
  assert.ok(after.startsWith(odd), 'the earlier bytes are a prefix of the file after an append')
  assert.ok(odd.startsWith(before))
  assert.equal(after.split('\n').filter((l) => l !== '').length, 4)
  assert.ok(after.endsWith('\n'))
})

test('ledger: 8 processes merging at once leave 8 whole rows and lose none', async () => {
  const repo = mkRepo()
  const ledgerTs = `${REAL_PLUGIN}/bin/ledger.ts`
  const run = (i) => new Promise((resolve) => {
    const c = spawn(process.execPath, [WORKER, ledgerTs, repo, `w${i}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', (d) => (out += d))
    c.stderr.on('data', (d) => (err += d))
    c.on('close', (code) => resolve({ code, out, err }))
  })
  const results = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map(run))
  for (const r of results) assert.equal(r.code, 0, `worker failed: ${r.out} ${r.err.slice(0, 400)}`)
  assert.ok(existsSync(ledgerOf(repo)), 'the ledger file exists')
  const text = readFileSync(ledgerOf(repo), 'utf8')
  const lines = text.split('\n').filter((l) => l !== '')
  assert.equal(lines.length, 8, `8 lines expected: ${text.slice(0, 500)}`)
  const rows = lines.map((l) => JSON.parse(l))
  assert.deepEqual(rows.map((x) => x.crew).sort(), ['w0', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'])
  for (const x of rows) assert.equal(x.kind, 'merge')
})
