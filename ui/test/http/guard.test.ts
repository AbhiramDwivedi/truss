// ui-server guard: Host, then Origin, then token, on every route (ADR-0011 Decision 6; R-12, R-16).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { boot, call, rawRequest, type Booted } from './helpers.ts';

let b: Booted;
before(async () => { b = await boot({ files: { 'x.css': 'a{}', 'sub/page.html': '<p>p</p>' } }); });
after(async () => { await b.stop(); });

const routes: Array<[string, string, string]> = [
  ['GET', '/', 'static root'],
  ['GET', '/x.css', 'static file'],
  ['GET', '/vendor/marked.js', 'vendor'],
  ['GET', '/api/events', 'SSE'],
  ['GET', '/api/image?ref=main&path=a.png', 'image'],
  ['POST', '/api/message', 'message POST'],
  ['POST', '/api/requests/r1/answer', 'answer POST'],
];
const send = (method: string, path: string, headers: Record<string, string>) =>
  call(b.port, method, path, { headers: method === 'POST' ? { 'content-type': 'application/json', ...headers } : headers, body: method === 'POST' ? '{"text":"x"}' : undefined });

describe('guard order, Decision 6', () => {
  it('Decision 6: bad Host + bad Origin + bad token is 403 host on every route', async () => {
    for (const [m, p, name] of routes) {
      const r = await send(m, p, { host: 'evil.example', origin: 'http://evil.example' });
      assert.equal(r.status, 403, name);
      assert.deepEqual(r.json, { error: 'host' }, name);
    }
  });
  it('Decision 6: good Host + bad Origin + bad token is 403 origin on every route', async () => {
    for (const [m, p, name] of routes) {
      const r = await send(m, p, { origin: 'http://evil.example' });
      assert.equal(r.status, 403, name);
      assert.deepEqual(r.json, { error: 'origin' }, name);
    }
  });
  it('Decision 6: good Host and Origin + no token is 401 token on every route', async () => {
    for (const [m, p, name] of routes) {
      const r = await send(m, p, { origin: b.origin });
      assert.equal(r.status, 401, name);
      assert.deepEqual(r.json, { error: 'token' }, name);
    }
  });
  it('Decision 6: a POST with no Origin and no token is 403 origin (origin is checked before the token)', async () => {
    for (const p of ['/api/message', '/api/requests/r1/answer']) {
      const r = await send('POST', p, {});
      assert.equal(r.status, 403, p);
      assert.deepEqual(r.json, { error: 'origin' }, p);
    }
  });
  it('Decision 6: a GET with no Origin and no token is 401 (Origin is only required on POST)', async () => {
    assert.equal((await send('GET', '/x.css', {})).status, 401);
  });
  it('Decision 6: the refusals never reach the session or the state', async () => {
    assert.deepEqual(b.session.sent, []);
    assert.deepEqual(b.session.answers, []);
    assert.deepEqual(b.state.imageCalls, []);
  });
});

describe('Host values, DNS rebinding (Decision 6)', () => {
  it('Decision 6: rebound names, other ports, other loopback addresses, empty Host are 403 host even with a valid token', async () => {
    const p = b.port;
    const hosts = [
      'evil.example', `evil.example:${p}`, `rebind.127.0.0.1.nip.io:${p}`, `127.0.0.1.evil.example:${p}`, `localhost.evil.example:${p}`,
      `evil.example:${p}@127.0.0.1`, `127.0.0.1:${p}.evil.example`, `127.0.0.1:${p} evil`,
      '127.0.0.1', 'localhost', `127.0.0.1:${p + 1}`, `localhost:${p + 1}`,
      `0.0.0.0:${p}`, `127.0.0.2:${p}`, `[::1]:${p}`, `[::ffff:127.0.0.1]:${p}`, `2130706433:${p}`, `0x7f.0.0.1:${p}`, `:${p}`, '',
    ];
    for (const host of hosts) {
      const r = await call(b.port, 'GET', `/api/events?token=${b.token}`, { headers: { host, cookie: b.cookie } });
      assert.equal(r.status, 403, `Host ${JSON.stringify(host)}`);
      assert.deepEqual(r.json, { error: 'host' }, `Host ${JSON.stringify(host)}`);
    }
  });
  it('Decision 6: a request with no Host header at all (HTTP/1.0) is refused 403 host', async () => {
    const r = await rawRequest(b.port, [`GET /api/events?token=${b.token} HTTP/1.0`, `Cookie: ${b.cookie}`]);
    assert.equal(r.status, 403, r.text);
    assert.match(r.text, /"error":"host"/);
  });
  it('Decision 6: Host 127.0.0.1:<port> and localhost:<port> are both accepted', async () => {
    for (const host of [`127.0.0.1:${b.port}`, `localhost:${b.port}`]) {
      const r = await call(b.port, 'GET', '/', { headers: { host, cookie: b.cookie } });
      assert.equal(r.status, 200, host);
    }
  });
  it('Decision 6: a rebound Host cannot reach the answer POST, and the session is untouched', async () => {
    const r = await b.post('/api/requests/r1/answer', { decision: 'allow' }, { origin: b.origin, cookie: b.cookie, host: `evil.example:${b.port}` });
    assert.equal(r.status, 403);
    assert.deepEqual(b.session.answers, []);
  });
});

