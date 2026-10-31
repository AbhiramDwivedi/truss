// Process lifecycle for ui/server/main.ts: shutdown signals, parent and ancestor-chain death watch, the
// per-port lockfile and the "port in use" message. Node built-ins only; every function here never throws.
import { execFile } from 'node:child_process';
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

// Field 4 (ppid) of a /proc/<pid>/stat line, read after the last ')' because the command name can
// hold spaces and parentheses. null when the line is not in that shape.
export function ppidFromProcStat(stat: string): number | null {
  try {
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const m = /^\s+\S+\s+(\d+)(?:\s|$)/.exec(stat.slice(close + 1));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export interface Win32Row { ProcessId: number; ParentProcessId: number; CreationDate: number }

// The ancestors of startPid, parent upward, from one Win32_Process snapshot (CreationDate in ms since
// epoch). Stops at pid 1 or below, at a pid already seen, at a parent created after its child (Windows
// reuses pids) and at a parent missing from the rows (that parent is still returned).
export function chainFromWin32(rows: Win32Row[], startPid: number): number[] {
  const out: number[] = [];
  try {
    const byPid = new Map<number, Win32Row>();
    for (const r of rows) byPid.set(r.ProcessId, r);
    const seen = new Set<number>([startPid]);
    let cur = byPid.get(startPid);
    while (cur) {
      const ppid = cur.ParentProcessId;
      if (!Number.isInteger(ppid) || ppid <= 1 || seen.has(ppid)) break;
      const parent = byPid.get(ppid);
      if (parent && parent.CreationDate > cur.CreationDate) break;
      seen.add(ppid);
      out.push(ppid);
      cur = parent;
    }
  } catch {
    // return what was walked
  }
  return out;
}

const READ_TIMEOUT_MS = 10_000;

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile(cmd, args, { timeout: READ_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
    } catch (e) {
      reject(e);
    }
  });
}

function linuxChain(): number[] {
  const out: number[] = [];
  const seen = new Set<number>([process.pid]);
  let pid: number | null = process.ppid;
  try {
    while (pid !== null && pid > 1 && !seen.has(pid) && pidAlive(pid)) {
      out.push(pid);
      seen.add(pid);
      pid = ppidFromProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    }
  } catch {
    // the read failed: keep what was walked
  }
  return out;
}

async function macChain(): Promise<number[]> {
  const out: number[] = [];
  const seen = new Set<number>([process.pid]);
  let pid = process.ppid;
  while (Number.isInteger(pid) && pid > 1 && !seen.has(pid) && pidAlive(pid)) {
    out.push(pid);
    seen.add(pid);
    pid = Number((await run('ps', ['-o', 'ppid=', '-p', String(pid)])).trim());
  }
  return out;
}

async function windowsChain(): Promise<number[]> {
  const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,@{n="CreationDate";e={[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress';
  const parsed = JSON.parse(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]));
  const rows: Win32Row[] = Array.isArray(parsed) ? parsed : [parsed];
  return chainFromWin32(rows, process.pid).filter((p) => pidAlive(p));
}

// The pids above this process, parent upward. Read once, at start. May throw or reject: watchParent
// then falls back to the parent-only check.
export function defaultAncestors(): number[] | Promise<number[]> {
  if (process.platform === 'linux') return linuxChain();
  if (process.platform === 'win32') return windowsChain();
  if (process.platform === 'darwin') return macChain();
  return [];
}

// Calls onGone once when the process that started us, or any ancestor of it, goes away (ADR-0014
// Decision 5). Under npm the parent is often a cmd.exe or an npm-cli process that can outlive the
// shell that was closed, so the ancestor chain is read once, at start, through ancestors(), and each
// tick checks every pid with alive(): no tick starts a child process. When ancestors() throws, rejects,
// returns nothing or never settles, only the parent is checked. On Linux and macOS an orphan is
// re-parented, so process.ppid changes; on Windows ppid keeps the old value, so the old pid is also
// probed. Skipped when started by init (ppid 1), which is a deliberate daemon. The timer is unref'd,
// so it never keeps the process alive by itself.
export function watchParent(onGone: () => void, opts: { intervalMs?: number; getPpid?: () => number; alive?: (pid: number) => boolean; ancestors?: () => number[] | Promise<number[]> } = {}): () => void {
  const getPpid = opts.getPpid ?? (() => process.ppid);
  const alive = opts.alive ?? pidAlive;
  const ancestors = opts.ancestors ?? defaultAncestors;
  const start = getPpid();
  if (!Number.isInteger(start) || start <= 1) return () => {};
  let chain: number[] = [];
  let done = false;
  const t = setInterval(() => {
    if (done) return;
    let gone = false;
    try {
      gone = getPpid() !== start || !alive(start) || chain.some((p) => !alive(p));
    } catch {
      gone = false;
    }
    if (gone) {
      done = true;
      clearInterval(t);
      onGone();
    }
  }, opts.intervalMs ?? 1000);
  t.unref();
  try {
    Promise.resolve(ancestors()).then(
      (pids) => { if (!done && Array.isArray(pids)) chain = pids.filter((p) => Number.isInteger(p) && p > 1 && p !== start); },
      () => {},
    );
  } catch {
    // sync throw: parent-only
  }
  return () => { done = true; clearInterval(t); };
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
