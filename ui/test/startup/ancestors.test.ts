// ADR-0014 Decision 5: watchParent watches the whole ancestor chain through injected ancestors() and
// alive(). A simulated npm-cli / cmd.exe / shell chain, the pure chain readers, and (Linux) the real main.ts.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as lifecycle from '../../server/lifecycle.ts';

const { watchParent } = lifecycle;
const ppidFromProcStat = (lifecycle as any).ppidFromProcStat as (s: string) => number | null;
const chainFromWin32 = (lifecycle as any).chainFromWin32 as (
  rows: { ProcessId: number; ParentProcessId: number; CreationDate: number }[], startPid: number) => number[];

const main = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'main.ts');
const tmp = mkdtempSync(join(tmpdir(), 'truss-ancestors-test-'));
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch {} }
  rmSync(tmp, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TICK = 5;
const SETTLE = 80; // many intervals, so an async chain read has time to land

// parent upward: cmd.exe 300, npm-cli 200, shell 100
const CMD = 300, NPM = 200, SHELL = 100;
const chain = () => [CMD, NPM, SHELL];

function watch(opts: { ancestors?: () => number[] | Promise<number[]>; ppid?: () => number; live: Set<number> }) {
  let fired = 0;
  const stop = watchParent(() => { fired++; }, {
    intervalMs: TICK,
    getPpid: opts.ppid ?? (() => CMD),
    alive: (p: number) => opts.live.has(p),
    ancestors: opts.ancestors,
  } as any);
  return { stop, get fired() { return fired; } };
}

describe('simulated chain shell -> npm-cli -> cmd.exe', () => {
  it('a live chain fires nothing over many ticks', async () => {
    const w = watch({ ancestors: chain, live: new Set([CMD, NPM, SHELL]) });
    await sleep(SETTLE);
    assert.equal(w.fired, 0);
    w.stop();
  });

  for (const [name, pid] of [['cmd.exe', CMD], ['npm-cli', NPM], ['shell', SHELL]] as const) {
    for (const mode of ['sync', 'async'] as const) {
      it(`death of ${name} fires onGone exactly once (${mode} ancestors)`, async () => {
        const live = new Set([CMD, NPM, SHELL]);
        const w = watch({ ancestors: mode === 'sync' ? chain : async () => chain(), live });
        await sleep(SETTLE);
        assert.equal(w.fired, 0, 'alive first');
        live.delete(pid);
        await sleep(SETTLE);
        assert.equal(w.fired, 1);
        await sleep(SETTLE);
        assert.equal(w.fired, 1, 'still once after further ticks');
        w.stop();
      });
    }
  }

  it('a ppid change still fires once with a live chain', async () => {
    let ppid = CMD;
    const w = watch({ ancestors: chain, ppid: () => ppid, live: new Set([CMD, NPM, SHELL]) });
    await sleep(SETTLE);
    ppid = 1;
    await sleep(SETTLE);
    assert.equal(w.fired, 1);
    await sleep(SETTLE);
    assert.equal(w.fired, 1);
    w.stop();
  });
});

describe('a failed ancestors() keeps the parent-only behaviour', () => {
  const failures: [string, () => number[] | Promise<number[]>][] = [
    ['sync throw', () => { throw new Error('boom'); }],
    ['rejected promise', () => Promise.reject(new Error('boom'))],
    ['never-settling promise', () => new Promise<number[]>(() => {})],
    ['empty array', () => []],
  ];
  for (const [name, ancestors] of failures) {
    it(`${name}: dead grandparent alone fires nothing`, async () => {
      const live = new Set([CMD]); // npm-cli and shell are dead
      const w = watch({ ancestors, live });
      await sleep(SETTLE);
      assert.equal(w.fired, 0);
      w.stop();
    });
    it(`${name}: dead direct parent fires once`, async () => {
      const live = new Set([CMD, NPM, SHELL]);
      const w = watch({ ancestors, live });
      await sleep(SETTLE);
      assert.equal(w.fired, 0);
      live.delete(CMD);
      await sleep(SETTLE);
      assert.equal(w.fired, 1);
      await sleep(SETTLE);
      assert.equal(w.fired, 1);
      w.stop();
    });
    it(`${name}: a ppid change fires once`, async () => {
      let ppid = CMD;
      const w = watch({ ancestors, ppid: () => ppid, live: new Set([CMD, NPM, SHELL]) });
      await sleep(SETTLE);
      ppid = 77;
      await sleep(SETTLE);
      assert.equal(w.fired, 1);
      w.stop();
    });
  }
});

describe('watchParent edges', () => {
  it('ppid 1: nothing fires even with a chain whose members are dead', async () => {
    const w = watch({ ancestors: chain, ppid: () => 1, live: new Set() });
    await sleep(SETTLE);
    assert.equal(w.fired, 0);
    w.stop();
  });

  it('the stop function stops further checks', async () => {
    const live = new Set([CMD, NPM, SHELL]);
    const w = watch({ ancestors: chain, live });
    await sleep(SETTLE);
    w.stop();
    live.delete(SHELL);
    live.delete(CMD);
    await sleep(SETTLE);
    assert.equal(w.fired, 0);
  });

  it('stop before the chain read settles fires nothing afterwards', async () => {
    const live = new Set([CMD, NPM, SHELL]);
    const w = watch({ ancestors: async () => { await sleep(20); return chain(); }, live });
    w.stop();
    live.clear();
    await sleep(SETTLE);
    assert.equal(w.fired, 0);
  });
});

describe('ppidFromProcStat', () => {
  it('reads field 4 of a normal line', () => {
    assert.equal(ppidFromProcStat('123 (node) S 456 123 123 0 -1 4194560 1000 0 0 0'), 456);
  });
  it('handles a comm with spaces and parentheses', () => {
    assert.equal(ppidFromProcStat('123 (a) b (c)) S 456 123 123 0 -1 4194560 1000'), 456);
  });
  it('returns null for garbage', () => {
    assert.equal(ppidFromProcStat('garbage'), null);
    assert.equal(ppidFromProcStat(''), null);
    assert.equal(ppidFromProcStat('123 (node) S notanumber 1'), null);
  });
});

describe('chainFromWin32', () => {
  const row = (ProcessId: number, ParentProcessId: number, CreationDate: number) => ({ ProcessId, ParentProcessId, CreationDate });

  it('shell -> npm-cli -> cmd.exe -> ui gives the chain parent upward', () => {
    const rows = [row(100, 4, 1000), row(200, 100, 2000), row(300, 200, 3000), row(400, 300, 4000)];
    assert.deepEqual(chainFromWin32(rows, 400), [300, 200, 100, 4]);
  });
  it('stops at a parent created after its child (reused pid)', () => {
    // 200 is recorded as the parent of 300, but a later process now holds pid 200
    const rows = [row(100, 4, 1000), row(200, 100, 9000), row(300, 200, 3000), row(400, 300, 4000)];
    assert.deepEqual(chainFromWin32(rows, 400), [300]);
  });
  it('stops at a cycle', () => {
    const rows = [row(10, 20, 1), row(20, 30, 1), row(30, 20, 1), row(40, 10, 2)];
    assert.deepEqual(chainFromWin32(rows, 40), [10, 20, 30]);
  });
  it('stops at pid 0 and pid 1', () => {
    assert.deepEqual(chainFromWin32([row(50, 0, 1), row(60, 50, 2)], 60), [50]);
    assert.deepEqual(chainFromWin32([row(50, 1, 1), row(60, 50, 2)], 60), [50]);
  });
  it('stops at a pid missing from the rows', () => {
    assert.deepEqual(chainFromWin32([row(60, 999, 2)], 60), [999]);
  });
});

// Real processes, Linux only: grandparent -> middle -> main.ts. Killing only the grandparent must stop main.ts.
describe('real chain', { skip: process.platform !== 'linux' ? 'needs /proc and POSIX signals (Linux only)' : false }, () => {
  it('SIGKILL of the grandparent alone stops main.ts while its direct parent lives', async () => {
    const lockDir = join(tmp, 'tmpdir');
    const repo = join(tmp, 'repo');
    mkdirSync(lockDir);
    mkdirSync(repo);
    const env = { ...process.env, TMPDIR: lockDir, TMP: lockDir, TEMP: lockDir, INIT_CWD: repo };
    const pidFile = join(tmp, 'main.pid');
    const midPidFile = join(tmp, 'middle.pid');
    const middleJs = join(tmp, 'middle.mjs');
    const grandJs = join(tmp, 'grand.mjs');
    writeFileSync(middleJs, [
      "import { spawn } from 'node:child_process';",
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(midPidFile)}, String(process.pid));`,
      `const c = spawn(process.execPath, [${JSON.stringify(main)}, '--repo', ${JSON.stringify(repo)}, '--port', '0'], { stdio: 'inherit', env: process.env, cwd: ${JSON.stringify(repo)} });`,
      `writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));
    writeFileSync(grandJs, [
      "import { spawn } from 'node:child_process';",
      `spawn(process.execPath, [${JSON.stringify(middleJs)}], { stdio: 'inherit', env: process.env });`,
      'setInterval(() => {}, 1000);',
    ].join('\n'));

    const grand = spawn(process.execPath, [grandJs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(grand);
    let out = '';
    let err = '';
    grand.stdout!.on('data', (d) => { out += String(d); });
    grand.stderr!.on('data', (d) => { err += String(d); });

    const until = async (cond: () => boolean, ms: number, what: string) => {
      const end = Date.now() + ms;
      while (!cond()) {
        if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}; stdout: ${out}; stderr: ${err}`);
        await sleep(50);
      }
    };
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as any).code === 'EPERM'; } };
    const readPid = (f: string) => Number(readFileSync(f, 'utf8'));

    await until(() => /truss-ui listening on \S+/.test(out) && existsSync(pidFile) && existsSync(midPidFile), 20000, 'main.ts to listen');
    const mainPid = readPid(pidFile);
    const midPid = readPid(midPidFile);
    children.push({ kill: (s: NodeJS.Signals) => { try { process.kill(midPid, s); } catch {} try { process.kill(mainPid, s); } catch {} } } as ChildProcess);
    assert.ok(alive(mainPid) && alive(midPid), 'both alive before the kill');

    await sleep(1500); // let the watch pass a few ticks with a live chain
    assert.ok(alive(mainPid), 'a live chain does not stop main.ts');

    process.kill(grand.pid!, 'SIGKILL');
    await until(() => !alive(mainPid), 10000, 'main.ts to exit after its grandparent died');
    assert.ok(alive(midPid), 'the direct parent was still alive: only the grandparent died');
  });
});
