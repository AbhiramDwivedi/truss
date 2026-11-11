// @ts-nocheck
// truss 0.25.0 wave 2, b-cost: the spend meter, budget holds and `factory cost` (contract-025 section 4, ADR-0038). Written before the code, so
// it is red against the A0 stub bin/cost.ts. Fixtures are synthetic transcripts in tests/fixtures/cost/ (no real price anywhere): the test
// writes a synthetic price table into a temp .claude/truss.json at test time. One rate unit per million tokens, so 1 000 000 tokens cost
// exactly the rate:
//   main.jsonl (test-model): m1 2.1 (three content-block lines), m3 fast 3.0, m4 test-model-long-1 4.0 (a <synthetic> row, two cost-state
//     lines 3.5 then 9.0, and a torn last line msg_torn that completes to 1.0)   -> 9.1
//   agent-wf 2.0 (two lines, one msg_w1), agent-wt 2.0, agent-late 1.0           -> 14.1 with main
//   budget-crew (test-model-budget) 5.2
// Assumed signatures the builder must offer: cost.sweep(dir, repo, { platform }) -> { rows, files, bad, found } (platform defaults to
// process.platform) and the sweep cursor as a JSON file in the session dir whose object keys that hold a "/" are the transcript paths.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REAL_PLUGIN, assertOneLine, crew, highSampleFile, mkRepo, mkTrussDir, planObj, pluginCopy, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const FIX = fileURLToPath(new URL('./fixtures/cost/', import.meta.url))
const FACTORY = `${REAL_PLUGIN}/bin/factory.ts`
const ALL_IDS = ['msg_l1', 'msg_m1', 'msg_m3', 'msg_m4', 'msg_t1', 'msg_w1']
const TORN_SUFFIX = ',"cache_read_input_tokens":0}}}\n'
const rp = (p: string): string => realpathSync(p).replace(/\\/g, '/')
const near = (a: unknown, b: number, what: string): void => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, `${what}: expected ${b}, got ${a}`)

// ---- the synthetic price table (test time only) ----
const P = (i: number, o: number, cr: number, c5: number, c1: number, fast?: unknown) => ({ inputPerMTok: i, outputPerMTok: o, cacheReadPerMTok: cr, cacheWrite5mPerMTok: c5, cacheWrite1hPerMTok: c1, ...(fast ? { fast } : {}) })
const FAST = { inputPerMTok: 10, outputPerMTok: 20, cacheReadPerMTok: 1, cacheWrite5mPerMTok: 15, cacheWrite1hPerMTok: 25 }
function pricing(o: { fastScale?: number; long?: boolean; scale?: number } = {}): Record<string, unknown> {
  const k = o.scale ?? 1
  const fast = Object.fromEntries(Object.entries(FAST).map(([a, b]) => [a, b * (o.fastScale ?? 1) * k]))
  const out: Record<string, unknown> = {
    'test-model': P(1 * k, 2 * k, 0.1 * k, 1.5 * k, 2.5 * k, fast),
    'test-model-budget': P(1 * k, 2 * k, 0.6 * k, 1 * k, 1 * k),
  }
  if (o.long !== false) out['test-model-long'] = P(4 * k, 8 * k, 0.4 * k, 6 * k, 10 * k)
  return out
}
const cfg = (extra: Record<string, unknown> = {}) => ({ architecture: 'docs/architecture.md', adr: 'docs/adr', ...extra })

// ---- a world: temp repo, session dir, transcripts root ----
type W = { repo: string; dir: string; sid: string; root: string; key: string; env: Record<string, string> }
function world(o: { config?: unknown; crews?: string[]; key?: string } = {}): W {
  const repo = rp(mkRepo({ config: o.config ?? cfg() }))
  const dir = rp(mkTrussDir())
  const root = rp(tmp('cost-tr-'))
  if (o.crews) writePlan(dir, planObj(o.crews.map((s) => crew(s))))
  return { repo, dir, sid: path.basename(dir), root, key: o.key ?? '-work-proj', env: { TRUSS_TRANSCRIPTS_ROOT: root } }
}
const wtOf = (w: W, slug: string): string => `${w.repo}/.claude/worktrees/truss-${slug}`
const WHERE: Record<string, string> = {
  main: '',
  wf: 'subagents/workflows/wf_1/agent-wf1',
  wt: 'subagents/agent-wt1',
  late: 'subagents/agent-late1',
  budget: 'subagents/agent-bcrew',
}
const FILE: Record<string, string> = { wf: 'agent-wf', wt: 'agent-wt', late: 'agent-late', budget: 'budget-crew' }
function lay(w: W, names: string[], o: { lateMeta?: boolean } = {}): void {
  for (const n of names) {
    if (n === 'main') {
      mkdirSync(`${w.root}/${w.key}`, { recursive: true })
      writeFileSync(`${w.root}/${w.key}/${w.sid}.jsonl`, readFileSync(`${FIX}main.jsonl`))
      continue
    }
    const base = `${w.root}/${w.key}/${w.sid}/${WHERE[n]}`
    mkdirSync(path.dirname(base), { recursive: true })
    writeFileSync(`${base}.jsonl`, readFileSync(`${FIX}${FILE[n]}.jsonl`))
    if (n === 'late' && o.lateMeta === false) continue
    meta(w, n)
  }
}
function meta(w: W, n: string): void {
  const base = `${w.root}/${w.key}/${w.sid}/${WHERE[n]}`
  writeFileSync(`${base}.meta.json`, readFileSync(`${FIX}${FILE[n]}.meta.json`, 'utf8').replace('@@WORKTREE@@', wtOf(w, 'wtcrew')))
}
const mainPath = (w: W): string => `${w.root}/${w.key}/${w.sid}.jsonl`

