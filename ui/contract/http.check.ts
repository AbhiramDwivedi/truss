// Contract check for ui-server (ADR-0011 Decisions 5, 6, 9). Erasable TypeScript, node:test, built-ins only.
// It imports ui/server/http and hands it two small in-test implementations of StateSource and
// SessionControl (the server takes them as interfaces; this is not a fake Claude session).
// Every server it starts binds port 0.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mod: any;
try {
  mod = await import('../server/http/index.ts');
} catch (cause) {
  console.error('cause: ' + (cause instanceof Error ? cause.message : String(cause)));
  throw new Error('producer missing: ui/server/http');
}

const INSTANCE = '0123456789abcdef';

// ---- the state stand-in: a snapshot, a delta log with a ring floor, subscribers --------------
function makeState() {
  const log: any[] = [];
  const subs = new Set<(d: any) => void>();
  let floor = 0; // deltas with seq <= floor have left the ring
  let emitDuringSnapshot = false;
  const st = {
    emit(set: Record<string, unknown>) {
      const d = { type: 'delta', seq: log.length + 1, set };
      log.push(d);
      for (const f of [...subs]) f(d);
      return d;
    },
    dropBefore(seq: number) { floor = seq; },
    emitDuringSnapshot() { emitDuringSnapshot = true; },
    get subscribers() { return subs.size; },
    snapshot() {
      if (emitDuringSnapshot) { emitDuringSnapshot = false; st.emit({ notices: [] }); }
      return {
        type: 'snapshot', instance: INSTANCE, seq: log.length,
        state: {
          v: 1, repo: '/tmp/repo', trussDir: { path: null, exists: false },
          session: { status: 'idle', sessionId: null, model: null, claudeCodeVersion: null, permissionMode: null, plugin: null, usage: null, backgroundTasks: 0, error: null },
          requests: [], transcript: [], run: null, decisions: [], adrs: [], design: null, notices: [],
        },
      };
    },
    since(seq: number) {
      if (!Number.isInteger(seq) || seq < floor || seq > log.length) return null;
      return log.slice(seq);
    },
    subscribe(fn: (d: any) => void) { subs.add(fn); return () => { subs.delete(fn); }; },
    async readImage() { return null; },
  };
  return st;
}

// ---- the session stand-in: requests that settle once ---------------------------------------
function makeSession() {
  const requests = new Map<string, any>();
  const s = {
    sent: [] as string[],
    settled: [] as Array<{ id: string; body: unknown }>,
    ended: false,
    add(r: any) { requests.set(r.id, r); },
    get(id: string) { return requests.get(id); },
    send(text: unknown) {
      if (s.ended) return { ok: false, error: 'ended' };
      if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'text' };
      s.sent.push(text);
      return { ok: true };
    },
    answer(id: string, body: any) {
      const r = requests.get(id);
      if (!r) return { ok: false, error: 'unknown' };
      if (r.status === 'cancelled') return { ok: false, error: 'cancelled', request: r };
      if (r.status === 'answered') return { ok: false, error: 'answered', request: r };
      const fits = r.kind === 'question'
        ? body && typeof body === 'object' && body.answers && typeof body.answers === 'object'
        : body && (body.decision === 'allow' || body.decision === 'deny');
      if (!fits) return { ok: false, error: 'answer', request: r };
      r.status = 'answered';
      r.answeredAt = new Date().toISOString();
      if (r.kind === 'question') r.answers = body.answers; else r.decision = body.decision;
      s.settled.push({ id, body });
      return { ok: true, request: r };
    },
  };
  return s;
}

// ---- tiny HTTP client (fetch cannot set Host) ------------------------------------------------
interface Res { status: number; headers: http.IncomingHttpHeaders; text: string; json: any }
function call(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body));
    const r = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    r.end(o.body);
  });
}

