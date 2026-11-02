// Contract check for ui-serve's static serving (ADR-0018 section 3, "The missing-build behaviour").
// It starts the real ui/server/main.ts from a temp copy of ui/ (server/, package.json, a node_modules link),
// so the repo's ui/web is never read or written. The build stand-in is a stub index.html plus asset files
// made under mkdtemp. Every server binds port 0. Run: node --test ui/contract/build.check.ts
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const realUi = join(here, '..');
const plugin = join(realUi, '..', 'plugins', 'truss');
const BUILD_CMD = 'npm --prefix ui run build';
const CSP_HEADER = 'Content-Security-Policy';
const PAGE_CSP ="default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const tmp = mkdtempSync(join(tmpdir(), 'truss-build-check-'));
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
});

// A temp ui/ with the real server code and no web/ yet.
function makeUi(name: string): string {
  const ui = join(tmp, name, 'ui');
  mkdirSync(ui, { recursive: true });
  cpSync(join(realUi, 'server'), join(ui, 'server'), { recursive: true });
  cpSync(join(realUi, 'package.json'), join(ui, 'package.json'));
  symlinkSync(join(realUi, 'node_modules'), join(ui, 'node_modules'));
  return ui;
}

function makeBuild(ui: string) {
  const web = join(ui, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><html><head><title>stub</title></head><body><div id="root"></div></body></html>');
  writeFileSync(join(web, 'assets', 'app.js'), 'export {};\n');
  writeFileSync(join(web, 'assets', 'app.css'), 'body{margin:0}\n');
  writeFileSync(join(web, 'assets', 'geist.woff2'), Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]));
}

type Started = { child: ChildProcess; url: string; port: number; token: string; stderr: () => string; stdout: () => string; exited: () => boolean };

async function start(ui: string): Promise<Started> {
  const repo = join(tmp, 'repo-' + Math.random().toString(36).slice(2));
  mkdirSync(repo, { recursive: true });
  const lockDir = join(tmp, 'lock-' + Math.random().toString(36).slice(2));
  mkdirSync(lockDir);
  const env = { ...process.env, TMPDIR: lockDir, TMP: lockDir, TEMP: lockDir, INIT_CWD: repo };
  const child = spawn(process.execPath, [join(ui, 'server', 'main.ts'), '--repo', repo, '--plugin', plugin, '--port', '0'], { env, cwd: repo });
  children.push(child);
  let out = '';
  let err = '';
  let gone = false;
  child.stderr!.on('data', (d) => { err += String(d); });
  const ready = new Promise<string>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no URL within 15 s; stderr: ${err}`)), 15000);
    child.stdout!.on('data', (d) => {
      out += String(d);
      const m = /truss-ui listening on (\S+)/.exec(out);
      if (m) { clearTimeout(t); ok(m[1]!); }
    });
    child.on('exit', (code) => { gone = true; clearTimeout(t); fail(new Error(`exited ${code} before ready; stderr: ${err}`)); });
  });
  const url = await ready;
  const u = new URL(url);
  return { child, url, port: Number(u.port), token: u.searchParams.get('token') ?? '', stderr: () => err, stdout: () => out, exited: () => gone };
}

async function get(s: Started, path: string): Promise<{ status: number; headers: Headers; text: string }> {
  const r = await fetch(`http://127.0.0.1:${s.port}${path}`, { headers: { cookie: `truss-ui-${s.port}=${s.token}` }, redirect: 'manual' });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

describe('no client build: ui/web/index.html is missing', () => {
  it('starts anyway, says on stderr how to build, and keeps stdout to the listening line', async () => {
    const s = await start(makeUi('missing-a'));
    assert.equal(s.exited(), false, 'main.ts must not exit when the build is missing');
    const lines = s.stdout().split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 1, `stdout is the listening line only, got: ${JSON.stringify(s.stdout())}`);
    assert.match(lines[0]!, /^truss-ui listening on \S+$/);
    assert.match(s.stderr(), new RegExp('truss-ui: no client build at .*web.index\\.html; run: ' + BUILD_CMD.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  });

  it('GET / and GET /index.html answer 503 with an html error page naming the build command', async () => {
    const s = await start(makeUi('missing-b'));
    for (const path of ['/', '/index.html']) {
      const r = await get(s, path);
      assert.equal(r.status, 503, `GET ${path} with no build`);
      assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(r.headers.get(CSP_HEADER), PAGE_CSP);
      assert.match(r.text, /<h1>Truss needs a client build<\/h1>/);
      assert.ok(r.text.includes(`<code>${BUILD_CMD}</code>`), `page names ${BUILD_CMD} in a <code> element`);
      assert.doesNotMatch(r.text, /<script|<style|\sstyle=|\son[a-z]+=/i, 'no inline script or style');
    }
  });

  it('every other missing static path stays 404 {"error":"notfound"}', async () => {
    const s = await start(makeUi('missing-c'));
    const r = await get(s, '/assets/nope.js');
    assert.equal(r.status, 404);
    assert.deepEqual(JSON.parse(r.text), { error: 'notfound' });
  });
});

describe('a client build is present', () => {
  it('GET / is 200 html with the page CSP, and no missing-build line on stderr', async () => {
    const ui = makeUi('built-a');
    makeBuild(ui);
    const s = await start(ui);
    const r = await get(s, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(CSP_HEADER), PAGE_CSP);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(r.text.includes('<div id="root">'));
    assert.ok(!s.stderr().includes(BUILD_CMD), 'no missing-build message when the build exists: ' + s.stderr());
  });

  it('serves .woff2 as font/woff2 and the js and css assets with their types', async () => {
    const ui = makeUi('built-b');
    makeBuild(ui);
    const s = await start(ui);
    const font = await get(s, '/assets/geist.woff2');
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), 'font/woff2');
    assert.equal((await get(s, '/assets/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal((await get(s, '/assets/app.css')).headers.get('content-type'), 'text/css; charset=utf-8');
  });
});