const cost = (w: W, extra: string[] = []) => runCli(FACTORY, 'cost', ['--dir', w.dir, '--repo', w.repo, ...extra], w.repo, w.env)
const admit = (w: W, slug: string, extra: string[] = [], factory = FACTORY) => runCli(factory, 'admit', ['--dir', w.dir, '--repo', w.repo, '--slug', slug, ...extra], w.repo, w.env)
function usageRows(w: W): any[] {
  const p = `${w.dir}/usage.jsonl`
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const idsOf = (w: W): string[] => usageRows(w).map((r) => r.msgId).sort()
const crewOf = (j: any, slug: string): any => (j?.crews ?? []).find((c: any) => c.crew === slug)
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const e of readdirSync(`${dir}/${rel}`, { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...listFiles(dir, r))
    else out.push(r)
  }
  return out
}
const cursorsAfter = (w: W, before: string[]): string[] => listFiles(w.dir).filter((f) => !before.includes(f) && f !== 'usage.jsonl' && !f.startsWith('locks/'))

/** Runs f with the transcripts root of w in process.env (the in-process cost.ts calls read it). */
function withRoot<T>(w: W, f: () => T): T {
  const old = process.env.TRUSS_TRANSCRIPTS_ROOT
  process.env.TRUSS_TRANSCRIPTS_ROOT = w.root
  try {
    return f()
  } finally {
    if (old === undefined) delete process.env.TRUSS_TRANSCRIPTS_ROOT
    else process.env.TRUSS_TRANSCRIPTS_ROOT = old
  }
}
const realCost = async (): Promise<any> => import(pathToFileURL(`${REAL_PLUGIN}/bin/cost.ts`).href)
const planOf = (w: W): any => JSON.parse(readFileSync(`${w.dir}/plan.json`, 'utf8'))

function runAsync(args: string[], w: W): Promise<{ status: number | null; stdout: string }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.TRUSS_MIN_FREE_MB
  delete env.TRUSS_SESSION_START
  env.TRUSS_SAMPLE = highSampleFile()
  Object.assign(env, w.env)
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [FACTORY, ...args], { cwd: w.repo, env, windowsHide: true })
    let stdout = ''
    c.stdout.on('data', (d) => (stdout += d))
    c.stderr.on('data', () => {})
    c.on('close', (status) => resolve({ status, stdout }))
  })
}

// ---------------------------------------------------------------------------------------------------------------

test('cost: duplicate content-block lines count once', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['wfcrew', 'wtcrew', 'latecrew'] })
  lay(w, ['main', 'wf', 'wt', 'late'])
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(idsOf(w), ALL_IDS, 'one usage row per msgId, though main has three lines of msg_m1 and wf two of msg_w1')
  near(crewOf(r.json, 'wfcrew')?.usd, 2, 'wfcrew usd (two content-block lines of one message)')
})

test('cost: dedupe survives a deleted cursor', async () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['wfcrew', 'wtcrew', 'latecrew'] })
  lay(w, ['main', 'wf', 'wt', 'late'])
  const before = listFiles(w.dir)
  assert.equal(cost(w).status, 0)
  assert.deepEqual(idsOf(w), ALL_IDS)
  const cursors = cursorsAfter(w, before)
  assert.ok(cursors.length > 0, `the sweep keeps a cursor file in the session dir; new files: ${JSON.stringify(listFiles(w.dir))}`)
  const wipe = (): void => cursors.forEach((c) => rmSync(`${w.dir}/${c}`, { force: true }))
  wipe()
  assert.equal(cost(w).status, 0)
  assert.deepEqual(idsOf(w), ALL_IDS, 'a lost cursor re-adds no row')
  // deleted while three sweeps are running
  let done = false
  const kids = [1, 2, 3].map(() => runAsync(['cost', '--dir', w.dir, '--repo', w.repo], w))
  const all = Promise.all(kids).then((rs) => ((done = true), rs))
  while (!done) {
    wipe()
    await new Promise((res) => setTimeout(res, 2))
  }
  for (const k of await all) assert.equal(k.status, 0, k.stdout)
  wipe()
  assert.equal(cost(w).status, 0)
  assert.deepEqual(idsOf(w), ALL_IDS, 'a cursor deleted mid-sweep re-adds no row')
})