interface SseEvent { id: string | null; event: string; data: any; raw: string }
function openSse(port: number, path: string, headers: Record<string, string> = {}) {
  const events: SseEvent[] = [];
  const waiters: Array<() => void> = [];
  let buf = '';
  let head: { status: number; headers: http.IncomingHttpHeaders } | null = null;
  const rawChunks: string[] = [];
  let req: http.ClientRequest;
  const ready = new Promise<void>((resolve, reject) => {
    req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', ...headers }, agent: false }, (res) => {
      head = { status: res.statusCode ?? 0, headers: res.headers };
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        rawChunks.push(c);
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          let id: string | null = null, event = 'message', data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) id = line.slice(4);
            else if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (data) events.push({ id, event, data: JSON.parse(data), raw: block });
          for (const w of waiters.splice(0)) w();
        }
      });
      resolve();
    });
    req.on('error', reject);
    req.end();
  });
  async function until(n: number, ms = 3000): Promise<SseEvent[]> {
    const end = Date.now() + ms;
    while (events.length < n) {
      const left = end - Date.now();
      if (left <= 0) assert.fail(`wanted ${n} SSE events, got ${events.length}: ${JSON.stringify(events.map((e) => e.id))}`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, left); });
    }
    return events;
  }
  return {
    ready, events, until,
    get head() { return head!; },
    get raw() { return rawChunks.join(''); },
    // Wait briefly and prove nothing more arrives.
    async quiet(ms = 200) { const n = events.length; await new Promise((r) => setTimeout(r, ms)); assert.equal(events.length, n, `unexpected SSE events: ${JSON.stringify(events.slice(n))}`); },
    close() { req.destroy(); },
  };
}

// ---- the server under test -------------------------------------------------------------------
const webDir = mkdtempSync(join(tmpdir(), 'truss-http-check-'));
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>t</title><p>hi</p>');
const state = makeState();
const session = makeSession();
let server: any;
let port = 0;
let token = '';
let url = '';
const origin = () => `http://127.0.0.1:${port}`;
const authed = (extra: Record<string, string> = {}) => ({ origin: origin(), cookie: `truss-ui-${port}=${token}`, ...extra });
const jsonPost = (path: string, body: unknown, headers: Record<string, string> = authed()) =>
  call(port, 'POST', path, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const sseOpen = new Set<ReturnType<typeof openSse>>();
const sse = (path = `/api/events?token=${token}`, headers: Record<string, string> = {}) => { const s = openSse(port, path, headers); sseOpen.add(s); return s; };

before(async () => {
  server = mod.createServer({ state, session, webDir });
  const l = await server.listen(0);
  ({ port, token, url } = l);
});
after(async () => {
  for (const s of sseOpen) s.close();
  await server?.close();
  rmSync(webDir, { recursive: true, force: true });
});

describe('listen', () => {
  it('binds an OS-assigned port and makes a 32-byte base64url token', () => {
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `port ${port}`);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(url.includes(`127.0.0.1:${port}`) && url.includes(token), url);
  });
});

describe('Host, Origin and token refusals', () => {
  it('no token: 401 and error token on the SSE route and on a POST', async () => {
    const g = await call(port, 'GET', '/api/events');
    assert.equal(g.status, 401);
    assert.deepEqual(g.json, { error: 'token' });
    const p = await call(port, 'POST', '/api/message', { headers: { origin: origin(), 'content-type': 'application/json' }, body: '{"text":"hi"}' });
    assert.equal(p.status, 401);
    assert.deepEqual(p.json, { error: 'token' });
    assert.equal(session.sent.length, 0);
  });

  it('wrong token (query and cookie): 401', async () => {
    const bad = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    assert.equal((await call(port, 'GET', `/api/events?token=${bad}`)).status, 401);
    assert.equal((await call(port, 'GET', '/api/events', { headers: { cookie: `truss-ui-${port}=${bad}` } })).status, 401);
    assert.equal((await call(port, 'GET', `/api/events?token=`)).status, 401);
  });

  it('wrong Host, with a valid token: 403 and error host (DNS rebinding)', async () => {
    for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1', `127.0.0.1:${port + 1}`, `[::1]:${port}`]) {
      const r = await call(port, 'GET', `/api/events?token=${token}`, { headers: { host } });
      assert.equal(r.status, 403, `Host ${host}`);
      assert.deepEqual(r.json, { error: 'host' }, `Host ${host}`);
    }
    const p = await jsonPost('/api/message', { text: 'x' }, { ...authed(), host: `evil.example:${port}` });
    assert.equal(p.status, 403);
    assert.deepEqual(p.json, { error: 'host' });
    assert.equal(session.sent.length, 0);
  });

  it('Host is checked before the token: wrong Host with no token is 403, not 401', async () => {
    const r = await call(port, 'GET', '/api/events', { headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'host' });
  });

  it('localhost:port is an accepted Host', async () => {
    const r = await call(port, 'GET', '/', { headers: { host: `localhost:${port}`, cookie: `truss-ui-${port}=${token}` } });
    assert.equal(r.status, 200);
  });

  it('foreign Origin on a POST, with a valid token: 403 and error origin, session untouched', async () => {
    for (const o of ['http://evil.example', `http://evil.example:${port}`, 'null', `https://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`]) {
      const r = await jsonPost('/api/message', { text: 'x' }, { ...authed(), origin: o });
      assert.equal(r.status, 403, `Origin ${o}`);
      assert.deepEqual(r.json, { error: 'origin' }, `Origin ${o}`);
    }
    session.add({ id: 'guard', kind: 'permission', status: 'open', createdAt: new Date().toISOString(), answeredAt: null, cancelReason: null });
    const a = await jsonPost('/api/requests/guard/answer', { decision: 'allow' }, { ...authed(), origin: 'http://evil.example' });
    assert.equal(a.status, 403);
    assert.equal(session.get('guard').status, 'open');
    assert.equal(session.sent.length, 0);
    assert.equal(session.settled.length, 0);
  });

  it('a POST without Origin: 403 and error origin', async () => {
    const r = await call(port, 'POST', '/api/message', { headers: { 'content-type': 'application/json', cookie: `truss-ui-${port}=${token}` }, body: '{"text":"x"}' });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'origin' });
    assert.equal(session.sent.length, 0);
  });

  it('a foreign Origin on a GET is refused too', async () => {
    const r = await call(port, 'GET', `/api/events?token=${token}`, { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, { error: 'origin' });
  });

  it('the token in the query sets the cookie and redirects 303 without the query', async () => {
    const r = await call(port, 'GET', `/?token=${token}`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/');
    const cookie = String(r.headers['set-cookie']);
    assert.ok(cookie.startsWith(`truss-ui-${port}=${token}`), cookie);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\//);
    assert.ok(!String(r.headers.location).includes('token'));
    const page = await call(port, 'GET', '/', { headers: { cookie: `truss-ui-${port}=${token}` } });
    assert.equal(page.status, 200);
    assert.match(page.text, /<p>hi<\/p>/);
    assert.equal((await call(port, 'GET', '/')).status, 401);
  });

  it('every response carries the hardening headers', async () => {
    const r = await call(port, 'GET', '/api/events', {});
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
  });
});

