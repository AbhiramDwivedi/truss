// Contract check for the server side of the UI rework (ADR-0028 sections 1, 2, 6 and 7; R-40, R-41, R-42, R-47).
// Written from ADR-0028 before any server change exists: on today's server every case imports its producers
// successfully and then fails on an assertion about the missing behaviour, never on a missing export.
// Run with `node --test ui/contract/rework/server.check.ts`.
// Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; every server binds port 0.
//
// The Agent SDK is replaced by a stand-in through a module resolve hook (as gaps.check.ts does), so no live
// Claude session runs. SDK messages come from ui/contract/fixtures/rework/sdk-flow.jsonl: rows trimmed from
// ui/contract/fixtures/sdk-stream.jsonl, edited where noted, or marked SYNTHETIC where no recording exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const contractDir = path.dirname(here)
const uiDir = path.dirname(contractDir)
const serverUrl = (rel: string) => pathToFileURL(path.join(uiDir, 'server', rel)).href

// ---------------------------------------------------------------------------
// The SDK stand-in.
// ---------------------------------------------------------------------------
const STUB_SOURCE = `
const g = globalThis;
export function query({ prompt }) {
  const feed = [];
  let wake = null;
  let stopped = false;
  const rec = { sent: [], emit(m) { feed.push(m); if (wake) { const w = wake; wake = null; w(); } } };
  g.__trussStub = rec;
  (async () => { for await (const m of prompt) rec.sent.push(m.message.content); })().catch(() => {});
  return {
    async *[Symbol.asyncIterator]() {
      while (!stopped) {
        if (feed.length) { yield feed.shift(); continue; }
        await new Promise((r) => { wake = r; });
      }
    },
    async interrupt() { stopped = true; if (wake) { const w = wake; wake = null; w(); } },
  };
}
`
const HOOKS_SOURCE = `
export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB_SOURCE)}), shortCircuit: true };
  }
  return next(specifier, context);
}
`
register('data:text/javascript,' + encodeURIComponent(HOOKS_SOURCE))

interface Stub { sent: string[]; emit(m: unknown): void }
const stub = (): Stub | undefined => (globalThis as any).__trussStub

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ---------------------------------------------------------------------------
// The fixture rows.
// ---------------------------------------------------------------------------
const fixtureRows: Record<string, any>[] = fs
  .readFileSync(path.join(contractDir, 'fixtures', 'rework', 'sdk-flow.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '')
  .map((l) => JSON.parse(l))
// The SDK message of the row named `name`, without the fixture's own underscore keys.
function row(name: string): any {
  const r = fixtureRows.find((x) => x._case === name)
  assert.ok(r, `the fixture holds a row named ${name}`)
  return Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')))
}
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

// ---------------------------------------------------------------------------
// The wired server: the real store, the real session (SDK stand-in) and the real HTTP server.
// ADR-0028 section 1 and 7: createSession takes two injected functions, hasPlan and crewSlugs.
// ---------------------------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-rework-server-check-'))
let counter = 0
const tmpDir = (name: string) => {
  const d = path.join(tmpRoot, `${name}-${++counter}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'

interface BootOpts { files?: Record<string, string>; slugs?: string[] }
async function boot(opts: BootOpts = {}) {
  const { createStore } = await import(serverUrl('state/index.ts'))
  const { createSession } = await import(serverUrl('session/index.ts'))
  const { createServer } = await import(serverUrl('http/index.ts'))
  ;(globalThis as any).__trussStub = undefined
  const repo = tmpDir('repo')
  const truss = tmpDir('truss')
  for (const [name, text] of Object.entries(opts.files ?? {})) fs.writeFileSync(path.join(truss, name), text)
  const store = createStore({ repo, trussDir: truss, pollMs: 50 })
  const flags = { plan: false, slugs: opts.slugs ?? [] }
  const session = createSession({
    repo,
    pluginPath: path.join(path.dirname(uiDir), 'plugins', 'truss'),
    hasPlan: () => flags.plan,
    crewSlugs: () => flags.slugs,
  })
  session.subscribe((v: unknown) => store.setSession(v))
  const server = createServer({ state: store, session, webDir: tmpDir('web') })
  const { port, token } = await server.listen(0)
  const post = (route: string, body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const r = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: route, agent: false,
          headers: {
            host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(data)), cookie: `truss-ui-${port}=${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            let json: any = null
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not json */ }
            resolve({ status: res.statusCode ?? 0, json })
          })
        },
      )
      r.on('error', reject)
      r.end(data)
    })
  return {
    store, session, post, flags, truss,
    state: () => store.snapshot().state as any,
    // The first message starts the SDK query; wait until the stand-in exists and has taken it.
    async start(text = 'hello') {
      const r = await post('/api/message', { text })
      assert.equal(r.status, 202)
      await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the first message')
    },
    async close() {
      await session.close()
      await server.close()
      store.close()
    },
  }
}
type Wired = Awaited<ReturnType<typeof boot>>