test('cost: a torn last line is skipped', () => {
  const w = world({ config: cfg({ pricing: pricing() }) })
  lay(w, ['main'])
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(idsOf(w), ['msg_m1', 'msg_m3', 'msg_m4'], 'msg_torn is half written, so it is not a row yet')
  near(r.json?.session?.usd, 9.1, 'session usd before the torn line completes')
  appendFileSync(mainPath(w), TORN_SUFFIX)
  const r2 = cost(w)
  assert.equal(r2.status, 0)
  assert.deepEqual(idsOf(w), ['msg_m1', 'msg_m3', 'msg_m4', 'msg_torn'], 'the line is read once it is whole')
  near(r2.json?.session?.usd, 10.1, 'session usd after it completes')
})

test('cost: synthetic rows with zero usage are skipped', () => {
  const w = world({ config: cfg({ pricing: pricing() }) })
  lay(w, ['main'])
  assert.equal(cost(w).status, 0)
  const rows = usageRows(w)
  assert.ok(rows.length > 0, 'the sweep recorded the real rows')
  assert.ok(!rows.some((r) => r.msgId === 'msg_syn' || r.model === '<synthetic>'), 'no <synthetic> row')
})

test('cost: prices match by the longest prefix', () => {
  const a = world({ config: cfg({ pricing: pricing() }) })
  lay(a, ['main'])
  near(cost(a).json?.session?.usd, 9.1, 'with the test-model-long key the long row costs 4')
  const b = world({ config: cfg({ pricing: pricing({ long: false }) }) })
  lay(b, ['main'])
  near(cost(b).json?.session?.usd, 6.1, 'without it the row falls back to the shorter test-model key (1)')
})

test('cost: an unpriced model gives null usd, never 0', () => {
  const w = world({ config: cfg({ pricing: { 'other-model': P(1, 2, 0.1, 1, 1) } }), crews: ['wfcrew'] })
  lay(w, ['main', 'wf'])
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.json?.session?.usd, null, 'a sum that holds an unpriced model is null')
  assert.ok((r.json?.unpriced ?? []).includes('test-model'), `unpriced lists the model: ${JSON.stringify(r.json?.unpriced)}`)
  assert.equal(crewOf(r.json, 'wfcrew')?.usd, null)
})

test('cost: a fast row uses the fast prices', () => {
  const a = world({ config: cfg({ pricing: pricing() }) })
  lay(a, ['main'])
  near(cost(a).json?.session?.usd, 9.1, 'the fast row (speed fast) costs 3 at the fast prices')
  const b = world({ config: cfg({ pricing: pricing({ fastScale: 2 }) }) })
  lay(b, ['main'])
  near(cost(b).json?.session?.usd, 12.1, 'doubling only the fast prices moves only the fast row')
})

test('cost: a meta written after its jsonl is attributed on a later read', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['latecrew'] })
  lay(w, ['late'], { lateMeta: false })
  const r1 = cost(w)
  assert.equal(r1.status, 0, r1.stdout + r1.stderr)
  near(r1.json?.session?.usd, 1, 'the row is counted at once')
  assert.equal(crewOf(r1.json, 'latecrew')?.usd ?? null, null, 'no meta yet, so not the crew')
  meta(w, 'late')
  const r2 = cost(w)
  near(crewOf(r2.json, 'latecrew')?.usd, 1, 'the crew has the row on the next read')
  assert.deepEqual(idsOf(w), ['msg_l1'], 'and it is still one row')
})

test('cost: a meta worktreePath attributes the row to the crew', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['wtcrew'] })
  lay(w, ['wt'])
  assert.equal(JSON.parse(readFileSync(`${w.root}/${w.key}/${w.sid}/subagents/agent-wt1.meta.json`, 'utf8')).worktreePath, wtOf(w, 'wtcrew'))
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  near(crewOf(r.json, 'wtcrew')?.usd, 2, 'wtcrew usd')
})

test('cost: factory cost runs on a session dir with no plan.json', () => {
  const w = world({ config: cfg({ pricing: pricing() }) })
  lay(w, ['main', 'wf', 'wt', 'late'])
  assert.ok(!existsSync(`${w.dir}/plan.json`))
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const j = assertOneLine(r)
  assert.equal(j.run?.since, null)
  assert.deepEqual(j.crews, [])
  near(j.session?.usd, 14.1, 'session usd')
  assert.equal(j.sweep?.found, 4, 'one main and three agent transcripts')
})

