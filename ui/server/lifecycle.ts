// Process lifecycle for ui/server/main.ts: shutdown signals, parent-death watch, the per-port lockfile
// and the "port in use" message. Node built-ins only; every function here never throws.
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// SIGHUP: a closed terminal on Linux/macOS, and a closed console window on Windows (CTRL_CLOSE_EVENT).
// SIGBREAK: Ctrl+Break on Windows. Registering it elsewhere is harmless; it never fires.
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const;

interface SignalTarget { on(event: string, fn: () => void): unknown }

export function onShutdownSignals(target: SignalTarget, shutdown: () => void): void {
  for (const sig of SHUTDOWN_SIGNALS) target.on(sig, shutdown);
}

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

// Calls onGone once when the process that started us goes away. On Linux and macOS an orphan is
// re-parented, so process.ppid changes; on Windows ppid keeps the old value, so the old pid is
// also probed. Skipped when started by init (ppid 1), which is a deliberate daemon. The timer is
// unref'd, so it never keeps the process alive by itself.
export function watchParent(onGone: () => void, opts: { intervalMs?: number; getPpid?: () => number; alive?: (pid: number) => boolean } = {}): () => void {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const alive = opts.alive ?? pidAlive;
  const start = getPpid();
  if (!Number.isInteger(start) || start <= 1) return () => {};
  const t = setInterval(() => {
    if (getPpid() !== start || !alive(start)) {
      clearInterval(t);
      onGone();
    }
  }, opts.intervalMs ?? 1000);
  t.unref();
  return () => clearInterval(t);
}

// No token: the URL with its token is printed once, by the server that owns it (ADR-0011 Decision 6).
export interface Lock { pid: number; host: string; port: number; startedAt: string }

// One file per port in the OS temp dir, never in the user's repo.
export function lockPath(port: number, dir: string = tmpdir()): string {
  return join(dir, `truss-ui-${port}.json`);
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

// Called once we hold the port, so any file already there is stale or foreign: it is unlinked (a
// symlink itself, never its target), then the lockfile is created exclusively with mode 0600. Returns
// false when that fails (for example another user's file in a shared /tmp); the caller runs without one.
export function writeLock(path: string, lock: Lock): boolean {
  try { unlinkSync(path); } catch { /* absent, or not ours to remove: the exclusive create decides */ }
  let fd: number | undefined;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeSync(fd, JSON.stringify(lock) + '\n');
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The lock at path when it is a regular file, well formed and its pid is alive; anything else is null.
export function readLiveLock(path: string): Lock | null {
  if (!isRegularFile(path)) return null;
  try {
    const l = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof l?.pid !== 'number' || typeof l?.host !== 'string' || typeof l?.port !== 'number' || !pidAlive(l.pid)) return null;
    return { pid: l.pid, host: l.host, port: l.port, startedAt: String(l.startedAt ?? '') };
  } catch {
    return null;
  }
}

// Removes the lockfile only when it is a regular file that is still ours.
export function removeLock(path: string, pid: number = process.pid): void {
  if (!isRegularFile(path)) return;
  try {
    if (JSON.parse(readFileSync(path, 'utf8'))?.pid === pid) unlinkSync(path);
  } catch {
    // gone already, or unreadable
  }
}

export function addrInUseMessage(host: string, port: number, lock: Lock | null): string {
  const lines = [`truss-ui: ${host}:${port} is already in use; a truss UI may already be running there.`];
  if (lock) {
    lines.push(`  Running truss UI: ${lock.host}:${lock.port}, pid ${lock.pid}${lock.startedAt ? `, started ${lock.startedAt}` : ''}.`);
    lines.push('  Open the URL that process printed when it started, or stop it and start again.');
    lines.push(`  To stop it: kill ${lock.pid}   (Windows: taskkill /PID ${lock.pid} /F)`);
  } else {
    lines.push('  No running truss UI is recorded for this port; another program may hold it.');
    lines.push('  To find it: lsof -i :' + port + '   (Windows: netstat -ano | findstr :' + port + ')');
  }
  lines.push(`  Or start on another port: --port <n> (--port 0 lets the OS pick a free one).`);
  return lines.join('\n') + '\n';
}
