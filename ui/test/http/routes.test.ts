// ui-server routes and body rules (ADR-0011 Decision 6; Decision 7 images).
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, call, callChunked, openSse, type Booted } from './helpers.ts';

let b: Booted;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3, 255]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
before(async () => {
  b = await boot();
  b.state.images.set('truss-ui-web\0docs/shot.png', PNG);
  b.state.images.set('main\0docs/ui whiteboard.jpg', JPG);
  b.state.images.set('main\0docs/a.jpeg', JPG);
  b.state.images.set('main\0docs/a.gif', Buffer.from('GIF89a'));
  b.state.images.set('main\0docs/a.webp', Buffer.from('RIFFxxxxWEBP'));
  b.state.images.set('main\0docs/icon.svg', SVG);
});
after(async () => { await b.stop(); });

const get = (path: string) => call(b.port, 'GET', path, { headers: { cookie: b.cookie } });
const q = (ref: string, path: string) => `/api/image?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}`;

describe('GET /api/image (Decision 7)', () => {
  it('Decision 7: a known ref and path returns the readImage bytes with image/png', async () => {
    const r = await get(q('truss-ui-web', 'docs/shot.png'));
    assert.equal(r.status, 200);
    assert.match(String(r.headers['content-type']), /^image\/png/);
    assert.ok(r.body.equals(PNG));
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  });
  it('Decision 7: content types by extension (.jpg .jpeg .gif .webp .svg), decoded path with a space reaches readImage', async () => {
    const want: Array<[string, RegExp]> = [['docs/ui whiteboard.jpg', /^image\/jpeg/], ['docs/a.jpeg', /^image\/jpeg/], ['docs/a.gif', /^image\/gif/], ['docs/a.webp', /^image\/webp/], ['docs/icon.svg', /^image\/svg\+xml/]];
    for (const [p, re] of want) {
      const r = await get(q('main', p));
      assert.equal(r.status, 200, p);
      assert.match(String(r.headers['content-type']), re, p);
    }
    assert.ok(b.state.imageCalls.some(([ref, p]) => ref === 'main' && p === 'docs/ui whiteboard.jpg'), JSON.stringify(b.state.imageCalls));
  });
  it('Decision 7: an SVG image also carries Content-Security-Policy: sandbox', async () => {
    const r = await get(q('main', 'docs/icon.svg'));
    assert.equal(r.headers['content-security-policy'], 'sandbox');
    assert.ok(r.body.equals(SVG));
  });
  it('Decision 7: 404 when readImage gives null (pair not in design.images)', async () => {
    const r = await get(q('main', 'docs/unknown.png'));
    assert.equal(r.status, 404);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await get(q('main', '../../etc/passwd'))).status, 404);
  });
  it('Decision 7: 404 when ref or path is missing or empty, and readImage is not asked', async () => {
    const n = b.state.imageCalls.length;
    for (const p of ['/api/image', '/api/image?ref=main', '/api/image?path=docs/shot.png', '/api/image?ref=&path=docs/shot.png', '/api/image?ref=main&path=']) {
      assert.equal((await get(p)).status, 404, p);
    }
    assert.equal(b.state.imageCalls.length, n);
  });
  it('Decision 6: /api/image needs the token (401) even for a known pair', async () => {
    const r = await call(b.port, 'GET', q('truss-ui-web', 'docs/shot.png'), { headers: { origin: b.origin } });
    assert.equal(r.status, 401);
  });
});

describe('POST bodies (Decision 6)', () => {
  it('Decision 6: Content-Type application/json; charset=utf-8 is accepted', async () => {
    const r = await call(b.port, 'POST', '/api/message', { headers: { ...b.authed(), 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ text: 'café 😀' }) });
    assert.equal(r.status, 202);
    assert.ok(b.session.sent.includes('café 😀'));
  });
  it('Decision 6: a 1 MiB body over a chunked upload (no Content-Length) is 413 and the session is not told', async () => {
    const n = b.session.sent.length;
    const r = await callChunked(b.port, '/api/message', { ...b.authed(), 'content-type': 'application/json' }, 20, 64 * 1024);
    assert.equal(r.status, 413);
    assert.equal(b.session.sent.length, n);
    assert.equal((await get('/')).status, 200, 'server still up');
  });
  it('Decision 6: a chunked body under the limit is accepted', async () => {
    const small = await new Promise<number>((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: b.port, method: 'POST', path: '/api/message', headers: { host: `127.0.0.1:${b.port}`, ...b.authed(), 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, agent: false }, (res: any) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', () => resolve(0));
      r.write('{"text":');
      r.end('"chunked ok"}');
    });
    assert.equal(small, 202);
    assert.ok(b.session.sent.includes('chunked ok'));
  });
});

