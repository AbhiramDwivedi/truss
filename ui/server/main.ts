// Entry point (ADR-0011 Decision 8): wires ui-state and ui-session for one repo and serves them on 127.0.0.1.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: node ui/server/main.ts [--repo <path>] [--plugin <path>] [--truss-dir <path>] [--port <n>]';
const uiDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function oneLine(e: unknown): string {
  return String((e as Error)?.message ?? e).split('\n')[0]!;
}

function fail(code: number, msg: string): never {
  process.stderr.write(msg.replace(/\s*\n\s*/g, ' ') + '\n');
  process.exit(code);
}

function parseArgs(argv: string[]) {
  const o: { repo?: string; plugin?: string; trussDir?: string; port: number } = { port: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    if (!['--repo', '--plugin', '--truss-dir', '--port'].includes(flag)) fail(2, `unknown argument ${flag}; ${USAGE}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) fail(2, `${flag} needs a value; ${USAGE}`);
    if (flag === '--repo') o.repo = value;
    else if (flag === '--plugin') o.plugin = value;
    else if (flag === '--truss-dir') o.trussDir = value;
    else {
      if (!/^\d+$/.test(value) || Number(value) > 65535) fail(2, `--port must be an integer 0 to 65535; ${USAGE}`);
      o.port = Number(value);
    }
  }
  return o;
}

// Warn, never exit: the UI is tested on the engines range but still runs on older Node.
const { nodeVersionWarning, readEnginesRange } = await import('./node-version.ts');
const nodeWarning = nodeVersionWarning(process.versions.node, readEnginesRange(uiDir) ?? '');
if (nodeWarning) process.stderr.write(nodeWarning + '\n');

const args = parseArgs(process.argv.slice(2));
const repo = resolve(args.repo ?? process.env.INIT_CWD ?? process.cwd());
const pluginPath = resolve(args.plugin ?? join(uiDir, '..'));
if (!existsSync(join(pluginPath, '.claude-plugin', 'plugin.json'))) {
  fail(2, `plugin root ${pluginPath} has no .claude-plugin/plugin.json; ${USAGE}`);
}
const trussDirFlag = args.trussDir === undefined ? undefined : resolve(args.trussDir);

// Loaded after the flag checks so a bad command line exits 2 before these modules are touched.
const { createStore, trussDirFor } = await import('./state/index.ts');
const { createSession } = await import('./session/index.ts');
const { createServer } = await import('./http/index.ts');

const store = createStore(trussDirFlag === undefined ? { repo } : { repo, trussDir: trussDirFlag });
const session = createSession({ repo, pluginPath });
let lastSessionId: string | null = null;
session.subscribe((view) => {
  store.setSession(view);
  const id = view.session.sessionId;
  if (trussDirFlag === undefined && id && id !== lastSessionId) {
    lastSessionId = id;
    trussDirFor(repo, id).then(
      (dir) => { if (lastSessionId === id) store.setTrussDir(dir); },
      (e) => process.stderr.write(`truss dir lookup failed: ${oneLine(e)}\n`),
    );
  }
});

const server = createServer({ state: store, session, webDir: join(uiDir, 'web') });
const { onShutdownSignals, watchParent, lockPath, writeLock, readLiveLock, removeLock, addrInUseMessage } = await import('./lifecycle.ts');
let url: string;
let port: number;
try {
  ({ url, port } = await server.listen(args.port));
} catch (e) {
  session.close().catch(() => {});
  store.close();
  if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    process.stderr.write(addrInUseMessage('127.0.0.1', args.port, readLiveLock(lockPath(args.port))));
    process.exit(1);
  }
  fail(1, `listen failed: ${oneLine(e)}`);
}
const lock = lockPath(port);
if (!writeLock(lock, { pid: process.pid, host: '127.0.0.1', port, startedAt: new Date().toISOString() })) {
  process.stderr.write(`truss-ui: could not write lockfile ${lock}; carrying on without it\n`);
}
process.on('exit', () => removeLock(lock));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  // A stuck session close must not leave the port held: force the exit after 5 s.
  setTimeout(() => { removeLock(lock); process.exit(0); }, 5000).unref();
  try { await session.close(); } catch (e) { process.stderr.write(`session close failed: ${oneLine(e)}\n`); }
  try { await server.close(); } catch (e) { process.stderr.write(`server close failed: ${oneLine(e)}\n`); }
  store.close();
  removeLock(lock);
  process.exit(0);
}
// SIGINT, SIGTERM, SIGHUP and SIGBREAK, and the parent (npm, a shell) going away, all end the server.
onShutdownSignals(process, shutdown);
watchParent(shutdown);
// Printed last, so whoever waits on this line can already stop the server with any of the signals above.
process.stdout.write(`truss-ui listening on ${url}\n`);