// A flow entry's shape (ADR-0028 section 7).
const flowOf = (w: Wired): any[] => w.state().session.flow
function assertFlowEntry(e: any, tool: string) {
  assert.equal(e.tool, tool)
  assert.equal(typeof e.at, 'string')
  assert.ok(!Number.isNaN(Date.parse(e.at)), `${e.at} is an ISO time`)
  assert.equal(typeof e.summary, 'string')
  assert.ok(e.summary.length <= 200, 'summary holds at most 200 characters')
  assert.ok(e.to === null || typeof e.to === 'string', 'to is a slug or null')
}

// ===========================================================================
// R-40: the PM's hand-offs fold into the bounded session flow list
// ===========================================================================
const SLUGS = ['rework', 'rework-network', 'rework-network-qc', 'rework-chat', 'rework-docs']

test('R-40: the PM Agent, SendMessage and Workflow calls fold into session.flow, oldest first, with tool, to and summary', async () => {
  const w = await boot({ slugs: SLUGS })
  try {
    await w.start()
    stub()!.emit(row('init'))
    stub()!.emit(row('agent-crew'))
    stub()!.emit(row('sendmessage'))
    stub()!.emit(row('workflow'))
    await until(() => (flowOf(w)?.length ?? 0) >= 3, 'three flow entries in session.flow')
    const flow = flowOf(w)
    assert.deepEqual(flow.map((e) => e.tool), ['Agent', 'SendMessage', 'Workflow'], 'one entry per call, oldest first')
    flow.forEach((e, i) => assertFlowEntry(e, ['Agent', 'SendMessage', 'Workflow'][i]))
    assert.equal(flow[0].summary, 'Build the rework-network view', 'Agent: the input description')
    assert.equal(flow[1].summary, 'Plan approved by the client.', 'SendMessage: the first line of the message')
    assert.equal(flow[2].summary, 'Run the rework-docs crew', 'Workflow: the input description')
    assert.deepEqual(flow.map((e) => e.at), [...flow.map((e) => e.at)].sort(), 'oldest first by time')
  } finally {
    await w.close()
  }
})

test('R-40: to is the longest crew slug found as a whole word in SendMessage to, then description, then prompt', async () => {
  const w = await boot({ slugs: SLUGS })
  try {
    await w.start()
    stub()!.emit(row('agent-crew')) // description names rework-network (and "rework" is a shorter slug)
    stub()!.emit(row('agent-longest')) // description names rework-network-qc and rework-network
    stub()!.emit(row('agent-prompt-only')) // only the prompt names rework-docs
    stub()!.emit(row('sendmessage')) // to: rework-chat
    stub()!.emit(row('workflow')) // description names rework-docs
    stub()!.emit(row('agent-noslug')) // names no crew
    stub()!.emit(row('sendmessage-via-message')) // to is an agent id; only the message names a crew
    await until(() => (flowOf(w)?.length ?? 0) >= 7, 'seven flow entries')
    assert.deepEqual(
      flowOf(w).map((e) => e.to),
      ['rework-network', 'rework-network-qc', 'rework-docs', 'rework-chat', 'rework-docs', null, null],
    )
  } finally {
    await w.close()
  }
})

test('R-40: only the PM\'s own top-level Agent, SendMessage and Workflow blocks count; Bash and a subagent\'s calls do not', async () => {
  const w = await boot({ slugs: SLUGS })
  try {
    await w.start()
    stub()!.emit(row('bash'))
    stub()!.emit(row('subagent-agent'))
    const sub = clone(row('agent-crew'))
    sub.agent_id = 'abfa7c0e63b95d994' // a subagent line carries agent_id (fold.ts) even without a parent id
    sub.parent_tool_use_id = null
    stub()!.emit(sub)
    stub()!.emit(row('workflow')) // the one that counts, last
    await until(() => (flowOf(w)?.length ?? 0) >= 1, 'the Workflow entry in session.flow')
    // Let the earlier messages settle: a stray entry would sit before the Workflow one.
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(flowOf(w).map((e) => e.tool), ['Workflow'], 'Bash and subagent calls add no entry')
  } finally {
    await w.close()
  }
})

