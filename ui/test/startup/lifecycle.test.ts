// Lifecycle helpers: shutdown signal registration (incl. SIGBREAK, which Linux can't send), the parent
// watch, the lockfile and the port-in-use message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
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
    assert.ok(writeLock(p, { pid: process.pid, url: 'http://127.0.0.1:4310/?token=x', startedAt: 't' }));
    assert.deepEqual(readLiveLock(p), { pid: process.pid, url: 'http://127.0.0.1:4310/?token=x', startedAt: 't' });
    writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 12345, url: 'http://x', startedAt: 't' }));
    assert.equal(readLiveLock(p), null, 'stale pid reads as null');
    writeFileSync(p, '{bad');
    assert.equal(readLiveLock(p), null, 'bad json reads as null');
    writeFileSync(p, JSON.stringify({ pid: process.pid + 1, url: 'u' }));
    removeLock(p);
    assert.ok(existsSync(p), 'not ours: kept');
    writeLock(p, { pid: process.pid, url: 'u', startedAt: 't' });
    removeLock(p);
    assert.ok(!existsSync(p), 'ours: removed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('addrInUseMessage names host:port, the running UI and how to stop it or change port', () => {
  const m = addrInUseMessage('127.0.0.1', 4310, { pid: 777, url: 'http://127.0.0.1:4310/?token=abc', startedAt: '2026-10-31T00:00:00Z' });
  assert.match(m, /127\.0\.0\.1:4310 is already in use/);
  assert.match(m, /truss UI may already be running/);
  assert.match(m, /http:\/\/127\.0\.0\.1:4310\/\?token=abc/);
  assert.match(m, /kill 777/);
  assert.match(m, /taskkill \/PID 777 \/F/);
  assert.match(m, /--port/);
  const n = addrInUseMessage('127.0.0.1', 4310, null);
  assert.doesNotMatch(n, /kill \d/);
  assert.match(n, /--port/);
});
