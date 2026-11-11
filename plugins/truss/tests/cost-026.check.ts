// @ts-nocheck
// truss 0.26.0, cost-budgets: the acceptance cases of items 5, 6 and 15 (goal cost-budgets, ADR-0038). Written before the build.
// Item 5: `factory cost` treats a busy first sweep as busy, a torn usage.jsonl row is skipped and no later row is lost, the 1 s hold is
// proven over a ~100 MB transcript. Item 6 (PM ruling: enforce): sessionUsd holds every crew's admit, and the verdict carries the session ref
// budget:<sid>:session:session, so one typed raise lifts the hold for all crews. Item 15: planning and intake spend count against it.
// Fixtures: synthetic transcripts of tests/fixtures/cost/ and rows written here; the price table is synthetic (1 000 000 input tokens cost
// exactly the `test-model` input rate, 1) and written into a temp .claude/truss.json at test time.
// Expected state against the 0.25 code: the cases of items 5 and 6 are red; the 100 MB case with its 1000 ms bound, and the intake case at
// queue-next, are green already (regression guards; the bound and slug-null queue-next check exist), and the ADR case waits for the writer.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { proofPlugin } from './fixtures/inbox/proof-plugin.ts'
import { REAL_PLUGIN, crew, mkRepo, mkTrussDir, planObj, runCli, tmp, writePlan } from './fixtures/workflow-run/harness.ts'

const FIX = fileURLToPath(new URL('./fixtures/cost/', import.meta.url))
const ADR = fileURLToPath(new URL('../docs/adr/0038-cost-budgets-and-ledger.md', import.meta.url))
const FACTORY = `${proofPlugin()}/bin/factory.ts`
const rp = (p: string): string => realpathSync(p).replace(/\\/g, '/')
const near = (a: unknown, b: number, what: string): void => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-6, `${what}: expected ${b}, got ${a}`)

const rate = (n: number) => ({ inputPerMTok: n, outputPerMTok: 2 * n, cacheReadPerMTok: 0.1 * n, cacheWrite5mPerMTok: 1.5 * n, cacheWrite1hPerMTok: 2.5 * n })
const pricing = () => ({ 'test-model': { ...rate(1), fast: rate(5) }, 'test-model-budget': { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.6, cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 1 }, 'test-model-long': rate(4) })
const cfg = (extra: Record<string, unknown> = {}) => ({ architecture: 'docs/architecture.md', adr: 'docs/adr', ...extra })

type W = { repo: string; dir: string; sid: string; root: string; key: string; env: Record<string, string> }
function world(o: { config?: unknown; crews?: string[] } = {}): W {
  const repo = rp(mkRepo({ config: o.config ?? cfg() }))
  const dir = rp(mkTrussDir())
  const root = rp(tmp('cost026-tr-'))
  if (o.crews) writePlan(dir, planObj(o.crews.map((s) => crew(s))))
  return { repo, dir, sid: path.basename(dir), root, key: '-work-proj', env: { TRUSS_TRANSCRIPTS_ROOT: root, TRUSS_TEST_PROOF_ROOT: root } }
}
const mainPath = (w: W): string => `${w.root}/${w.key}/${w.sid}.jsonl`
const agentPath = (w: W, id: string): string => `${w.root}/${w.key}/${w.sid}/subagents/agent-${id}`
/** The 5.20 USD transcript of the crew `bcrew` (test-model-budget), laid under the session's subagents. */
function layBudget(w: W): void {
  mkdirSync(`${w.root}/${w.key}/${w.sid}/subagents`, { recursive: true })
  writeFileSync(`${agentPath(w, 'bcrew')}.jsonl`, readFileSync(`${FIX}budget-crew.jsonl`))
  writeFileSync(`${agentPath(w, 'bcrew')}.meta.json`, readFileSync(`${FIX}budget-crew.meta.json`))
}
/** A transcript with one assistant row of `inputMTok` million input tokens of test-model (USD = inputMTok). */
const rowLine = (id: string, inputMTok: number): string =>
  JSON.stringify({ type: 'assistant', uuid: `u-${id}`, timestamp: '2026-11-10T06:30:00.000Z', message: { id, model: 'test-model', role: 'assistant', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: inputMTok * 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed: 'standard' } } }) + '\n'
