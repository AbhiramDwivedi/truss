// Tests for ADR-0023 session gaps a (intent and id), b (session.queue) and e (usage.live), written from the ADR
// and ui/contract/state.schema.json before the implementation. They cover cases ui/contract/gaps.check.ts does not.
// The Agent SDK is replaced by a stand-in through a module resolve hook, so no live Claude session runs.
// Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; the server binds port 0.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.dirname(path.dirname(here));
const serverUrl = (rel: string) => pathToFileURL(path.join(uiDir, 'server', rel)).href;

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
`;
const HOOKS_SOURCE = `
export async function resolve(specifier, context, next) {
  if (specifier === '@anthropic-ai/claude-agent-sdk') {
    return { url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(STUB_SOURCE)}), shortCircuit: true };
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOKS_SOURCE));

interface Stub { sent: string[]; emit(m: unknown): void }
const stub = (): Stub | undefined => (globalThis as any).__trussStub;

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const GOAL_LINE = '[Truss UI: new goal] Plan this as a new goal for the run.';
const ADD_LINE = '[Truss UI: detail] Add this to the current goal.';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-session-gaps-'));
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });
let counter = 0;
const tmpDir = (name: string) => {
  const d = path.join(tmpRoot, `${name}-${++counter}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

// The real store, session (SDK stand-in) and HTTP server; messages go in through POST /api/message.
async function boot() {
  const { createStore } = await import(serverUrl('state/index.ts'));
  const { createSession } = await import(serverUrl('session/index.ts'));
  const { createServer } = await import(serverUrl('http/index.ts'));
  (globalThis as any).__trussStub = undefined;
  const repo = tmpDir('repo');
  const store = createStore({ repo, pollMs: 50 });
  const session = createSession({ repo, pluginPath: path.join(path.dirname(uiDir), 'plugins', 'truss') });
  session.subscribe((v: unknown) => store.setSession(v));
  const server = createServer({ state: store, session, webDir: tmpDir('web') });
  const { port, token } = await server.listen(0);
  const post = (body: unknown): Promise<{ status: number; json: any }> =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1', port, method: 'POST', path: '/api/message', agent: false,
          headers: {
            host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(data)), cookie: `truss-ui-${port}=${token}`,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            let json: any = null;
            try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not json */ }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      r.on('error', reject);
      r.end(data);
    });
  return {
    store, session, post,
    state: () => store.snapshot().state as any,
    async close() { await session.close(); await server.close(); store.close(); },
  };
}

const result = (cost = 0.01) => ({ type: 'result', subtype: 'success', total_cost_usd: cost, modelUsage: {} });

// ===========================================================================
// Gap a
// ===========================================================================
test('gap a: the fixed line is kept off the transcript, and multi-line text with edge whitespace goes through as typed', async () => {
  const w = await boot();
  try {
    const text = '  first line\n\nsecond line\n  ';
    const r = await w.post({ text, intent: 'add' });
    assert.equal(r.status, 202);
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the session to take the message');
    assert.equal(stub()!.sent[0], `${ADD_LINE}\n\n${text}`);
    const e = w.state().transcript.find((x: any) => x.role === 'user');
    assert.equal(e.text, text);
    assert.ok(!e.text.includes('[Truss UI'), 'no fixed line in the entry');
    assert.equal(e.id, r.json.id);
    assert.equal(e.intent, 'add');
  } finally { await w.close(); }
});

test('gap a: intent goal sends the goal line, and an absent intent sends no fixed line at all', async () => {
  const w = await boot();
  try {
    await w.post({ text: 'alpha', intent: 'goal' });
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'first send');
    stub()!.emit(result());
    await until(() => w.state().session.status === 'waiting', 'the turn to end');
    await w.post({ text: 'beta' });
    await until(() => (stub()?.sent.length ?? 0) >= 2, 'second send');
    assert.equal(stub()!.sent[0], `${GOAL_LINE}\n\nalpha`);
    assert.equal(stub()!.sent[1], 'beta');
    assert.ok(!stub()!.sent[1].includes('[Truss UI'));
  } finally { await w.close(); }
});

test('gap a: every user entry gets its own id and assistant entries carry id null and intent null', async () => {
  const w = await boot();
  try {
    const ids: string[] = [];
    ids.push((await w.post({ text: 'one', intent: 'goal' })).json.id);
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'first send');
    stub()!.emit({
      type: 'assistant', parent_tool_use_id: null,
      message: { id: 'msg_1', content: [{ type: 'text', text: 'working on it' }], usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    });
    await until(() => w.state().transcript.some((e: any) => e.role === 'assistant'), 'the assistant entry');
    ids.push((await w.post({ text: 'two' })).json.id);
    ids.push((await w.post({ text: 'three', intent: 'add' })).json.id);
    assert.equal(new Set(ids).size, 3, 'ids are unique');
    const t = w.state().transcript;
    const users = t.filter((e: any) => e.role === 'user');
    assert.deepEqual(users.map((e: any) => e.id), ids);
    assert.deepEqual(users.map((e: any) => e.intent), ['goal', null, 'add']);
    for (const e of t.filter((x: any) => x.role !== 'user')) {
      assert.ok('id' in e && 'intent' in e, `${e.role} entry has id and intent keys`);
      assert.equal(e.id, null);
      assert.equal(e.intent, null);
    }
  } finally { await w.close(); }
});

// ===========================================================================
// Gap b
// ===========================================================================
test('gap b: queue lists accepted messages oldest first with the message id, text as typed, intent and an RFC 3339 UTC at', async () => {
  const w = await boot();
  try {
    await w.post({ text: 'start', intent: 'goal' });
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'first send');
    await until(() => w.state().session.queue?.length === 0, 'an empty queue while the first turn runs');
    const a = await w.post({ text: 'queued A', intent: 'add' });
    const b = await w.post({ text: 'queued B' });
    const c = await w.post({ text: 'queued C', intent: 'goal' });
    await until(() => w.state().session.queue.length >= 1, 'something queued');
    const q = w.state().session.queue;
    const order = [a.json.id, b.json.id, c.json.id];
    assert.deepEqual(q.map((i: any) => i.id), order.slice(0, q.length), 'oldest first, nothing reordered or skipped');
    for (const item of q) {
      assert.deepEqual(Object.keys(item).sort(), ['at', 'id', 'intent', 'text']);
      assert.match(item.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    }
    const byId = Object.fromEntries(q.map((i: any) => [i.id, i]));
    if (byId[b.json.id]) {
      assert.equal(byId[b.json.id].text, 'queued B');
      assert.equal(byId[b.json.id].intent, null, 'a message with no intent has intent null in the queue');
    }
    for (let i = 1; i < q.length; i++) assert.ok(Date.parse(q[i].at) >= Date.parse(q[i - 1].at), 'at does not go backwards');
  } finally { await w.close(); }
});

test('gap b: a queued message is not also a sent one, and the queue drains to [] once every message has gone out', async () => {
  const w = await boot();
  try {
    await w.post({ text: 'first' });
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'first send');
    const second = await w.post({ text: 'second', intent: 'add' });
    await until(() => w.state().session.queue.some((i: any) => i.id === second.json.id), 'second queued');
    assert.equal(stub()!.sent.length, 1, 'the SDK has not taken the queued message yet');
    stub()!.emit(result());
    await until(() => (stub()?.sent.length ?? 0) >= 2, 'second send');
    await until(() => w.state().session.queue.length === 0, 'the queue to empty');
    assert.ok(!w.state().session.queue.some((i: any) => i.id === second.json.id));
    assert.deepEqual(w.state().session.queue, []);
  } finally { await w.close(); }
});

test('gap b: an idle session reports queue [] in the store snapshot too', async () => {
  const w = await boot();
  try {
    assert.deepEqual(w.state().session.queue, []);
    assert.deepEqual((w.store.snapshot().state as any).session.queue, []);
  } finally { await w.close(); }
});

// ===========================================================================
// Gap e
// ===========================================================================
const U = (i: number, o: number, r: number, c: number) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: r, cache_creation_input_tokens: c });
const assistant = (id: string, usage: unknown, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { id, content: [{ type: 'text', text: 'x' }], usage },
});

test('gap e: before the first result, usage stays null (live is not invented)', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'));
  let v = foldMessage(initialView(), assistant('m1', U(1, 2, 3, 4)));
  v = foldMessage(v, { type: 'system', subtype: 'task_progress', task_id: 't', usage: { total_tokens: 9 } });
  assert.equal(v.session.usage, null);
});

test('gap e: live is cumulative across turns and keeps the result fields', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'));
  let v = foldMessage(initialView(), assistant('m1', U(1, 1, 1, 1)));
  v = foldMessage(v, result(0.25));
  assert.equal(v.session.usage.live.totalTokens, 4);
  v = foldMessage(v, assistant('m2', U(2, 2, 2, 2)));
  v = foldMessage(v, result(0.5));
  assert.equal(v.session.usage.live.totalTokens, 12, 'the second turn adds to the first');
  assert.equal(v.session.usage.live.inputTokens, 3);
  assert.equal(v.session.usage.results, 2);
  assert.equal(v.session.usage.costUsd, 0.75);
});

test('gap e: a missing usage counter counts as 0, and a subagent assistant message adds nothing to the main counters', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'));
  let v = foldMessage(initialView(), assistant('m1', { input_tokens: 7, output_tokens: 3 }));
  v = foldMessage(v, assistant('m2', U(500, 500, 500, 500), 'toolu_sub'));
  v = foldMessage(v, result());
  const l = v.session.usage.live;
  assert.deepEqual([l.inputTokens, l.outputTokens, l.cacheReadInputTokens, l.cacheCreationInputTokens, l.subagentTokens, l.totalTokens], [7, 3, 0, 0, 0, 10]);
});

test('gap e: a task_progress total replaces that task, it does not add to it', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'));
  let v = initialView();
  for (const n of [10, 40, 25]) v = foldMessage(v, { type: 'system', subtype: 'task_progress', task_id: 'only', usage: { total_tokens: n } });
  v = foldMessage(v, result());
  assert.equal(v.session.usage.live.subagentTokens, 25, 'the latest value, even if lower');
  assert.equal(v.session.usage.live.totalTokens, 25);
});

test('gap e: folding the recorded SDK stream gives the hand-summed total', async () => {
  const { initialView, foldMessage } = await import(serverUrl('session/index.ts'));
  const lines = fs.readFileSync(path.join(uiDir, 'contract', 'fixtures', 'sdk-stream.jsonl'), 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));

  // Hand sum, independent of the reducer: top-level assistant usage once per message id, plus the latest task_progress total per task.
  const seen = new Set<string>();
  const sum = { i: 0, o: 0, r: 0, c: 0 };
  const tasks = new Map<string, number>();
  for (const m of lines) {
    if (m.type === 'assistant' && !m.parent_tool_use_id) {
      if (seen.has(m.message.id)) continue;
      seen.add(m.message.id);
      const u = m.message.usage ?? {};
      sum.i += u.input_tokens ?? 0; sum.o += u.output_tokens ?? 0; sum.r += u.cache_read_input_tokens ?? 0; sum.c += u.cache_creation_input_tokens ?? 0;
    }
    if (m.type === 'system' && m.subtype === 'task_progress') tasks.set(m.task_id, m.usage.total_tokens);
  }
  const sub = [...tasks.values()].reduce((a, b) => a + b, 0);
  assert.ok(seen.size > 1 && sub > 0, 'the fixture has several assistant messages and a task_progress');
  const repeats = lines.filter((m) => m.type === 'assistant' && !m.parent_tool_use_id).length;
  assert.ok(repeats > seen.size, 'the fixture repeats a message id across content blocks');

  let v = initialView();
  for (const m of lines) v = foldMessage(v, m);
  const live = v.session.usage?.live;
  assert.ok(live, 'usage.live is set after the recorded results');
  assert.equal(live.inputTokens, sum.i);
  assert.equal(live.outputTokens, sum.o);
  assert.equal(live.cacheReadInputTokens, sum.r);
  assert.equal(live.cacheCreationInputTokens, sum.c);
  assert.equal(live.subagentTokens, sub);
  assert.equal(live.totalTokens, sum.i + sum.o + sum.r + sum.c + sub);
  assert.match(live.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
});
