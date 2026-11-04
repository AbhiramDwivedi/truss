// Tests for the missing-build behaviour of static serving (ADR-0018 section 3, ui/contract/build.check.ts) at the
// createServer level, with a webDir made under mkdtemp. Erasable TypeScript, node:test, built-ins only; port 0 only.
// The CSP and the guard are asserted only as build.check.ts states them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../../server/http/index.ts';
import { call, makeSession, makeState } from './helpers.ts';

const BUILD_CMD = 'npm --prefix ui run build';
const PAGE_CSP = "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

async function withServer(setup: (webDir: string) => void, fn: (get: (path: string, method?: string) => ReturnType<typeof call>) => Promise<void>, o: { webDirExists?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'truss-build-test-'));
  const webDir = join(root, 'web');
  if (o.webDirExists !== false) mkdirSync(webDir);
  setup(webDir);
  const server = createServer({ state: makeState(), session: makeSession(), webDir });
  const l = await server.listen(0);
  const headers = { origin: `http://127.0.0.1:${l.port}`, cookie: `truss-ui-${l.port}=${l.token}` };
  try {
    await fn((path, method = 'GET') => call(l.port, method, path, { headers }));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function assertMissingBuildPage(r: Awaited<ReturnType<typeof call>>, what: string) {
  assert.equal(r.status, 503, what);
  assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', what);
  assert.equal(r.headers['content-security-policy'], PAGE_CSP, what);
  assert.match(r.text, /<h1>Truss needs a client build<\/h1>/, what);
  assert.ok(r.text.includes(`<code>${BUILD_CMD}</code>`), `${what}: names the build command in a <code>`);
  assert.doesNotMatch(r.text, /<script|<style|\sstyle=|\son[a-z]+=/i, `${what}: no inline script or style`);
}

test('missing build: an empty webDir answers / and /index.html with the 503 page', async () => {
  await withServer(() => {}, async (get) => {
    assertMissingBuildPage(await get('/'), 'GET /');
    assertMissingBuildPage(await get('/index.html'), 'GET /index.html');
  });
});

test('missing build: assets present but no index.html is still a missing build', async () => {
  await withServer((web) => {
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'assets', 'app.js'), 'export {};\n');
  }, async (get) => {
    assertMissingBuildPage(await get('/'), 'GET /');
    assertMissingBuildPage(await get('/index.html'), 'GET /index.html');
    const asset = await get('/assets/app.js');
    assert.equal(asset.status, 200, 'an asset that exists is still served');
  });
});

test('missing build: a webDir that does not exist at all answers the 503 page, not a crash or a 404', async () => {
  await withServer(() => {}, async (get) => {
    assertMissingBuildPage(await get('/'), 'GET /');
  }, { webDirExists: false });
});

test('missing build: a query string on / does not turn the 503 page into something else', async () => {
  await withServer(() => {}, async (get) => {
    assertMissingBuildPage(await get('/?token=x'), 'GET /?token=x');
  });
});

test('missing build: other static paths and API paths stay 404 {error: "notfound"}', async () => {
  await withServer(() => {}, async (get) => {
    for (const p of ['/assets/nope.js', '/favicon.ico', '/api/nope', '/api']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.json, { error: 'notfound' }, p);
    }
  });
});

test('with a build: / and /index.html answer 200 html, woff2 is font/woff2, and a missing asset is 404 notfound', async () => {
  await withServer((web) => {
    mkdirSync(join(web, 'assets', 'fonts'), { recursive: true });
    writeFileSync(join(web, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
    writeFileSync(join(web, 'assets', 'fonts', 'geist-latin.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]));
  }, async (get) => {
    for (const p of ['/', '/index.html']) {
      const r = await get(p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
      assert.ok(r.text.includes('<div id="root">'), p);
      assert.doesNotMatch(r.text, /Truss needs a client build/, p);
    }
    const font = await get('/assets/fonts/geist-latin.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers['content-type'], 'font/woff2');
    assert.deepEqual([...font.body.subarray(0, 4)], [0x77, 0x4f, 0x46, 0x32], 'the bytes are served as they are');
    const miss = await get('/assets/fonts/none.woff2');
    assert.equal(miss.status, 404);
    assert.deepEqual(miss.json, { error: 'notfound' });
  });
});

test('with a build: API routes that do not exist still answer 404 notfound JSON, never the index page', async () => {
  await withServer((web) => {
    writeFileSync(join(web, 'index.html'), '<!doctype html><html><body><div id="root"></div></body></html>');
  }, async (get) => {
    for (const p of ['/api/nope', '/api/requests', '/api/']) {
      const r = await get(p);
      assert.equal(r.status, 404, p);
      assert.deepEqual(r.json, { error: 'notfound' }, p);
    }
  });
});