test('cost: with no budget admit does not sweep', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew'] })
  lay(w, ['budget'])
  const before = listFiles(w.dir)
  const r = admit(w, 'bcrew')
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.json?.admitted, true)
  assert.deepEqual(listFiles(w.dir).filter((f) => !before.includes(f) && !f.startsWith('locks/')), [], 'admit wrote no usage file and no cursor')
  assert.ok(!existsSync(`${w.dir}/usage.jsonl`))
  // the same transcripts do get swept by the meter itself
  assert.equal(cost(w).status, 0)
  assert.deepEqual(idsOf(w), ['msg_b1'], 'factory cost sweeps')
})

const BUDGET = { crewUsd: 5 }
test('cost: a crew priced at exactly 5.20 against crewUsd 5 is held at admit with exit 1 in under 1 s with wait-ms 5000 and a why that starts budget:', () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  const t0 = Date.now()
  const r = admit(w, 'bcrew', ['--wait-ms', '5000'])
  const wall = Date.now() - t0
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.equal(r.json?.admitted, false)
  assert.equal(r.json?.budget, true)
  assert.ok(typeof r.json?.why === 'string' && r.json.why.startsWith('budget:'), `why: ${r.json?.why}`)
  assert.ok(r.json?.waitedMs < 1000, `a budget hold does not wait: waitedMs ${r.json?.waitedMs}`)
  assert.ok(wall < 5000, `the hold ends the wait at once, not after the 5000 ms: ${wall} ms wall`)
})

test('cost: the 5.20 crew held at crewUsd 5 gives budgetVerdict held with scope crew, spentUsd 5.2 and limitUsd 5', async () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  const c = await realCost()
  const v = withRoot(w, () => c.budgetVerdict(w.dir, w.repo, planOf(w), 'bcrew'))
  assert.equal(v.held, true, JSON.stringify(v))
  assert.ok(typeof v.spentUsd === 'number', JSON.stringify(v))
  assert.deepEqual({ held: v.held, scope: v.scope, spentUsd: Number(v.spentUsd.toFixed(9)), limitUsd: v.limitUsd }, { held: true, scope: 'crew', spentUsd: 5.2, limitUsd: 5 })
})

// End to end through the real inbox: hold, escalation with the code in the held entry (no notify key), client-path resolve with a typed raise, admit.
function typeApproval(w: W, id: string, code: string, tail: string): void {
  const line = { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: `/truss:inbox approve ${id} ${code} ${tail}` }, uuid: `u-${id}`, timestamp: new Date(Date.now() + 60000).toISOString() }
  mkdirSync(`${w.root}/${w.key}`, { recursive: true })
  appendFileSync(`${w.root}/${w.key}/${w.sid}.jsonl`, JSON.stringify(line) + '\n')
}
const resolveCli = (w: W, id: string, code: string, extra: string[]) => runCli(FACTORY, 'resolve', [id, '--decision', 'approve', '--by', 'client', '--code', code, ...extra, '--repo', w.repo, '--dir', w.dir], w.repo, w.env)

test('cost: a held crew shows its code with no notify key; the client-path raise lets it run, and a raise too small still holds it', () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  const held = admit(w, 'bcrew')
  assert.equal(held.status, 1, held.stdout + held.stderr)
  const m = /client approval needed: (E-\d{8}-[0-9a-f]{6}) code ([A-Z2-9]{6})/.exec(String(held.json?.why))
  assert.ok(m, `the held why carries the id and the one-time code: ${held.json?.why}`)
  const [, id, code] = m
  // too small: 5.2 spent against 5 + 0.1 is still held, and the amount the agent passes must be the typed one
  typeApproval(w, id, code, 'raise 0.1')
  const liar = resolveCli(w, id, code, ['--raise-usd', '3'])
  assert.equal(liar.status, 1, `a --raise-usd that differs from the typed one is refused: ${liar.stdout}`)
  const small = resolveCli(w, id, code, ['--raise-usd', '0.1'])
  assert.equal(small.status, 0, small.stdout + small.stderr)
  const still = admit(w, 'bcrew')
  assert.equal(still.status, 1, `a raise of 0.1 does not clear 5.2 against 5.1: ${still.stdout}`)
  assert.equal(still.json?.budget, true)
  // a new item (the first is resolved), approved with a raise of 3: 5.2 < 8
  const m2 = /client approval needed: (E-\d{8}-[0-9a-f]{6}) code ([A-Z2-9]{6})/.exec(String(still.json?.why))
  assert.ok(m2, `the reopened item shows its code: ${still.json?.why}`)
  typeApproval(w, m2[1], m2[2], 'raise 3')
  const ok = resolveCli(w, m2[1], m2[2], ['--raise-usd', '3'])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const go = admit(w, 'bcrew')
  assert.equal(go.status, 0, `the 5.20 crew is under 5 + 0.1 + 3: ${go.stdout}${go.stderr}`)
  assert.equal(go.json?.admitted, true)
})