test('R-40: a summary is cut to 200 characters', async () => {
  const w = await boot({ slugs: SLUGS })
  try {
    await w.start()
    const long = clone(row('agent-crew'))
    long.message.content[0].input.description = 'rework-network ' + 'x'.repeat(285)
    const msg = clone(row('sendmessage'))
    msg.message.content[0].input.message = 'y'.repeat(300) + '\nsecond line'
    stub()!.emit(long)
    stub()!.emit(msg)
    await until(() => (flowOf(w)?.length ?? 0) >= 2, 'two flow entries')
    for (const e of flowOf(w)) {
      assert.ok(e.summary.length > 0 && e.summary.length <= 200, `summary length ${e.summary.length} is within 1..200`)
    }
    assert.ok(!flowOf(w)[1].summary.includes('second line'), 'SendMessage keeps the first line only')
  } finally {
    await w.close()
  }
})

test('R-40: the flow list holds at most the last 200 entries, oldest first', async () => {
  const w = await boot({ slugs: SLUGS })
  try {
    await w.start()
    for (let i = 1; i <= 250; i++) {
      const m = clone(row('agent-noslug'))
      m.message.content[0].id = `toolu_bound_${i}`
      m.message.content[0].input.description = `call ${i}`
      stub()!.emit(m)
    }
    await until(() => flowOf(w)?.some((e) => e.summary === 'call 250'), 'the 250th call in session.flow', 8000)
    const flow = flowOf(w)
    assert.equal(flow.length, 200, 'the list is bounded at 200')
    assert.equal(flow[0].summary, 'call 51', 'the 50 oldest entries are dropped')
    assert.equal(flow[199].summary, 'call 250', 'the newest entry is last')
  } finally {
    await w.close()
  }
})

// ===========================================================================
// R-41: the routing table of ADR-0028 section 1
// ===========================================================================
const GOAL_LINE = '[Truss UI: new goal] Plan this as a new goal for the run.'
const ADD_LINE = '[Truss UI: detail] Add this to the current goal.'

// Send one message, wait for the SDK to take it, and return what it took.
async function sendAndTake(w: Wired, body: Record<string, unknown>): Promise<string> {
  const before = stub()?.sent.length ?? 0
  const r = await w.post('/api/message', body)
  assert.equal(r.status, 202)
  await until(() => (stub()?.sent.length ?? 0) > before, 'the session to take the message')
  return stub()!.sent[before]
}
const endTurn = async (w: Wired) => {
  stub()!.emit({ type: 'result', subtype: 'success', total_cost_usd: 0.01, modelUsage: {} })
  await until(() => w.state().session.status === 'waiting', 'the turn to end')
}

test('R-41: with no plan.json and no earlier goal, intent goal sends /truss:run <text> and the transcript keeps the text as typed', async () => {
  const w = await boot()
  try {
    const sent = await sendAndTake(w, { text: 'add CSV export to the report page', intent: 'goal' })
    assert.equal(sent, '/truss:run add CSV export to the report page')
    const e = w.state().transcript.find((x: any) => x.role === 'user')
    assert.equal(e.text, 'add CSV export to the report page', 'the transcript is not rewritten')
    assert.equal(e.intent, 'goal')
  } finally {
    await w.close()
  }
})

test('R-41: a second goal while the PM is still planning (no plan yet) goes as the mid-run intake line, not a second /truss:run', async () => {
  const w = await boot()
  try {
    assert.equal(await sendAndTake(w, { text: 'first goal', intent: 'goal' }), '/truss:run first goal')
    await endTurn(w)
    assert.equal(w.flags.plan, false)
    assert.equal(await sendAndTake(w, { text: 'second goal', intent: 'goal' }), `${GOAL_LINE}\n\nsecond goal`)
  } finally {
    await w.close()
  }
})

test('R-41: with a plan (hasPlan true), intent goal sends INTENT_LINES.goal, a blank line, then the text', async () => {
  const w = await boot()
  try {
    w.flags.plan = true
    assert.equal(await sendAndTake(w, { text: 'a new goal for the run', intent: 'goal' }), `${GOAL_LINE}\n\na new goal for the run`)
  } finally {
    await w.close()
  }
})

