// The real ui/server/main.ts: port-in-use message, shutdown on each signal Linux can send, shutdown when
// its parent dies, and the per-port lockfile. TMPDIR points at a temp dir, so the lockfiles are isolated.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const main = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'main.ts');
const tmp = mkdtempSync(join(tmpdir(), 'truss-shutdown-test-'));
const lockDir = join(tmp, 'tmpdir');
const repo = join(tmp, 'repo');
mkdirSync(lockDir);
mkdirSync(repo);
const env = { ...process.env, TMPDIR: lockDir, TMP: lockDir, TEMP: lockDir, INIT_CWD: repo };
const lockFor = (port: number) => join(lockDir, `truss-ui-${port}.json`);
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as any).code === 'EPERM'; }
}

async function waitFor(cond: () => boolean, ms: number, what: string) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Starts main.ts and resolves once it prints its URL.
function start(port: number) {
  const child = spawn(process.execPath, [main, '--repo', repo, '--port', String(port)], { env, cwd: repo });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  child.stderr!.on('data', (d) => { err += String(d); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
  const ready = new Promise<string>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`no URL within 15 s; stderr: ${err}`)), 15000);
    child.stdout!.on('data', () => { const m = /truss-ui listening on (\S+)/.exec(out); if (m) { clearTimeout(t); ok(m[1]!); } });
    exited.then((x) => { clearTimeout(t); fail(new Error(`exited ${x.code} before ready; stderr: ${err}`)); });
  });
  ready.catch(() => {});
  return { child, ready, exited, get err() { return err; }, get out() { return out; } };
}

describe('main.ts lifecycle', () => {
  it('port in use: a clear message naming the running UI, exit 1, no stack trace', async () => {
    const port = await freePort();
    const first = start(port);
    const url = await first.ready;
    const second = start(port);
    const x = await second.exited;
    assert.equal(x.code, 1, second.err);
    assert.match(second.err, new RegExp(`127\\.0\\.0\\.1:${port} is already in use`));
    assert.match(second.err, /truss UI may already be running/);
    const token = new URL(url).searchParams.get('token')!;
    assert.ok(token.length > 10);
    assert.ok(!second.err.includes(token), `the second start never prints the token: ${second.err}`);
    assert.ok(!readFileSync(lockFor(port), 'utf8').includes(token), 'the lockfile holds no token');
    assert.match(second.err, new RegExp(`Running truss UI: 127\\.0\\.0\\.1:${port}, pid ${first.child.pid}, started `));
    assert.match(second.err, /Open the URL that process printed when it started/);
    assert.match(second.err, new RegExp(`kill ${first.child.pid}\\b`));
    assert.match(second.err, new RegExp(`taskkill /PID ${first.child.pid} /F`));
    assert.match(second.err, /--port/);
    assert.doesNotMatch(second.err, /\n\s+at /, 'no stack trace');
    assert.equal(second.out, '');
    assert.equal(JSON.parse(readFileSync(lockFor(port), 'utf8')).pid, first.child.pid, 'the loser leaves the lock alone');
    first.child.kill('SIGTERM');
    await first.exited;
  });

  it('port held by another program: message without a pid, exit 1', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      const s = start(port);
      const x = await s.exited;
      assert.equal(x.code, 1, s.err);
      assert.match(s.err, new RegExp(`127\\.0\\.0\\.1:${port} is already in use`));
      assert.match(s.err, /--port/);
      assert.doesNotMatch(s.err, /kill \d/);
      assert.doesNotMatch(s.err, /\n\s+at /);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    it(`${sig} ends the server cleanly and removes the lockfile`, async () => {
      const port = await freePort();
      const s = start(port);
      const url = await s.ready;
      const lock = JSON.parse(readFileSync(lockFor(port), 'utf8'));
      assert.equal(lock.pid, s.child.pid);
      assert.deepEqual(Object.keys(lock).sort(), ['host', 'pid', 'port', 'startedAt']);
      assert.equal(lock.port, port);
      assert.ok(!readFileSync(lockFor(port), 'utf8').includes(new URL(url).searchParams.get('token')!), 'no token in the lockfile');
      assert.ok(!Number.isNaN(Date.parse(lock.startedAt)), lock.startedAt);
      s.child.kill(sig);
      const x = await s.exited;
      assert.deepEqual(x, { code: 0, signal: null }, s.err);
      assert.ok(!existsSync(lockFor(port)), 'lockfile removed');
    });
  }

  it('parent death ends the server within a few seconds', async () => {
    const port = await freePort();
    const pidFile = join(tmp, `server-${port}.pid`);
    // The intermediate stands in for npm: it starts the server and stays alive until killed.
    const script = `
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ${JSON.stringify([main, '--repo', repo, '--port', String(port)])}, { stdio: ['ignore', 'pipe', 'inherit'] });
      c.stdout.on('data', (d) => { if (String(d).includes('listening on')) require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); });
      setInterval(() => {}, 1000);
    `;
    const mid = spawn(process.execPath, ['-e', script], { env, cwd: repo, stdio: 'ignore' });
    children.push(mid);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 15000, 'server ready');
    const serverPid = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(pidAlive(serverPid));
    mid.kill('SIGKILL');
    try {
      await waitFor(() => !pidAlive(serverPid), 5000, 'server exits after its parent dies');
    } finally {
      try { process.kill(serverPid, 'SIGKILL'); } catch {}
    }
    assert.ok(!existsSync(lockFor(port)), 'lockfile removed');
  });

  it('a stale lockfile (dead pid) is ignored and overwritten', async () => {
    const port = await freePort();
    writeFileSync(lockFor(port), JSON.stringify({ pid: 2 ** 22 + 12345, host: '127.0.0.1', port, startedAt: '2020-01-01T00:00:00Z' }), { mode: 0o644 });
    const s = start(port);
    const url = await s.ready;
    const lock = JSON.parse(readFileSync(lockFor(port), 'utf8'));
    assert.equal(lock.pid, s.child.pid);
    assert.equal(lock.port, port);
    assert.ok(!readFileSync(lockFor(port), 'utf8').includes(new URL(url).searchParams.get('token')!));
    if (process.platform !== 'win32') assert.equal(lstatSync(lockFor(port)).mode & 0o777, 0o600, 'stale 0644 file replaced by a 0600 one');
    s.child.kill('SIGTERM');
    await s.exited;
    assert.ok(!existsSync(lockFor(port)));
  });

  it('a stale lockfile is not reported when the port is held by something else', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as net.AddressInfo).port;
    writeFileSync(lockFor(port), JSON.stringify({ pid: 2 ** 22 + 12345, host: '127.0.0.1', port, startedAt: '1999-stale' }));
    try {
      const s = start(port);
      const x = await s.exited;
      assert.equal(x.code, 1);
      assert.doesNotMatch(s.err, /1999-stale/);
      assert.doesNotMatch(s.err, /kill \d/);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