function layMain(w: W, id: string, inputMTok: number): void {
  mkdirSync(`${w.root}/${w.key}`, { recursive: true })
  writeFileSync(mainPath(w), rowLine(id, inputMTok))
}
/** A planner or intake agent transcript: `description` is its label, there is no crew in it. */
function layAgent(w: W, id: string, description: string, inputMTok: number): void {
  mkdirSync(`${w.root}/${w.key}/${w.sid}/subagents`, { recursive: true })
  writeFileSync(`${agentPath(w, id)}.jsonl`, rowLine(`msg_${id}`, inputMTok))
  writeFileSync(`${agentPath(w, id)}.meta.json`, JSON.stringify({ agentType: 'general-purpose', description, toolUseId: `toolu_${id}`, spawnDepth: 1, model: 'test-model', finished: true }))
}
const run = (cmd: string, w: W, extra: string[] = []) => runCli(FACTORY, cmd, ['--dir', w.dir, '--repo', w.repo, ...extra], w.repo, w.env)
const cost = (w: W) => run('cost', w)
const admit = (w: W, slug: string) => run('admit', w, ['--slug', slug])
const usagePath = (w: W): string => `${w.dir}/usage.jsonl`
const usageLines = (w: W): string[] => readFileSync(usagePath(w), 'utf8').split('\n')
const planOf = (w: W): any => JSON.parse(readFileSync(`${w.dir}/plan.json`, 'utf8'))
const withRoot = <T>(w: W, f: () => T): T => {
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
/** A live owner (this test process) holds locks/usage; returns the release. */
function plantLock(w: W): () => void {
  const lock = `${w.dir}/locks/usage.lock`
  mkdirSync(lock, { recursive: true })
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ pid: process.pid, host: hostname(), token: 'planted', since: Date.now() }))
  return () => rmSync(lock, { recursive: true, force: true })
}
const TORN = '{"v":1,"ts":"2026-11-10T06:00:00.000Z","sid":"x","agentId":null,"model":"test-model","speed":"standard","msgId":"msg_tor'

// ---- item 5: factory cost under a busy first sweep ----

test('cost-026: factory cost reports usd null with a reason when the first sweep holds the lock and no reading exists', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew'] })
  layMain(w, 'msg_a', 2)
  assert.equal(existsSync(usagePath(w)) || existsSync(`${w.dir}/usage-cursor.json`), false, 'no reading exists')
  const release = plantLock(w)
  try {
    const r = cost(w)
    assert.equal(r.status, 0, `a busy lock is reported, not thrown: ${r.stdout}${r.stderr}`)
    assert.equal(r.json?.session?.usd, null, 'unknown, never 0')
    assert.equal(r.json?.run?.usd, null, 'unknown, never 0')
    assert.ok(typeof r.json?.session?.why === 'string' && /busy/i.test(r.json.session.why), `session.why says busy: ${JSON.stringify(r.json?.session)}`)
    assert.equal(r.json?.sweep?.busy, true, 'the sweep result says busy')
  } finally {
    release()
  }
})

test('cost-026: factory cost reports busy with the last reading when a prior reading exists', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew'] })
  layMain(w, 'msg_a', 2)
  const first = cost(w)
  assert.equal(first.status, 0, first.stdout + first.stderr)
  near(first.json?.session?.usd, 2, 'the first reading')
  const release = plantLock(w)
  try {
    const r = cost(w)
    assert.equal(r.status, 0, `a busy lock is reported, not thrown: ${r.stdout}${r.stderr}`)
    near(r.json?.session?.usd, 2, 'the last reading, from usage.jsonl as it stands')
    assert.equal(r.json?.sweep?.busy, true, 'and it says busy')
  } finally {
    release()
  }
})

// ---- item 5: a torn usage.jsonl row ----

