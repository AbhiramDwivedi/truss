// Tests for POST /api/message with an intent (ADR-0023 gap a), written from the ADR before the implementation.
// The route runs over the real store and session; the Agent SDK is replaced by a stand-in through a module
// resolve hook so no live Claude session runs. Erasable TypeScript, node:test, built-ins only; port 0 only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { call } from './helpers.ts';

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
const stub = (): { sent: string[]; emit(m: unknown): void } | undefined => (globalThis as any).__trussStub;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-message-test-'));
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
let n = 0;
const tmpDir = (name: string) => { const d = path.join(tmpRoot, `${name}-${++n}`); fs.mkdirSync(d, { recursive: true }); return d; };

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function boot() {
  const { createStore } = await import(serverUrl('state/index.ts'));
  const { createSession } = await import(serverUrl('session/index.ts'));
  const { createServer } = await import(serverUrl('http/index.ts'));
  (globalThis as any).__trussStub = undefined;
  const repo = tmpDir('repo');
  const web = tmpDir('web');
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>t</title>');
  const store = createStore({ repo, pollMs: 50 });
  const session = createSession({ repo, pluginPath: path.join(path.dirname(uiDir), 'plugins', 'truss') });
  session.subscribe((v: unknown) => store.setSession(v));
  const server = createServer({ state: store, session, webDir: web });
  const l = await server.listen(0);
  const origin = `http://127.0.0.1:${l.port}`;
  const headers = { origin, cookie: `truss-ui-${l.port}=${l.token}`, 'content-type': 'application/json' };
  return {
    store, session,
    state: () => store.snapshot().state as any,
    post: (route: string, body: unknown) => call(l.port, 'POST', route, { headers, body: JSON.stringify(body) }),
    postRaw: (route: string, body: string) => call(l.port, 'POST', route, { headers, body }),
    async close() { await session.close(); await server.close(); store.close(); },
  };
}

test('message: intent goal, intent add, intent null and no intent all answer 202 {ok: true, id} with distinct non-empty ids', async () => {
  const w = await boot();
  try {
    const bodies = [{ text: 'a', intent: 'goal' }, { text: 'b', intent: 'add' }, { text: 'c', intent: null }, { text: 'd' }];
    const ids: string[] = [];
    for (const b of bodies) {
      const r = await w.post('/api/message', b);
      assert.equal(r.status, 202, JSON.stringify(b));
      assert.deepEqual(Object.keys(r.json).sort(), ['id', 'ok'], 'the body holds ok and id only');
      assert.equal(r.json.ok, true);
      assert.equal(typeof r.json.id, 'string');
      assert.ok(r.json.id.length > 0);
      ids.push(r.json.id);
    }
    assert.equal(new Set(ids).size, ids.length, 'ids are unique within the process');
  } finally { await w.close(); }
});

test('message: every other intent value answers 400 {error: "intent"} and sends nothing', async () => {
  const w = await boot();
  try {
    for (const intent of ['bogus', 'GOAL', 'Add', '', ' goal', 'answer', 0, 1, true, false, [], ['goal'], {}]) {
      const r = await w.post('/api/message', { text: 'hello', intent });
      assert.equal(r.status, 400, `intent ${JSON.stringify(intent)}`);
      assert.deepEqual(r.json, { error: 'intent' }, `intent ${JSON.stringify(intent)}`);
    }
    assert.equal(w.state().transcript.length, 0, 'no transcript entry');
    assert.deepEqual(w.state().session.queue, [], 'nothing queued');
    assert.equal(stub()?.sent.length ?? 0, 0, 'nothing reached the session');
  } finally { await w.close(); }
});

test('message: a bad intent does not stop the next good message', async () => {
  const w = await boot();
  try {
    assert.equal((await w.post('/api/message', { text: 'x', intent: 'nope' })).status, 400);
    const r = await w.post('/api/message', { text: 'fine', intent: 'goal' });
    assert.equal(r.status, 202);
    await until(() => (stub()?.sent.length ?? 0) >= 1, 'the good message to reach the session');
    assert.equal(stub()!.sent.length, 1);
    assert.ok(stub()!.sent[0].endsWith('\n\nfine'));
  } finally { await w.close(); }
});

test('message: the other message errors keep their shape (blank text answers 400 {error: "text"}, bad JSON 400)', async () => {
  const w = await boot();
  try {
    const blank = await w.post('/api/message', { text: '   ', intent: 'goal' });
    assert.equal(blank.status, 400);
    assert.deepEqual(blank.json, { error: 'text' });
    const bad = await w.postRaw('/api/message', '{nope');
    assert.equal(bad.status, 400);
    assert.equal(w.state().transcript.length, 0);
  } finally { await w.close(); }
});

test('message: the answer route is unchanged, an unknown request id still answers 404 {error: "unknown"} and makes no message', async () => {
  const w = await boot();
  try {
    const r = await w.post('/api/requests/no-such-request/answer', { decision: 'message', message: 'hi', intent: 'goal' });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { error: 'unknown' });
    assert.equal(w.state().transcript.length, 0);
    assert.equal(stub()?.sent.length ?? 0, 0);
  } finally { await w.close(); }
});
