// Tests for ADR-0028 section 6 (R-42, R-9): Member.agentId and Member.purpose, through createStore.
// Written from the ADR before the implementation. Erasable TypeScript, node:test, built-ins only.
// Temp dirs come from mkdtemp; nothing is stored outside them and no port is opened.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const uiDir = path.dirname(path.dirname(here));
const serverUrl = (rel: string) => pathToFileURL(path.join(uiDir, 'server', rel)).href;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-state-rework-'));
after(() => { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); });
let counter = 0;
const tmpDir = (name: string) => {
  const d = path.join(tmpRoot, `${name}-${++counter}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
};

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PLAN = JSON.stringify({
  version: 3, goal: 'Rework the UI', approval: 'client', approvedAt: '2026-11-04T15:31:12Z', architecture: 'docs/architecture.md',
  maxParallelCrews: 2, reworkAllowance: 2,
  crews: [{ slug: 'alpha', stage: 0, verdict: 'build', modules: ['m'], owns: ['src/alpha.ts'], acceptanceTest: 'npm test', acceptanceTestProved: true, estAgents: 3, status: 'planned' }],
});
const spawn = (agent: string, type: string, agentId?: string | null) => {
  const o: Record<string, unknown> = { v: 1, ts: '2026-11-04T16:00:00Z', event: 'spawn', crew: 'alpha', agent, type, model: 'opus', effort: 'high', by: 'main' };
  if (agentId !== undefined) o.agentId = agentId;
  return o;
};
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

// A plugin dir with agents/<name>.md files whose front matter holds a description: line.
function pluginDir(descriptions: Record<string, string>): string {
  const dir = tmpDir('plugin');
  fs.mkdirSync(path.join(dir, 'agents'));
  for (const [name, d] of Object.entries(descriptions)) {
    fs.writeFileSync(path.join(dir, 'agents', `${name}.md`), `---\nname: ${name}\ndescription: ${d}\nmodel: sonnet\n---\n\nBody text for ${name}.\n`);
  }
  return dir;
}

const DESCRIPTIONS = {
  foreman: 'Leads one crew of agents. It splits the goal into tasks and reports at the end.',
  builder: 'Builds the change the brief names. It works in its own worktree.',
  'qc-engineer': 'Rules on one crew’s work against its proof.',
};

const SPAWNS = [
  spawn('alpha', 'workflow-crew', null),
  spawn('alpha-builder', 'truss:builder', 'a1111111111111111'),
  spawn('alpha-qc', 'truss:qc-engineer', 'a2222222222222222'),
  spawn('alpha-gp', 'general-purpose', 'a3333333333333333'),
  spawn('alpha-odd', 'kit:mystery', 'a4444444444444444'),
  spawn('alpha-ghost', 'truss:ghost', 'a5555555555555555'),
  spawn('alpha-noid', 'truss:builder'),
];

function boot(pluginPath: string | undefined, rows: unknown[] = SPAWNS) {
  return (async () => {
    const { createStore } = await import(serverUrl('state/index.ts'));
    const repo = tmpDir('repo');
    const truss = tmpDir('truss');
    fs.writeFileSync(path.join(truss, 'plan.json'), PLAN);
    fs.writeFileSync(path.join(truss, 'events.jsonl'), jsonl(rows));
    const store = createStore(pluginPath === undefined ? { repo, trussDir: truss, pollMs: 50 } : { repo, trussDir: truss, pluginPath, pollMs: 50 });
    const crew = () => (store.snapshot().state as any).run?.crews?.find((c: any) => c.slug === 'alpha');
    const member = (name: string) => {
      const c = crew();
      return c?.foreman?.name === name ? c.foreman : c?.members?.find((m: any) => m.name === name);
    };
    await until(() => member('alpha-noid') !== undefined && member('alpha') !== undefined, 'the crew members in the snapshot');
    return { store, member, close: () => store.close() };
  })();
}

test('R-42: Member.agentId equals the spawn line agentId, and is null when the line has none', async () => {
  const w = await boot(pluginDir(DESCRIPTIONS));
  try {
    assert.equal(w.member('alpha-builder').agentId, 'a1111111111111111');
    assert.equal(w.member('alpha-qc').agentId, 'a2222222222222222');
    assert.equal(w.member('alpha').agentId, null, 'a workflow-crew line with agentId null');
    assert.equal(w.member('alpha-noid').agentId, null, 'a line with no agentId key');
  } finally { w.close(); }
});

test('R-42: Member.purpose is the first sentence of the description line of agents/<name>.md for type truss:<name>', async () => {
  const w = await boot(pluginDir(DESCRIPTIONS));
  try {
    const norm = (s: unknown) => String(s).replace(/\.$/, '');
    assert.equal(typeof w.member('alpha-builder').purpose, 'string');
    assert.equal(norm(w.member('alpha-builder').purpose), 'Builds the change the brief names');
    assert.equal(norm(w.member('alpha-qc').purpose), 'Rules on one crew’s work against its proof');
  } finally { w.close(); }
});

test('R-42: type workflow-crew and the crew foreman map to the foreman agent file', async () => {
  const w = await boot(pluginDir(DESCRIPTIONS));
  try {
    const norm = (s: unknown) => String(s).replace(/\.$/, '');
    assert.equal(w.member('alpha').type, 'workflow-crew');
    assert.equal(norm(w.member('alpha').purpose), 'Leads one crew of agents');
  } finally { w.close(); }
});

test('R-42: a foreman spawned with type truss:foreman also gets the foreman purpose', async () => {
  const w = await boot(pluginDir(DESCRIPTIONS), [spawn('alpha', 'truss:foreman', 'a9999999999999999'), spawn('alpha-noid', 'truss:builder')]);
  try {
    assert.equal(String(w.member('alpha').purpose).replace(/\.$/, ''), 'Leads one crew of agents');
  } finally { w.close(); }
});

test('R-42: general-purpose, unknown types and a missing agents file give purpose null, never a throw', async () => {
  const w = await boot(pluginDir(DESCRIPTIONS));
  try {
    assert.equal(w.member('alpha-gp').purpose, null, 'general-purpose');
    assert.equal(w.member('alpha-odd').purpose, null, 'a type that is not truss:<name>');
    assert.equal(w.member('alpha-ghost').purpose, null, 'truss:ghost has no agents/ghost.md');
  } finally { w.close(); }
});

test('R-42: with no pluginPath every purpose is null and the store still works', async () => {
  const w = await boot(undefined);
  try {
    for (const n of ['alpha', 'alpha-builder', 'alpha-qc', 'alpha-gp', 'alpha-noid']) {
      assert.equal(w.member(n).purpose, null, `${n} purpose`);
    }
    assert.equal(w.member('alpha-builder').agentId, 'a1111111111111111', 'agentId does not depend on pluginPath');
  } finally { w.close(); }
});

test('R-42: a pluginPath without an agents directory gives null purposes, not an error', async () => {
  const w = await boot(tmpDir('empty-plugin'));
  try {
    assert.equal(w.member('alpha-builder').purpose, null);
    assert.equal(w.member('alpha').purpose, null);
  } finally { w.close(); }
});

test('R-9: the store writes no file into pluginPath', async () => {
  const dir = pluginDir(DESCRIPTIONS);
  const listing = () => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { out.push(p + '/'); walk(p); } else out.push(p + ':' + fs.readFileSync(p, 'utf8') + ':' + fs.statSync(p).mtimeMs);
      }
    };
    walk(dir);
    return out.sort();
  };
  const before = listing();
  const w = await boot(dir);
  try {
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(typeof w.member('alpha-builder').purpose === 'string', 'the store did read the plugin dir (purpose set)');
  } finally { w.close(); }
  assert.deepEqual(listing(), before, 'pluginPath holds exactly the files it held');
});