test('cost: a raise of 3 from budgetRaises lifts the crewUsd 5 limit to 8 and the 5.20 crew is admitted', async () => {
  // a private plugin copy whose bin/inbox.ts keeps the real exports and overrides budgetRaises only (plugin-tests rule)
  const d = tmp('cost-plugin-')
  cpSync(pluginCopy(), d, { recursive: true })
  renameSync(`${d}/bin/inbox.ts`, `${d}/bin/inbox-real.ts`)
  writeFileSync(`${d}/bin/inbox.ts`, `export * from './inbox-real.ts'\nexport function budgetRaises(repo, session) { return [{ ref: 'budget:' + session + ':crew:bcrew', raiseUsd: 3 }] }\n`)
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  const r = admit(w, 'bcrew', [], `${d}/bin/factory.ts`)
  assert.equal(r.status, 0, `the 5.20 crew is under 5 + 3: ${r.stdout}${r.stderr}`)
  assert.equal(r.json?.admitted, true)
  // the limit really is 8: at doubled prices the same crew spends 10.4 and is held against 8
  const x = world({ config: cfg({ pricing: pricing({ scale: 2 }), budget: BUDGET }), crews: ['bcrew'] })
  lay(x, ['budget'])
  const c = await import(pathToFileURL(`${d}/bin/cost.ts`).href)
  const v = withRoot(x, () => c.budgetVerdict(x.dir, x.repo, planOf(x), 'bcrew'))
  assert.equal(v.held, true, JSON.stringify(v))
  assert.equal(v.limitUsd, 8)
  near(v.spentUsd, 10.4, 'spentUsd at doubled prices')
})

test('cost: a held usage lock still gives a verdict', async () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  assert.equal(cost(w).status, 0)
  assert.deepEqual(idsOf(w), ['msg_b1'])
  // a live owner holds locks/usage; a new row lands in the transcript that the busy sweep can't read
  const lock = `${w.dir}/locks/usage.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'planted', since: Date.now() }))
  const f = `${w.root}/${w.key}/${w.sid}/subagents/agent-bcrew.jsonl`
  appendFileSync(f, readFileSync(`${FIX}budget-crew.jsonl`, 'utf8').split('\n')[0].replace('msg_b1', 'msg_b2') + '\n')
  try {
    const c = await realCost()
    const v = withRoot(w, () => c.budgetVerdict(w.dir, w.repo, planOf(w), 'bcrew'))
    assert.equal(v.held, true, JSON.stringify(v))
    assert.equal(v.scope, 'crew')
    near(v.spentUsd, 5.2, 'the verdict reads usage.jsonl as it stands (msg_b2 is not swept while the lock is held)')
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
})

test('cost: a busy usage lock before the first sweep does not hold and crewCost stays null', async () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  // a live owner holds locks/usage and no sweep has ever finished: there is no usage-cursor.json
  const lock = `${w.dir}/locks/usage.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'planted', since: Date.now() }))
  assert.equal(existsSync(`${w.dir}/usage-cursor.json`), false)
  try {
    const c = await realCost()
    const v = withRoot(w, () => c.budgetVerdict(w.dir, w.repo, planOf(w), 'bcrew'))
    assert.equal(v.held, false, JSON.stringify(v))
    assert.ok(!String(v.why ?? '').includes('first usage sweep'), `why: ${v.why}`)
    const cc = withRoot(w, () => c.crewCost(w.dir, w.repo, 'bcrew'))
    assert.equal(cc.usd, null, JSON.stringify(cc))
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
})