test('cost-026: a torn usage.jsonl row is skipped and later rows still count', () => {
  // a torn row in the middle of the file: skipped, the rows around it count
  const m = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew'] })
  layMain(m, 'msg_a', 2)
  layAgent(m, 'x1', 'truss-designer', 3)
  assert.equal(cost(m).status, 0)
  const rows = usageLines(m).filter(Boolean)
  writeFileSync(usagePath(m), rows[0] + '\n' + TORN + '\n' + rows.slice(1).join('\n') + '\n')
  rmSync(`${m.dir}/usage-cursor.json`)
  const a = cost(m)
  assert.equal(a.status, 0, a.stdout + a.stderr)
  near(a.json?.session?.usd, 5, 'a torn middle row is skipped, later rows count')
  // a torn tail (a writer died mid-row): the rows swept after it count as well
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew'] })
  layMain(w, 'msg_a', 2)
  layAgent(w, 'x1', 'truss-designer', 3)
  layAgent(w, 'x2', 'truss-designer', 4)
  assert.equal(cost(w).status, 0)
  const first = usageLines(w).filter(Boolean)[0]
  writeFileSync(usagePath(w), first + '\n' + TORN)
  rmSync(`${w.dir}/usage-cursor.json`)
  const r = cost(w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  near(r.json?.session?.usd, 9, 'the rows swept after the torn tail all count (2 + 3 + 4)')
})

test('cost-026: a sweep after a torn tail leaves every later row parseable', () => {
  const w = world({ config: cfg({ pricing: pricing() }), crews: ['bcrew'] })
  layMain(w, 'msg_a', 2)
  layAgent(w, 'x1', 'truss-designer', 3)
  layAgent(w, 'x2', 'truss-designer', 4)
  assert.equal(cost(w).status, 0)
  const first = usageLines(w).filter(Boolean)[0]
  writeFileSync(usagePath(w), first + '\n' + TORN) // ends with an unterminated row
  rmSync(`${w.dir}/usage-cursor.json`)
  assert.equal(cost(w).status, 0)
  const lines = usageLines(w).filter(Boolean)
  const bad = lines.filter((l) => {
    try {
      JSON.parse(l)
      return false
    } catch {
      return true
    }
  })
  assert.equal(bad.length, 1, `only the torn line fails to parse: ${JSON.stringify(bad)}`)
  assert.equal(bad[0], TORN, 'the torn line stays whole, no new row is glued to it')
  const ids = lines.filter((l) => l !== TORN).map((l) => JSON.parse(l).msgId).sort()
  assert.deepEqual(ids, ['msg_a', 'msg_x1', 'msg_x2'], 'no new row is lost')
})

// ---- item 5: the 1 s hold at real size ----

/** A ~100 MB main transcript of non-assistant lines, written in 1 MiB blocks. */
function bigMain(w: W, mb: number): void {
  mkdirSync(`${w.root}/${w.key}`, { recursive: true })
  const line = JSON.stringify({ type: 'user', uuid: 'u-big', message: { role: 'user', content: 'x'.repeat(1000) } }) + '\n'
  const block = Buffer.from(line.repeat(Math.floor((1024 * 1024) / line.length)))
  const fd = openSync(mainPath(w), 'w')
  try {
    for (let i = 0; i < mb; i++) writeSync(fd, block)
  } finally {
    closeSync(fd)
  }
}
/** Spawns fixtures/cost/lock-holder.ts, which holds the usage lock of w.dir for holdMs; resolves once it holds it. */
async function holdLock(w: W, holdMs: number): Promise<{ stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [`${FIX}lock-holder.ts`, `${REAL_PLUGIN}/bin/store.ts`, w.dir, String(holdMs)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = new Promise<void>((res) => child.on('close', () => res()))
  await new Promise<void>((resolve, reject) => {
    let out = ''
    child.stdout.on('data', (d) => {
      out += d
      if (out.includes('"held":true')) resolve()
    })
    child.on('close', () => reject(new Error(`lock holder exited before holding: ${out}`)))
  })
  return { stop: async () => { child.kill(); await closed } }
}

test('cost-026: the budget verdict waits at most its 1000 ms bound while another process holds the lock over a 100 MB transcript', async () => {
  const c = await realCost()
  const cap = { pricing: pricing(), budget: { crewUsd: 5 } }
  // no over-cap rows in usage.jsonl: not held (a busy lock is not a hold)
  const a = world({ config: cfg(cap), crews: ['bcrew'] })
  layBudget(a)
  bigMain(a, 100)
  const ha = await holdLock(a, 6000)
  try {
    const t0 = Date.now()
    const v = withRoot(a, () => c.budgetVerdict(a.dir, a.repo, planOf(a), 'bcrew'))
    const ms = Date.now() - t0
    assert.equal(v.held, false, JSON.stringify(v))
    assert.ok(ms >= 900 && ms < 2500, `the verdict waits its 1000 ms bound, not the sweep of 100 MB: ${ms} ms`)
  } finally {
    await ha.stop()
  }
  // usage.jsonl already holds rows over the cap (5.2 against 5): a hold, within the same bound
  const b = world({ config: cfg(cap), crews: ['bcrew'] })
  layBudget(b)
  assert.equal(cost(b).status, 0)
  bigMain(b, 100)
  const hb = await holdLock(b, 6000)
  try {
    const t0 = Date.now()
    const v = withRoot(b, () => c.budgetVerdict(b.dir, b.repo, planOf(b), 'bcrew'))
    const ms = Date.now() - t0
    assert.equal(v.held, true, JSON.stringify(v))
    assert.equal(v.scope, 'crew')
    near(v.spentUsd, 5.2, 'spend from usage.jsonl as it stands')
    assert.ok(ms >= 900 && ms < 2500, `the verdict waits its 1000 ms bound: ${ms} ms`)
  } finally {
    await hb.stop()
  }
})

// ---- item 6: sessionUsd enforced in attended runs ----

const SESSION = { sessionUsd: 5 }
const idOf = (why: unknown): { id: string; code: string } => {
  const m = /client approval needed: (E-\d{8}-[0-9a-f]{6}) code ([A-Z2-9]{6})/.exec(String(why))
  assert.ok(m, `the held why carries the item id and its code: ${why}`)
  return { id: m[1], code: m[2] }
}
function typeApproval(w: W, id: string, code: string, tail: string): void {
  const file = mainPath(w)
  const have = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  const parentUuid = have.length ? JSON.parse(have[have.length - 1]).uuid : null
  const line = { parentUuid, isSidechain: false, type: 'user', origin: { kind: 'human' }, promptSource: 'typed', sessionId: w.sid, message: { role: 'user', content: `/truss:inbox approve ${id} ${code} ${tail}` }, uuid: `u-${id}-${have.length}`, timestamp: new Date(Date.now() + 60000).toISOString() }
  mkdirSync(`${w.root}/${w.key}`, { recursive: true })
  appendFileSync(file, JSON.stringify(line) + '\n')
}
const resolveCli = (w: W, id: string, code: string, extra: string[]) => runCli(FACTORY, 'resolve', [id, '--decision', 'approve', '--by', 'client', '--code', code, ...extra, '--repo', w.repo, '--dir', w.dir], w.repo, w.env)

test('cost-026: an attended session at sessionUsd is held at the next member start', () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: SESSION }), crews: ['bcrew'] })
  layBudget(w) // 5.20 USD against sessionUsd 5; no crewUsd, runUsd or workType limit is set
  const r = admit(w, 'bcrew')
  assert.equal(r.status, 1, r.stdout + r.stderr)
  assert.equal(r.json?.admitted, false)
  assert.equal(r.json?.budget, true)
  assert.equal(r.json?.scope, 'session')
  near(r.json?.spentUsd, 5.2, 'spentUsd')
  assert.equal(r.json?.limitUsd, 5)
  assert.ok(String(r.json?.why).startsWith('budget:'), `why: ${r.json?.why}`)
  const under = world({ config: cfg({ pricing: pricing(), budget: { sessionUsd: 6 } }), crews: ['bcrew'] })
  layBudget(under)
  assert.equal(admit(under, 'bcrew').status, 0, 'control: 5.20 under sessionUsd 6 is admitted')
})