describe('SSE: one snapshot, then deltas', () => {
  it('opens with retry, then a snapshot whose id is instance:seq', async () => {
    const s = sse();
    await s.ready;
    assert.equal(s.head.status, 200);
    assert.match(String(s.head.headers['content-type']), /^text\/event-stream/);
    assert.equal(s.head.headers['cache-control'], 'no-store');
    const [snap] = await s.until(1);
    assert.equal(snap!.event, 'snapshot');
    assert.equal(snap!.id, `${INSTANCE}:${state.snapshot().seq}`);
    assert.equal(snap!.data.type, 'snapshot');
    assert.equal(snap!.data.instance, INSTANCE);
    assert.equal(snap!.data.state.v, 1);
    assert.ok(s.raw.startsWith('retry: 1000\n'), JSON.stringify(s.raw.slice(0, 40)));
    assert.equal(snap!.raw.split('\n').filter((l) => l.startsWith('data: ')).length, 1, 'one data line');
    s.close();
  });

  it('then each delta, in order, with ids instance:seq and the delta as compact JSON', async () => {
    const s = sse();
    await s.ready;
    await s.until(1);
    const base = state.snapshot().seq;
    const d1 = state.emit({ notices: [] });
    const d2 = state.emit({ trussDir: { path: '/x', exists: true } });
    const ev = await s.until(3);
    assert.deepEqual(ev.slice(1).map((e) => e.event), ['delta', 'delta']);
    assert.deepEqual(ev.slice(1).map((e) => e.id), [`${INSTANCE}:${base + 1}`, `${INSTANCE}:${base + 2}`]);
    assert.deepEqual(ev[1]!.data, d1);
    assert.deepEqual(ev[2]!.data, d2);
    assert.equal(ev[1]!.raw.split('\n').filter((l) => l.startsWith('data: ')).length, 1);
    assert.ok(ev[1]!.raw.includes(`data: ${JSON.stringify(d1)}`), 'compact JSON');
    s.close();
  });

  it('drops a delta the snapshot already includes (no gap, no duplicate)', async () => {
    const s0 = state.snapshot().seq;
    state.emitDuringSnapshot();
    const s = sse();
    await s.ready;
    const [snap] = await s.until(1);
    assert.equal(snap!.data.seq, s0 + 1, 'the snapshot read included the delta emitted during it');
    await s.quiet(250);
    const d = state.emit({ notices: [] });
    const ev = await s.until(2);
    assert.equal(ev[1]!.data.seq, d.seq);
    assert.equal(ev[1]!.data.seq, snap!.data.seq + 1);
    s.close();
  });

  it('unsubscribes from the state when the tab goes away', async () => {
    for (let t = 0; t < 100 && state.subscribers > 0; t++) await new Promise((r) => setTimeout(r, 20));
    const before = state.subscribers;
    const s = sse();
    await s.ready;
    await s.until(1);
    assert.equal(state.subscribers, before + 1);
    s.close();
    const end = Date.now() + 2000;
    while (state.subscribers > before && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    assert.equal(state.subscribers, before);
  });

  it('serves the stream with the token in the cookie too', async () => {
    const s = sse('/api/events', { cookie: `truss-ui-${port}=${token}` });
    await s.ready;
    assert.equal(s.head.status, 200);
    await s.until(1);
    s.close();
  });
});

describe('SSE: Last-Event-ID replay', () => {
  it('a reconnect of this instance with every later delta in the ring gets those deltas, in order, and no snapshot', async () => {
    while (state.snapshot().seq < 4) state.emit({ notices: [] });
    const top = state.snapshot().seq;
    const from = top - 2;
    const s = sse(undefined, { 'last-event-id': `${INSTANCE}:${from}` });
    await s.ready;
    const ev = await s.until(2);
    assert.deepEqual(ev.map((e) => e.event), ['delta', 'delta']);
    assert.deepEqual(ev.map((e) => e.id), [`${INSTANCE}:${from + 1}`, `${INSTANCE}:${from + 2}`]);
    assert.deepEqual(ev.map((e) => e.data.seq), [from + 1, from + 2]);
    await s.quiet(250);
    const live = state.emit({ notices: [] });
    const more = await s.until(3);
    assert.equal(more[2]!.data.seq, live.seq, 'live deltas follow the replay');
    s.close();
  });

  it('a reconnect that is already up to date gets no snapshot, only later deltas', async () => {
    const top = state.snapshot().seq;
    const s = sse(undefined, { 'last-event-id': `${INSTANCE}:${top}` });
    await s.ready;
    await s.quiet(250);
    assert.equal(s.events.length, 0);
    const d = state.emit({ notices: [] });
    const ev = await s.until(1);
    assert.equal(ev[0]!.event, 'delta');
    assert.equal(ev[0]!.data.seq, d.seq);
    s.close();
  });

  const snapshotCases: Array<[string, () => string]> = [
    ['of another instance', () => 'ffffffffffffffff:1'],
    ['malformed', () => 'garbage'],
    ['with a malformed seq', () => `${INSTANCE}:x`],
    ['ahead of the server', () => `${INSTANCE}:${state.snapshot().seq + 50}`],
    ['too old for the ring', () => { state.dropBefore(2); return `${INSTANCE}:1`; }],
  ];
  for (const [name, mk] of snapshotCases) {
    it(`Last-Event-ID ${name} gets a fresh snapshot, not deltas`, async () => {
      const id = mk();
      const s = sse(undefined, { 'last-event-id': id });
      await s.ready;
      const [first] = await s.until(1);
      assert.equal(first!.event, 'snapshot', `Last-Event-ID ${id}`);
      assert.equal(first!.data.seq, state.snapshot().seq);
      await s.quiet(200);
      s.close();
    });
  }

  it('no Last-Event-ID gets a snapshot', async () => {
    const s = sse();
    await s.ready;
    const [first] = await s.until(1);
    assert.equal(first!.event, 'snapshot');
    s.close();
  });
});

describe('POST answer: at most once', () => {
  const card = (id: string, kind: string) => ({ id, kind, status: 'open', createdAt: new Date().toISOString(), answeredAt: null, cancelReason: null });

  it('a question answer is 200 with ok and request; the same POST again is 409 answered with the request, and the session is told once', async () => {
    session.add({ ...card('q1', 'question'), questions: [{ question: 'Which?', header: 'h', multiSelect: false, options: [{ label: 'A (Recommended)', description: '', recommended: true }] }], answers: null });
    const body = { answers: { 'Which?': 'A (Recommended)' } };
    const first = await jsonPost('/api/requests/q1/answer', body);
    assert.equal(first.status, 200);
    assert.equal(first.json.ok, true);
    assert.equal(first.json.request.id, 'q1');
    assert.equal(first.json.request.status, 'answered');
    assert.deepEqual(first.json.request.answers, body.answers);
    const afterFirst = JSON.stringify(session.get('q1'));
    for (let i = 0; i < 3; i++) {
      const again = await jsonPost('/api/requests/q1/answer', body);
      assert.equal(again.status, 409);
      assert.equal(again.json.error, 'answered');
      assert.equal(again.json.request.id, 'q1');
      assert.equal(again.json.request.status, 'answered');
      assert.deepEqual(again.json.request.answers, body.answers);
    }
    assert.equal(session.settled.filter((x) => x.id === 'q1').length, 1, 'the session got the answer once');
    assert.equal(JSON.stringify(session.get('q1')), afterFirst, 'a retried POST leaves the same state');
  });

  it('a conflicting second answer does not replace the first', async () => {
    session.add(card('p1', 'permission'));
    const a = await jsonPost('/api/requests/p1/answer', { decision: 'allow' });
    assert.equal(a.status, 200);
    const b = await jsonPost('/api/requests/p1/answer', { decision: 'deny', message: 'no' });
    assert.equal(b.status, 409);
    assert.equal(b.json.error, 'answered');
    assert.equal(session.get('p1').decision, 'allow');
    assert.equal(session.settled.filter((x) => x.id === 'p1').length, 1);
  });

  it('answers to different ids settle only their own id, in any order', async () => {
    session.add(card('o1', 'permission'));
    session.add(card('o2', 'permission'));
    assert.equal((await jsonPost('/api/requests/o2/answer', { decision: 'deny' })).status, 200);
    assert.equal(session.get('o1').status, 'open');
    assert.equal((await jsonPost('/api/requests/o1/answer', { decision: 'allow' })).status, 200);
    assert.equal(session.get('o2').decision, 'deny');
    assert.equal(session.get('o1').decision, 'allow');
  });

  it('404 unknown, 409 cancelled, 400 answer', async () => {
    const u = await jsonPost('/api/requests/nope/answer', { decision: 'allow' });
    assert.equal(u.status, 404);
    assert.deepEqual(u.json, { error: 'unknown' });
    session.add({ ...card('c1', 'permission'), status: 'cancelled', cancelReason: 'aborted' });
    const c = await jsonPost('/api/requests/c1/answer', { decision: 'allow' });
    assert.equal(c.status, 409);
    assert.equal(c.json.error, 'cancelled');
    session.add(card('b1', 'permission'));
    const b = await jsonPost('/api/requests/b1/answer', { decision: 'maybe' });
    assert.equal(b.status, 400);
    assert.equal(b.json.error, 'answer');
    assert.equal(session.get('b1').status, 'open');
  });
});

describe('POST body rules and the other routes', () => {
  it('POST /api/message: 202 and the text reaches the session; empty is 400 text; ended is 409 ended', async () => {
    const ok = await jsonPost('/api/message', { text: 'hello' });
    assert.equal(ok.status, 202);
    assert.deepEqual(session.sent.slice(-1), ['hello']);
    const n = session.sent.length;
    for (const body of [{ text: '' }, { text: 7 }, {}]) {
      const r = await jsonPost('/api/message', body);
      assert.equal(r.status, 400);
      assert.deepEqual(r.json, { error: 'text' });
    }
    assert.equal(session.sent.length, n);
    session.ended = true;
    const e = await jsonPost('/api/message', { text: 'late' });
    assert.equal(e.status, 409);
    assert.deepEqual(e.json, { error: 'ended' });
    session.ended = false;
  });

  it('body must be application/json (415), at most 1 MiB (413), valid JSON (400 json)', async () => {
    const h = authed();
    const t = await call(port, 'POST', '/api/message', { headers: { ...h, 'content-type': 'text/plain' }, body: '{"text":"x"}' });
    assert.equal(t.status, 415);
    const bad = await call(port, 'POST', '/api/message', { headers: { ...h, 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.json, { error: 'json' });
    const huge = JSON.stringify({ text: 'x'.repeat(1024 * 1024 + 10) });
    const big = await call(port, 'POST', '/api/message', { headers: { ...h, 'content-type': 'application/json' }, body: huge }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
  });

  it('unknown API paths are 404 and wrong methods 405', async () => {
    const h = authed();
    assert.equal((await call(port, 'GET', '/api/nope', { headers: h })).status, 404);
    assert.equal((await call(port, 'GET', '/api/message', { headers: h })).status, 405);
    assert.equal((await call(port, 'POST', '/api/events', { headers: { ...h, 'content-type': 'application/json' }, body: '{}' })).status, 405);
  });
});
