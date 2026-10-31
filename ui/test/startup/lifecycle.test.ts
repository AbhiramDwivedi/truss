// Lifecycle helpers: shutdown signal registration (incl. SIGBREAK, which Linux can't send), the parent
// watch, the lockfile and the port-in-use message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  onShutdownSignals, watchParent, lockPath, writeLock, readLiveLock, removeLock, addrInUseMessage,
} from '../../server/lifecycle.ts';

test('onShutdownSignals registers the same handler for SIGINT, SIGTERM, SIGHUP and SIGBREAK', () => {
  const target = new EventEmitter();
  let calls = 0;
  const shutdown = () => { calls++; };
  onShutdownSignals(target, shutdown);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    assert.deepEqual(target.listeners(sig), [shutdown], sig);
  }
  target.emit('SIGBREAK');
  assert.equal(calls, 1);
});

test('watchParent fires once when ppid changes, and once when the old parent is dead', async () => {
  let ppid = 4242;
  let fired = 0;
  watchParent(() => { fired++; }, { intervalMs: 5, getPpid: () => ppid, alive: () => true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 0, 'parent unchanged and alive: no fire');
  ppid = 1;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 1);

  let alive = true;
  let fired2 = 0;
  watchParent(() => { fired2++; }, { intervalMs: 5, getPpid: () => 4242, alive: () => alive });
  alive = false;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired2, 1, 'Windows case: same ppid, dead parent');
});

test('watchParent does nothing when started by init (ppid 1)', async () => {
  let fired = 0;
  watchParent(() => { fired++; }, { intervalMs: 5, getPpid: () => 1, alive: () => false });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fired, 0);
});

test('lockfile: write, read live, ignore stale, remove only our own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'truss-lock-'));
  try {
    const p = lockPath(4310, dir);
    assert.equal(p, join(dir, 'truss-ui-4310.json'));
    assert.equal(readLiveLock(p), null, 'missing file');
    const mine = { pid: process.pid, host: '127.0.0.1', port: 4310, startedAt: 't' };
    assert.ok(writeLock(p, mine));
    assert.deepEqual(readLiveLock(p), mine);
    writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 12345, host: '127.0.0.1', port: 4310, startedAt: 't' }));
    assert.equal(readLiveLock(p), null, 'stale pid reads as null');
    writeFileSync(p, '{bad');
    assert.equal(readLiveLock(p), null, 'bad json reads as null');
    writeFileSync(p, JSON.stringify({ pid: process.pid + 1, host: 'h', port: 1 }));
    removeLock(p);
    assert.ok(existsSync(p), 'not ours: kept');
    writeLock(p, mine);
    removeLock(p);
    assert.ok(!existsSync(p), 'ours: removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addrInUseMessage names host:port, the running UI and how to stop it or change port', () => {
  const m = addrInUseMessage('127.0.0.1', 4310, { pid: 777, host: '127.0.0.1', port: 4310, startedAt: '2026-10-31T00:00:00Z' });
  assert.match(m, /127\.0\.0\.1:4310 is already in use/);
  assert.match(m, /truss UI may already be running/);
  assert.match(m, /Running truss UI: 127\.0\.0\.1:4310, pid 777, started 2026-10-31T00:00:00Z/);
  assert.match(m, /Open the URL that process printed when it started, or stop it and start again/);
  assert.doesNotMatch(m, /token/);
  assert.match(m, /kill 777/);
  assert.match(m, /taskkill \/PID 777 \/F/);
  assert.match(m, /--port/);
  const n = addrInUseMessage('127.0.0.1', 4310, null);
  assert.doesNotMatch(n, /kill \d/);
  assert.match(n, /--port/);
});

test('writeLock replaces a stale 0644 file with a 0600 one, and never writes through a symlink', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'truss-lock-'));
  try {
    const p = lockPath(4311, dir);
    writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 12345, host: 'x', port: 4311 }), { mode: 0o644 });
    assert.equal(lstatSync(p).mode & 0o777, 0o644);
    assert.ok(writeLock(p, { pid: process.pid, host: '127.0.0.1', port: 4311, startedAt: 't' }));
    assert.equal(lstatSync(p).mode & 0o777, 0o600, 'replaced by a fresh 0600 file');
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).pid, process.pid);

    const target = join(dir, 'target.txt');
    writeFileSync(target, 'untouched');
    rmSync(p);
    symlinkSync(target, p);
    assert.equal(readLiveLock(p), null, 'a symlink is not a lockfile');
    removeLock(p);
    assert.ok(lstatSync(p).isSymbolicLink(), 'removeLock leaves a symlink alone');
    assert.ok(writeLock(p, { pid: process.pid, host: '127.0.0.1', port: 4311, startedAt: 't' }));
    assert.equal(readFileSync(target, 'utf8'), 'untouched', 'the symlink target is never written');
    assert.ok(lstatSync(p).isFile());
    assert.equal(lstatSync(p).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeLock returns false when the exclusive create fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'truss-lock-'));
  try {
    assert.equal(writeLock(join(dir, 'missing-dir', 'truss-ui-1.json'), { pid: process.pid, host: 'h', port: 1, startedAt: 't' }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