test('cost-026: one typed session raise lifts the hold for every crew', () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: SESSION }), crews: ['bcrew', 'other'] })
  layBudget(w)
  const a = admit(w, 'bcrew')
  assert.equal(a.status, 1, a.stdout + a.stderr)
  assert.equal(a.json?.scope, 'session')
  const b = admit(w, 'other')
  assert.equal(b.status, 1, `the session cap holds the other crew too: ${b.stdout}${b.stderr}`)
  assert.equal(b.json?.scope, 'session')
  // one raise, typed once by the client, on the item the first hold opened
  const { id, code } = idOf(a.json?.why)
  typeApproval(w, id, code, 'raise 3')
  const ok = resolveCli(w, id, code, ['--raise-usd', '3'])
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  const ra = admit(w, 'bcrew')
  assert.equal(ra.status, 0, `5.2 is under 5 + 3: ${ra.stdout}${ra.stderr}`)
  assert.equal(ra.json?.admitted, true)
  const rb = admit(w, 'other')
  assert.equal(rb.status, 0, `the same raise (ref budget:${w.sid}:session:session) admits the other crew: ${rb.stdout}${rb.stderr}`)
  assert.equal(rb.json?.admitted, true)
})

// ---- item 15: planning and intake spend ----

test('cost-026: planning-only spend counts against sessionUsd at admit', () => {
  const mk = (sessionUsd: number): W => {
    const w = world({ config: cfg({ pricing: pricing(), budget: { sessionUsd } }), crews: ['bcrew'] })
    layMain(w, 'msg_main', 6) // the main thread, 6.0
    layAgent(w, 'plan1', 'truss-designer', 3) // a planner, 3.0; no crew row exists
    return w
  }
  const w = mk(8)
  const r = admit(w, 'bcrew')
  assert.equal(r.status, 1, `6.0 + 3.0 of planning against 8: ${r.stdout}${r.stderr}`)
  assert.equal(r.json?.budget, true)
  assert.equal(r.json?.scope, 'session')
  near(r.json?.spentUsd, 9, 'the main thread and the planner both count')
  const under = mk(10)
  assert.equal(admit(under, 'bcrew').status, 0, 'control: 9.0 is under sessionUsd 10')
})