describe('Origin values (Decision 6)', () => {
  it('Decision 6: Origin http://localhost:<port> is accepted on a POST and on a GET', async () => {
    const o = `http://localhost:${b.port}`;
    const m = await b.post('/api/message', { text: 'from localhost origin' }, { origin: o, cookie: b.cookie, host: `localhost:${b.port}` });
    assert.equal(m.status, 202);
    assert.ok(b.session.sent.includes('from localhost origin'));
    const g = await call(b.port, 'GET', '/', { headers: { origin: o, cookie: b.cookie } });
    assert.equal(g.status, 200);
  });
  it('Decision 6: an Origin that only starts like ours is refused', async () => {
    for (const o of [`${b.origin}.evil.example`, `${b.origin}/`, `${b.origin}@evil.example`, 'http://127.0.0.1', `http://evil.example/${b.origin}`]) {
      const r = await b.post('/api/message', { text: 'x' }, { origin: o, cookie: b.cookie });
      assert.equal(r.status, 403, o);
      assert.deepEqual(r.json, { error: 'origin' }, o);
    }
  });
});

describe('token compare (Decision 6: timingSafeEqual)', () => {
  it('Decision 6: tokens of another length or with a trailing char are 401, never a crash, in query and cookie', async () => {
    const t = b.token;
    const bad = [t + 'A', t.slice(0, -1), t.slice(0, 10), 'x', '', t + t, 'A'.repeat(5000), t + '%00'];
    for (const v of bad) {
      const q = await call(b.port, 'GET', `/api/events?token=${v}`);
      assert.equal(q.status, 401, `query ${v.slice(0, 20)}`);
      assert.deepEqual(q.json, { error: 'token' });
      const c = await call(b.port, 'GET', '/api/events', { headers: { cookie: `truss-ui-${b.port}=${v}` } });
      assert.equal(c.status, 401, `cookie ${v.slice(0, 20)}`);
    }
    assert.equal((await call(b.port, 'GET', '/', { headers: { cookie: b.cookie } })).status, 200, 'server still up');
  });
  it('Decision 6: the right token under a cookie name of another port (or no port) does not count', async () => {
    assert.equal((await call(b.port, 'GET', '/', { headers: { cookie: `truss-ui-${b.port + 1}=${b.token}` } })).status, 401);
    assert.equal((await call(b.port, 'GET', '/', { headers: { cookie: `truss-ui=${b.token}` } })).status, 401);
  });
  it('Decision 6: a token from an earlier server instance is refused by the next one', async () => {
    const first = await boot();
    const firstToken = first.token;
    await first.stop();
    const second = await boot();
    try {
      assert.notEqual(firstToken, second.token);
      for (const t of [firstToken, b.token]) {
        assert.equal((await call(second.port, 'GET', `/?token=${t}`)).status, 401);
        assert.equal((await call(second.port, 'GET', '/', { headers: { cookie: `truss-ui-${second.port}=${t}` } })).status, 401);
        const p = await second.post('/api/message', { text: 'x' }, { origin: second.origin, cookie: `truss-ui-${second.port}=${t}` });
        assert.equal(p.status, 401);
      }
      assert.deepEqual(second.session.sent, []);
      assert.equal((await call(second.port, 'GET', '/', { headers: { cookie: second.cookie } })).status, 200);
    } finally { await second.stop(); }
  });
});

describe('the ?token= redirect (Decision 6)', () => {
  it('Decision 6: /x.css?token=T redirects 303 to /x.css; the path stays, only the token goes', async () => {
    for (const path of ['/x.css', '/sub/page.html', '/']) {
      const r = await call(b.port, 'GET', `${path}?token=${b.token}`);
      assert.equal(r.status, 303, path);
      assert.equal(r.headers.location, path, path);
      assert.ok(String(r.headers['set-cookie']).startsWith(`truss-ui-${b.port}=${b.token}`));
    }
  });
  it('Decision 6: a wrong ?token= sets no cookie and does not redirect', async () => {
    const r = await call(b.port, 'GET', `/x.css?token=${b.token}A`);
    assert.equal(r.status, 401);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(r.headers.location, undefined);
  });
  it('Decision 6: a ?token= with a wrong Host is refused before any redirect or cookie', async () => {
    const r = await call(b.port, 'GET', `/?token=${b.token}`, { headers: { host: 'evil.example' } });
    assert.equal(r.status, 403);
    assert.equal(r.headers['set-cookie'], undefined);
  });
  it('Decision 6: the cookie name carries the port of its own server', async () => {
    const other = await boot();
    try {
      const a = String((await call(b.port, 'GET', `/?token=${b.token}`)).headers['set-cookie']);
      const c = String((await call(other.port, 'GET', `/?token=${other.token}`)).headers['set-cookie']);
      assert.notEqual(b.port, other.port);
      assert.ok(a.startsWith(`truss-ui-${b.port}=`), a);
      assert.ok(c.startsWith(`truss-ui-${other.port}=`), c);
    } finally { await other.stop(); }
  });
});

describe('no rate limit (R-16)', () => {
  it('R-16: 200 rapid authed requests all succeed', async () => {
    const rs = await Promise.all(Array.from({ length: 200 }, () => call(b.port, 'GET', '/x.css', { headers: { cookie: b.cookie } })));
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [200]);
  });
  it('R-16: 200 refused requests do not lock out the next good one', async () => {
    const rs = await Promise.all(Array.from({ length: 200 }, () => call(b.port, 'GET', '/x.css', { headers: { cookie: `truss-ui-${b.port}=wrong` } })));
    assert.deepEqual([...new Set(rs.map((r) => r.status))], [401]);
    assert.equal((await call(b.port, 'GET', '/x.css', { headers: { cookie: b.cookie } })).status, 200);
  });
});