test('R-41: hasPlan is read when the message is sent, so a plan that appears later changes the next goal', async () => {
  const w = await boot()
  try {
    // A goal queued behind a running turn is decided when it goes out, not when it was typed; so settle the first turn.
    await w.start('hello') // no intent: not a goal
    await endTurn(w)
    w.flags.plan = false
    assert.equal(await sendAndTake(w, { text: 'goal one', intent: 'goal' }), '/truss:run goal one')
    await endTurn(w)
    w.flags.plan = true
    assert.equal(await sendAndTake(w, { text: 'goal two', intent: 'goal' }), `${GOAL_LINE}\n\ngoal two`)
  } finally {
    await w.close()
  }
})

test('R-41: intent add sends INTENT_LINES.add, a blank line, then the text, with or without a plan', async () => {
  const w = await boot()
  try {
    assert.equal(await sendAndTake(w, { text: 'also per key', intent: 'add' }), `${ADD_LINE}\n\nalso per key`)
    await endTurn(w)
    w.flags.plan = true
    assert.equal(await sendAndTake(w, { text: 'and per org', intent: 'add' }), `${ADD_LINE}\n\nand per org`)
  } finally {
    await w.close()
  }
})

test('R-41: no intent sends the text unchanged, with or without a plan', async () => {
  const w = await boot()
  try {
    assert.equal(await sendAndTake(w, { text: 'plain words' }), 'plain words')
    await endTurn(w)
    w.flags.plan = true
    assert.equal(await sendAndTake(w, { text: 'more plain words', intent: null }), 'more plain words')
  } finally {
    await w.close()
  }
})

test('R-41: the goal text is not given a system prompt line when it starts the run', async () => {
  const w = await boot()
  try {
    const sent = await sendAndTake(w, { text: 'ship it', intent: 'goal' })
    assert.ok(!sent.includes('[Truss UI'), 'the first goal carries no [Truss UI ...] line')
    assert.ok(sent.startsWith('/truss:run '), 'it starts with the slash command so the SDK runs the skill')
  } finally {
    await w.close()
  }
})

// ===========================================================================
// R-42: the member's task from the SDK's task_started and task_progress description
// ===========================================================================
const AGENT_A = 'abfa7c0e63b95d994' // the task_id in the fixture rows
const AGENT_B = 'a7f3c9d2e1b04a856'
const AGENT_C = 'a0000000000000001' // never named by any task message

const PLAN = JSON.stringify({
  version: 3, goal: 'Rework the UI', approval: 'client', approvedAt: '2026-11-04T15:31:12Z', architecture: 'docs/architecture.md',
  maxParallelCrews: 2, reworkAllowance: 2,
  crews: [{ slug: 'alpha', stage: 0, verdict: 'build', modules: ['m'], owns: ['src/alpha.ts'], acceptanceTest: 'npm test', acceptanceTestProved: true, estAgents: 3, status: 'planned' }],
})
const spawnLine = (agent: string, agentId: string, type: string) => ({
  v: 1, ts: '2026-11-04T16:00:00Z', event: 'spawn', crew: 'alpha', agent, agentId, type, model: 'opus', effort: 'high', by: 'main',
})
const EVENTS = jsonl([
  spawnLine('alpha', AGENT_A, 'truss:project-manager'),
  spawnLine('alpha-builder', AGENT_B, 'kit:builder'),
  spawnLine('alpha-qc', AGENT_C, 'truss:qc-engineer'),
])
const crewOf = (w: Wired): any => w.state().run?.crews?.find((c: any) => c.slug === 'alpha')
const memberOf = (w: Wired, agent: string): any => {
  const c = crewOf(w)
  return c?.foreman?.name === agent ? c.foreman : c?.members?.find((m: any) => m.name === agent)
}

test('R-42: a member whose spawn agentId equals a task_id gets Member.task from task_started, then from the latest task_progress', async () => {
  const w = await boot({ files: { 'plan.json': PLAN, 'events.jsonl': EVENTS } })
  try {
    await w.start()
    await until(() => memberOf(w, 'alpha-builder') !== undefined, 'the crew members in the snapshot')
    assert.equal(memberOf(w, 'alpha-builder').agentId, AGENT_B, 'Member.agentId keeps the spawn line agentId')
    stub()!.emit(row('task-started'))
    stub()!.emit(row('task-started-other'))
    await until(() => memberOf(w, 'alpha')?.task === 'Run ls in working directory', 'the foreman task from task_started')
    assert.equal(memberOf(w, 'alpha-builder').task, 'Write the network spec')
    stub()!.emit(row('task-progress'))
    await until(() => memberOf(w, 'alpha')?.task === 'Running List directory contents', 'the latest task_progress description')
    assert.equal(memberOf(w, 'alpha-builder').task, 'Write the network spec', 'another task is not touched')
  } finally {
    await w.close()
  }
})