test('cost-026: intake spend counts against sessionUsd at queue-next', () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: { sessionUsd: 8 } }) })
  layMain(w, 'msg_main', 6)
  layAgent(w, 'intake1', 'truss-intake', 3) // intake only: no plan, no crew
  const r = run('queue-next', w)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.json?.item, null, 'nothing is claimed')
  assert.ok(typeof r.json?.held?.why === 'string' && r.json.held.why.startsWith('budget:') && r.json.held.why.includes('session'), `held: ${JSON.stringify(r.json?.held)}`)
  const under = world({ config: cfg({ pricing: pricing(), budget: { sessionUsd: 10 } }) })
  layMain(under, 'msg_main', 6)
  layAgent(under, 'intake1', 'truss-intake', 3)
  assert.equal(run('queue-next', under).json?.held, undefined, 'control: 9.0 under sessionUsd 10 is not held')
})

// ---- ADR-0038 ----

test('cost-026: ADR-0038 states the sessionUsd rule the budget verdict enforces', async () => {
  const w = world({ config: cfg({ pricing: pricing(), budget: SESSION }), crews: ['bcrew'] })
  layBudget(w)
  const c = await realCost()
  const v = withRoot(w, () => c.budgetVerdict(w.dir, w.repo, planOf(w), 'bcrew'))
  assert.equal(v.held, true, `an attended fixture (slug non-null) is held by sessionUsd: ${JSON.stringify(v)}`)
  assert.equal(v.scope, 'session')
  const adr = readFileSync(ADR, 'utf8')
  assert.ok(!/only when `slug` is null/.test(adr), 'the slug-null condition is gone from the ADR')
  assert.ok(!/the `\/loop` ceiling|ceiling for a `\/loop`/.test(adr), 'sessionUsd is not called only the /loop ceiling')
  assert.ok(/every crew['’]s admit|admit (of|for) every crew/i.test(adr), 'the ADR states sessionUsd applies to every crew\'s admit')
})