test('cost: a busy usage lock after a first sweep gives crewCost usd null with why usage sweep busy', async () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  lay(w, ['budget'])
  assert.equal(cost(w).status, 0)
  assert.equal(existsSync(`${w.dir}/usage-cursor.json`), true, 'a first sweep has finished')
  const lock = `${w.dir}/locks/usage.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'planted', since: Date.now() }))
  try {
    const c = await realCost()
    const cc = withRoot(w, () => c.crewCost(w.dir, w.repo, 'bcrew'))
    assert.deepEqual(cc, { usd: null, why: 'usage sweep busy' })
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
  const c2 = await realCost()
  near(withRoot(w, () => c2.crewCost(w.dir, w.repo, 'bcrew')).usd, 5.2, 'with the lock free crewCost prices the crew')
})

test('cost: no transcripts gives a hold', async () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: BUDGET }), crews: ['bcrew'] })
  mkdirSync(w.root, { recursive: true })
  const c = await realCost()
  const v = withRoot(w, () => c.budgetVerdict(w.dir, w.repo, planOf(w), 'bcrew'))
  assert.equal(v.held, true, JSON.stringify(v))
  assert.ok(String(v.why).includes('no transcripts found'), `why: ${v.why}`)
})

test('cost: 4 concurrent admits record each msgId exactly once', async () => {
  const slugs = ['wfcrew', 'wtcrew', 'latecrew', 'bcrew']
  for (let round = 0; round < 3; round++) {
    const w = world({ config: cfg({ pricing: pricing(), budget: { crewUsd: 100 } }), crews: slugs })
    lay(w, ['main', 'wf', 'wt', 'late', 'budget'])
    const rs = await Promise.all(slugs.map((s) => runAsync(['admit', '--dir', w.dir, '--repo', w.repo, '--slug', s], w)))
    for (const r of rs) assert.equal(r.status, 0, `round ${round}: ${r.stdout}`)
    assert.deepEqual(idsOf(w), [...ALL_IDS, 'msg_b1'].sort(), `round ${round}: each msgId once in usage.jsonl`)
  }
})

test('cost: the newest cost-state estimate is reported as claudeCodeEstimateUsd', () => {
  const w = world({ config: cfg({ pricing: pricing() }) })
  lay(w, ['main'])
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  near(r.json?.claudeCodeEstimateUsd, 9, 'the later of the cost-state lines (3.5 then 9.0)')
})

test('cost: win32 cursor keys are lowercased paths', async () => {
  const c = await realCost()
  assert.equal(typeof c.sweep, 'function', 'cost.ts exports sweep(dir, repo, { platform })')
  const keysOf = (platform: string): string[] => {
    const w = world({ config: cfg({ pricing: pricing() }), key: 'Proj-Key-ABC' })
    lay(w, ['main', 'wf'])
    const before = listFiles(w.dir)
    withRoot(w, () => c.sweep(w.dir, w.repo, { platform }))
    const files = cursorsAfter(w, before)
    assert.ok(files.length > 0, `${platform}: the sweep keeps a cursor file`)
    const keys: string[] = []
    const walk = (v: any): void => {
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k.includes('/') && keys.push(k), walk(x))
    }
    for (const f of files) {
      try {
        walk(JSON.parse(readFileSync(`${w.dir}/${f}`, 'utf8')))
      } catch {
        // not JSON
      }
    }
    return keys
  }
  const win = keysOf('win32')
  assert.ok(win.length > 0 && win.some((k) => k.includes('proj-key-abc')), `win32 cursor keys: ${JSON.stringify(win)}`)
  assert.ok(win.every((k) => k === k.toLowerCase()), `every win32 key is lowercase: ${JSON.stringify(win)}`)
  const mac = keysOf('darwin')
  assert.ok(mac.some((k) => k.includes('Proj-Key-ABC')), `darwin keeps the case: ${JSON.stringify(mac)}`)
})

// ---- attribution rule 2, run and session scopes, work-type limits, win32 worktree match ----

const spawnEvent = (w: W, agentId: string, crewSlug: string): void => appendFileSync(`${w.dir}/events.jsonl`, JSON.stringify({ v: 1, ts: new Date().toISOString(), event: 'spawn', agentId, crew: crewSlug }) + '\n')

test('cost: a spawn event attributes the agent rows to its crew (rule 2)', () => {
  // agent-bcrew has the description bcrew-builder, but bcrew is not a plan slug, so only the spawn event can name the crew
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['other'] })
  lay(w, ['budget'])
  const r0 = cost(w)
  assert.equal(crewOf(r0.json, 'other')?.usd ?? null, null, 'without the event the rows are not the crew')
  spawnEvent(w, 'bcrew', 'other')
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  near(crewOf(r.json, 'other')?.usd, 5.2, 'other usd')
})

test('cost: a spawn event wins over a mismatched description and over a worktreePath (rule 2 before rules 3 and 4)', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew', 'wtcrew', 'other'] })
  lay(w, ['budget', 'wt'])
  const r0 = cost(w)
  near(crewOf(r0.json, 'bcrew')?.usd, 5.2, 'by its description the row is bcrew')
  near(crewOf(r0.json, 'wtcrew')?.usd, 2, 'by its worktreePath the row is wtcrew')
  spawnEvent(w, 'bcrew', 'other')
  spawnEvent(w, 'wt1', 'other')
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  near(crewOf(r.json, 'other')?.usd, 7.2, 'both agents now belong to the spawned crew')
  assert.equal(crewOf(r.json, 'bcrew')?.usd ?? null, null, 'not bcrew')
  assert.equal(crewOf(r.json, 'wtcrew')?.usd ?? null, null, 'not wtcrew')
})

test('cost: runUsd counts only the rows after approvedAt', async () => {
  // rows: main 9.1 (06:00-06:05), wf 2.0 (06:10), wt 2.0 (06:11), late 1.0 (06:12); approved at 06:10:30 the run holds wt and late, 3.0
  const mk = (runUsd: number): W => {
    const w = world({ config: cfg({ pricing: pricing(), budget: { runUsd } }), crews: ['wtcrew'] })
    writePlan(w.dir, planObj([crew('wtcrew')], { approvedAt: '2026-11-10T06:10:30.000Z' }))
    lay(w, ['main', 'wf', 'wt', 'late'])
    return w
  }
  const c = await realCost()
  const a = mk(2.9)
  const v = withRoot(a, () => c.budgetVerdict(a.dir, a.repo, planOf(a), 'wtcrew'))
  assert.equal(v.held, true, JSON.stringify(v))
  assert.equal(v.scope, 'run')
  near(v.spentUsd, 3, 'run spend counts the two rows after approvedAt only')
  assert.equal(v.limitUsd, 2.9)
  const b = mk(3.5)
  const u = withRoot(b, () => c.budgetVerdict(b.dir, b.repo, planOf(b), 'wtcrew'))
  assert.equal(u.held, false, `3.0 after approvedAt is under 3.5, though the session spent 14.1: ${JSON.stringify(u)}`)
})

test('cost: sessionUsd with plan null and slug null counts every row (queue-next)', async () => {
  const mk = (sessionUsd: number): W => {
    const w = world({ config: cfg({ pricing: pricing(), budget: { sessionUsd } }) })
    lay(w, ['main', 'wf', 'wt', 'late'])
    return w
  }
  const c = await realCost()
  const a = mk(14)
  const v = withRoot(a, () => c.budgetVerdict(a.dir, a.repo, null, null))
  assert.equal(v.held, true, JSON.stringify(v))
  assert.equal(v.scope, 'session')
  near(v.spentUsd, 14.1, 'session spend')
  assert.equal(v.limitUsd, 14)
  const b = mk(15)
  assert.equal(withRoot(b, () => c.budgetVerdict(b.dir, b.repo, null, null)).held, false)
})

test('cost: workTypes crewUsd below the crew limit is the limit, with scope workType and the workType raise ref', async () => {
  const budget = { crewUsd: 100, workTypes: { docs: { crewUsd: 5 } } }
  const mk = (b: unknown, scale = 1): W => {
    const w = world({ config: cfg({ pricing: pricing({ scale }), budget: b }) })
    writePlan(w.dir, planObj([crew('bcrew', { workType: 'docs' })]))
    lay(w, ['budget'])
    return w
  }
  const c = await realCost()
  const a = mk(budget)
  const v = withRoot(a, () => c.budgetVerdict(a.dir, a.repo, planOf(a), 'bcrew'))
  assert.equal(v.held, true, JSON.stringify(v))
  assert.deepEqual({ scope: v.scope, limitUsd: v.limitUsd }, { scope: 'workType', limitUsd: 5 })
  near(v.spentUsd, 5.2, 'spentUsd')
  // a work-type limit above the crew limit is not used
  const hi = mk({ crewUsd: 5, workTypes: { docs: { crewUsd: 100 } } })
  const vh = withRoot(hi, () => c.budgetVerdict(hi.dir, hi.repo, planOf(hi), 'bcrew'))
  assert.deepEqual({ held: vh.held, scope: vh.scope, limitUsd: vh.limitUsd }, { held: true, scope: 'crew', limitUsd: 5 })
  // the raise ref is budget:<session>:workType:<slug>: a private copy whose budgetRaises answers to it and to the crew ref with different sums
  const d = tmp('cost-plugin-')
  cpSync(pluginCopy(), d, { recursive: true })
  renameSync(`${d}/bin/inbox.ts`, `${d}/bin/inbox-real.ts`)
  writeFileSync(`${d}/bin/inbox.ts`, `export * from './inbox-real.ts'\nexport function budgetRaises(repo, session) { return [{ ref: 'budget:' + session + ':workType:bcrew', raiseUsd: 3 }, { ref: 'budget:' + session + ':crew:bcrew', raiseUsd: 50 }] }\n`)
  const x = mk(budget, 2)
  const c2 = await import(pathToFileURL(`${d}/bin/cost.ts`).href)
  const vx = withRoot(x, () => c2.budgetVerdict(x.dir, x.repo, planOf(x), 'bcrew'))
  assert.equal(vx.held, true, JSON.stringify(vx))
  assert.deepEqual({ scope: vx.scope, limitUsd: vx.limitUsd }, { scope: 'workType', limitUsd: 8 })
  near(vx.spentUsd, 10.4, 'spentUsd at doubled prices')
})

test('cost: on win32 the worktreePath match is case-insensitive', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['wtcrew'] })
  lay(w, ['wt'])
  const mpath = `${w.root}/${w.key}/${w.sid}/subagents/agent-wt1.meta.json`
  const m = JSON.parse(readFileSync(mpath, 'utf8'))
  m.worktreePath = wtOf(w, 'wtcrew').toUpperCase()
  writeFileSync(mpath, JSON.stringify(m))
  const script = fileURLToPath(new URL('./fixtures/cost/crewcost-platform.ts', import.meta.url))
  const run = (fake: string): any => {
    const r = spawnSync(process.execPath, [script, `${REAL_PLUGIN}/bin/cost.ts`, w.dir, w.repo, 'wtcrew', fake], { cwd: w.repo, env: { ...process.env, ...w.env }, encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop() as string)
  }
  const win = run('win32')
  near(win.usd, 2, `win32 matches the upper-cased worktreePath: ${JSON.stringify(win)}`)
  const other = run('native')
  if (process.platform !== 'win32') assert.equal(other.usd, null, `without win32 the upper-cased path does not match: ${JSON.stringify(other)}`)
})

// ---- the PO cases ruled at 00:39 ----

const PRICE_RES: [string, RegExp][] = [
  ['rate field with a number', /(?:input|output|cacheRead|cacheWrite5m|cacheWrite1h)PerMTok["']?\s*[:=]\s*\d/],
  ['dollars per MTok', /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:\/|per)\s*(?:M|million)\s*(?:tok|tokens)?\b/i],
  ['model id to number', /["']?\b(?:claude-)?(?:opus|sonnet|haiku)[\w.-]*["']?\s*[:=]\s*\$?\d/i],
  ['model id table row', /\|\s*(?:claude-)?(?:opus|sonnet|haiku)[\w.-]*\s*\|\s*\$?\d/i],
]
const priceHits = (text: string): string[] => PRICE_RES.filter(([, re]) => re.test(text)).map(([n]) => n)

test('cost: no committed price literal in cost.ts, the cost fixtures or the prose, and a planted price table is caught', () => {
  // the scan must first catch a planted counter-example of each kind, and spare a USD total
  const d = rp(tmp('cost-scan-'))
  const planted: Record<string, string> = {
    'a.json': '{"pricing":{"x":{"inputPerMTok": 3}}}',
    'b.md': 'Sonnet costs $3/MTok in.',
    'c.json': '{"claude-opus-4": 15}',
    'd.md': '| haiku | 1 |',
  }
  for (const [f, text] of Object.entries(planted)) {
    writeFileSync(`${d}/${f}`, text)
    assert.ok(priceHits(readFileSync(`${d}/${f}`, 'utf8')).length > 0, `the scan misses a planted price in ${f}`)
  }
  assert.deepEqual(priceHits('Cost probe: session s | table /x/pricing.json | factory 12.3456 | claudeCodeEstimateUsd 12.1 | gap 1.2%'), [], 'a USD total is not a price')
  assert.deepEqual(priceHits('prices are read from `inputPerMTok` in the client pricing config'), [], 'a field name alone is not a price')
  // the committed files
  const files: string[] = [`${REAL_PLUGIN}/bin/cost.ts`]
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) (e.isDirectory() ? walk(`${dir}/${e.name}`) : files.push(`${dir}/${e.name}`))
  }
  walk(FIX.replace(/\/$/, ''))
  const adrs = `${REAL_PLUGIN}/docs/adr`
  for (const f of readdirSync(adrs)) if (/^(0038-|0041-).*\.md$/.test(f) || f === '0031-right-size-process.md') files.push(`${adrs}/${f}`)
  const found: string[] = []
  for (const f of files) for (const h of priceHits(readFileSync(f, 'utf8'))) found.push(`${path.basename(f)}: ${h}`)
  assert.deepEqual(found, [], 'no price literal in cost.ts, the fixtures or the ADRs')
})

test('cost: factory cost with no pricing configured gives usd null and a reason', async () => {
  const w = world({ config: cfg(), crews: ['wfcrew'] })
  lay(w, ['main', 'wf'])
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.json?.session?.usd, null, 'never 0')
  const c = crewOf(r.json, 'wfcrew')
  assert.ok(c !== undefined, `wfcrew is listed: ${JSON.stringify(r.json?.crews)}`)
  assert.equal(c.usd, null)
  assert.ok(typeof c.why === 'string' && c.why.length > 0, `a reason: ${JSON.stringify(c)}`)
  assert.ok((r.json?.unpriced ?? []).includes('test-model'), `unpriced: ${JSON.stringify(r.json?.unpriced)}`)
  const m = await realCost()
  const cc = withRoot(w, () => m.crewCost(w.dir, w.repo, 'wfcrew'))
  assert.equal(cc.usd, null)
  assert.ok(typeof cc.why === 'string' && cc.why.length > 0)
})