describe('hardening headers on error responses (Decision 6)', () => {
  const must = (h: Record<string, unknown>, what: string) => {
    assert.equal(h['cache-control'], 'no-store', `${what} cache-control`);
    assert.equal(h['x-content-type-options'], 'nosniff', `${what} nosniff`);
    assert.equal(h['referrer-policy'], 'no-referrer', `${what} referrer-policy`);
  };
  it('Decision 6: 404, 405, 413 and 415 carry Cache-Control, nosniff and Referrer-Policy', async () => {
    must((await get('/missing.js')).headers, '404 static');
    must((await get('/api/nope')).headers, '404 api');
    must((await get('/api/message')).headers, '405');
    must((await call(b.port, 'POST', '/api/events', { headers: { ...b.authed(), 'content-type': 'application/json' }, body: '{}' })).headers, '405 POST');
    const t = await call(b.port, 'POST', '/api/message', { headers: { ...b.authed(), 'content-type': 'text/plain' }, body: '{"text":"x"}' });
    assert.equal(t.status, 415);
    must(t.headers, '415');
    const big = await callChunked(b.port, '/api/message', { ...b.authed(), 'content-type': 'application/json' }, 20, 64 * 1024);
    assert.equal(big.status, 413);
    must(big.headers, '413');
  });
  it('Decision 6: 400 json and 401/403 refusals carry them too', async () => {
    const bad = await call(b.port, 'POST', '/api/message', { headers: { ...b.authed(), 'content-type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    must(bad.headers, '400');
    must((await call(b.port, 'GET', '/')).headers, '401');
    must((await call(b.port, 'GET', '/', { headers: { host: 'evil.example' } })).headers, '403');
  });
  it('Decision 6: a 415 has no side effect on the session', async () => {
    const n = b.session.sent.length;
    await call(b.port, 'POST', '/api/message', { headers: { ...b.authed(), 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=x' });
    await call(b.port, 'POST', '/api/message', { headers: b.authed(), body: '{"text":"no content type"}' });
    assert.equal(b.session.sent.length, n);
  });
});

describe('listen and close (Decision 6, Decision 9)', () => {
  it('Decision 6: listen() url is exactly http://127.0.0.1:<port>/?token=<token>', () => {
    assert.equal(b.url, `http://127.0.0.1:${b.port}/?token=${b.token}`);
    assert.ok(b.port > 0);
  });
  it('Decision 6: the listening socket is bound to 127.0.0.1 only', async () => {
    const { networkInterfaces } = await import('node:os');
    const other = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!other) return;
    const refused = await new Promise<boolean>((resolve) => {
      import('node:net').then(({ connect }) => {
        const s = connect(b.port, other.address);
        s.on('connect', () => { s.destroy(); resolve(false); });
        s.on('error', () => resolve(true));
      });
    });
    assert.ok(refused, `${other.address}:${b.port} accepted a connection`);
  });
  it('Decision 9: close() resolves with SSE streams still open, and they end', async () => {
    const x = await boot();
    const tabs = [openSse(x.port, `/api/events?token=${x.token}`), openSse(x.port, `/api/events?token=${x.token}`)];
    await Promise.all(tabs.map((t) => t.ready));
    await Promise.all(tabs.map((t) => t.until(1)));
    const done = await Promise.race([x.server.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    assert.equal(done, 'closed');
    assert.equal(x.state.subscribers, 0, 'subscribers released on close');
    tabs.forEach((t) => t.close());
    const { rmSync } = await import('node:fs');
    rmSync(x.root, { recursive: true, force: true });
    await assert.rejects(call(x.port, 'GET', '/', { headers: { cookie: x.cookie } }), 'port no longer accepts requests');
  });
});