test('R-42: a member no task message names has task null (the client then falls back to goal, activity, "No activity yet")', async () => {
  const w = await boot({ files: { 'plan.json': PLAN, 'events.jsonl': EVENTS } })
  try {
    await w.start()
    stub()!.emit(row('task-started'))
    await until(() => memberOf(w, 'alpha')?.task === 'Run ls in working directory', 'the matched task to appear')
    const qc = memberOf(w, 'alpha-qc')
    assert.equal(qc.agentId, AGENT_C)
    assert.equal(qc.task, null, 'no match gives null, not undefined and not the foreman task')
  } finally {
    await w.close()
  }
})

test('R-42: the session keeps the latest task per task_id up to 500 entries; the newest of 600 tasks still matches', async () => {
  const lastId = 'a' + 'f'.repeat(15) + '9'
  const events = jsonl([spawnLine('alpha', AGENT_A, 'truss:project-manager'), spawnLine('alpha-builder', lastId, 'kit:builder')])
  const w = await boot({ files: { 'plan.json': PLAN, 'events.jsonl': events } })
  try {
    await w.start()
    for (let i = 0; i < 599; i++) {
      const m = clone(row('task-started-other'))
      m.task_id = 'a' + String(i).padStart(16, '0')
      m.description = `filler ${i}`
      stub()!.emit(m)
    }
    const last = clone(row('task-started-other'))
    last.task_id = lastId
    last.description = 'the newest task'
    stub()!.emit(last)
    await until(() => memberOf(w, 'alpha-builder')?.task === 'the newest task', 'the newest task to reach the snapshot', 8000)
  } finally {
    await w.close()
  }
})

// ===========================================================================
// R-47: a reply request says whether the turn is an approval ask (ADR-0028 section 2)
// ===========================================================================
async function approvalAskFor(text: string): Promise<unknown> {
  const w = await boot()
  try {
    await w.start()
    stub()!.emit({ type: 'result', subtype: 'success', result: text, is_error: false, total_cost_usd: 0.01, modelUsage: {} })
    await until(() => (w.state().requests as any[]).some((r) => r.kind === 'reply'), 'a reply request to open')
    const req = (w.state().requests as any[]).find((r) => r.kind === 'reply')
    assert.equal(req.text, text, 'the reply request still carries the PM text')
    return req.approvalAsk
  } finally {
    await w.close()
  }
}

test('R-47: a turn whose last paragraph asks for approval and ends with ? opens a reply with approvalAsk true', async () => {
  assert.equal(await approvalAskFor('The plan has three crews.\n\nDo you approve this plan?'), true)
  assert.equal(await approvalAskFor('Plan is ready, so can you approve it?'), true)
})

test('R-47: the bug note turn "Nothing is waiting on approval ... give me something new." is not an approval ask', async () => {
  const text = 'Nothing is waiting on approval right now. Every crew is merged, so give me something new.'
  assert.notEqual(await approvalAskFor(text), true, 'approvalAsk is false or absent')
  // The same words as a question: a "nothing" or "no" before approval in the sentence rules it out.
  assert.notEqual(await approvalAskFor('Is nothing waiting on approval?'), true)
})

test('R-47: only the last non-empty paragraph counts, and it must end with ?', async () => {
  assert.notEqual(await approvalAskFor('Please approve the plan?\n\nThanks for your time.'), true)
  assert.notEqual(await approvalAskFor('I need your approval for the plan.'), true)
  assert.equal(await approvalAskFor('Here is the plan.\n\nDo you approve it?\n\n'), true, 'trailing blank lines are ignored')
})

test('R-47: a reply request that is an approval ask carries a boolean, and not-an-ask is false or absent, never another type', async () => {
  const yes = await approvalAskFor('Do you approve the plan?')
  const no = await approvalAskFor('The build is done. What next?')
  assert.equal(yes, true)
  assert.ok(no === undefined || no === false, 'not an approval ask is false or absent')
})
