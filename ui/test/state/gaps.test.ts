// Tests for ADR-0023 state gaps d (run.goals), f (crew.estAgents) and g (crew.stuck), written from the ADR
// and ui/contract/state.schema.json before the implementation. They cover cases ui/contract/gaps.check.ts does not.
// Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; nothing listens on a port.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../server/state/index.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'truss-state-gaps-'));
after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });
let n = 0;
const dir = (name: string) => { const d = join(tmpRoot, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; };

async function until(f: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) assert.fail('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function storeFor(files: Record<string, string>) {
  const repo = dir('repo');
  const truss = dir('truss');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(truss, name), text);
  const store = createStore({ repo, trussDir: truss, pollMs: 40 });
  return { store, truss, run: () => (store.snapshot().state as any).run as any };
}
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const crewBy = (run: any, slug: string) => run.crews.find((c: any) => c.slug === slug);

const plan = (o: { crews: unknown[]; goals?: unknown[]; first?: Record<string, unknown> }) =>
  JSON.stringify({
    version: 3, goal: 'First goal', approval: 'auto', approvedAt: null, architecture: 'docs/architecture.md',
    maxParallelCrews: 2, reworkAllowance: 2, ...(o.first ?? {}), ...(o.goals ? { goals: o.goals } : {}), crews: o.crews,
  });
const row = (slug: string, status: string, estAgents: number) => ({
  slug, stage: 0, verdict: 'build', modules: ['m'], owns: [`src/${slug}.ts`], acceptanceTest: 'npm test', acceptanceTestProved: true, estAgents, status,
});
const spawn = (ts: string, crew: string, agent: string) => ({
  v: 1, ts, event: 'spawn', crew, agent, agentId: 'id-' + agent, type: agent === crew ? 'truss:foreman' : 'kit:builder', model: 'opus', effort: 'high', by: 'main',
});
const stall = (ts: string, crew: string, agent: string, kind: string, minutes: number) => ({ v: 1, ts, event: 'stall', crew, agent, kind, minutes });
const tag = (ts: string, crew: string, agent: string) => ({ v: 1, ts, event: 'tag', crew, agent, tag: 'DONE' });

// ---------------------------------------------------------------------------
// Gap d
// ---------------------------------------------------------------------------
test('gap d: each goal item has exactly {id, goal, approval, approvedAt}; addedAt is not carried; a null first approvedAt stays null', () => {
  const w = storeFor({
    'plan.json': plan({
      crews: [row('a', 'running', 1)],
      goals: [{ id: 'g2', goal: 'Second', addedAt: '2026-10-27T10:00:00Z', approval: 'client', approvedAt: '2026-10-27T10:05:00Z' }],
    }),
  });
  try {
    const goals = w.run().goals;
    assert.ok(Array.isArray(goals), 'run.goals is an array');
    assert.equal(goals.length, 2);
    for (const g of goals) assert.deepEqual(Object.keys(g).sort(), ['approval', 'approvedAt', 'goal', 'id']);
    assert.deepEqual(goals[0], { id: 'run', goal: 'First goal', approval: 'auto', approvedAt: null });
    assert.equal(goals[1].id, 'g2');
  } finally { w.store.close(); }
});

test('gap d: the run goal is first and takes plan.json top-level fields, whatever the goals array holds', () => {
  const w = storeFor({
    'plan.json': plan({
      first: { goal: 'Top level text', approval: 'client', approvedAt: '2026-01-02T03:04:05Z' },
      crews: [row('a', 'planned', 1)],
      goals: [
        { id: 'zz', goal: 'Z first in file', addedAt: '2026-10-27T10:00:00Z', approval: 'auto', approvedAt: null },
        { id: 'aa', goal: 'A second in file', addedAt: '2026-10-27T09:00:00Z', approval: 'auto', approvedAt: null },
      ],
    }),
  });
  try {
    assert.deepEqual(w.run().goals.map((g: any) => g.id), ['run', 'zz', 'aa'], 'run first, then file order (not sorted)');
    assert.equal(w.run().goals[0].goal, 'Top level text');
    assert.equal(w.run().goals[0].approvedAt, '2026-01-02T03:04:05Z');
  } finally { w.store.close(); }
});

test('gap d: an empty goals array gives only the run goal', () => {
  const w = storeFor({ 'plan.json': plan({ crews: [row('a', 'planned', 1)], goals: [] }) });
  try {
    assert.deepEqual(w.run().goals.map((g: any) => g.id), ['run']);
  } finally { w.store.close(); }
});

test('gap d: a plan.json that cannot be parsed gives goals []', () => {
  const w = storeFor({ 'plan.json': '{ not json', 'events.jsonl': jsonl([spawn('2026-10-27T09:00:00.000Z', 'a', 'a')]) });
  try {
    assert.ok(w.run() !== null);
    assert.deepEqual(w.run().goals, []);
  } finally { w.store.close(); }
});

test('gap d: a goal appended to plan.json shows up on the next poll', async () => {
  const w = storeFor({ 'plan.json': plan({ crews: [row('a', 'running', 1)] }) });
  try {
    assert.deepEqual(w.run().goals.map((g: any) => g.id), ['run']);
    writeFileSync(join(w.truss, 'plan.json'), plan({
      crews: [row('a', 'running', 1)],
      goals: [{ id: 'later', goal: 'Later goal', addedAt: '2026-10-27T10:00:00Z', approval: 'auto', approvedAt: null }],
    }));
    await until(() => w.run().goals.length === 2, 'the appended goal');
    assert.equal(w.run().goals[1].id, 'later');
  } finally { w.store.close(); }
});

// ---------------------------------------------------------------------------
// Gap f
// ---------------------------------------------------------------------------
test('gap f: every crew carries an estAgents key, an integer for planned crews and null otherwise', () => {
  const w = storeFor({
    'plan.json': plan({ crews: [row('p1', 'planned', 1), row('p7', 'merged', 7)] }),
    'events.jsonl': jsonl([spawn('2026-10-27T09:00:00.000Z', 'only-events', 'only-events')]),
  });
  try {
    for (const c of w.run().crews) assert.ok('estAgents' in c, `crew ${c.slug} has estAgents`);
    assert.equal(crewBy(w.run(), 'p1').estAgents, 1);
    assert.equal(crewBy(w.run(), 'p7').estAgents, 7);
    assert.equal(crewBy(w.run(), 'only-events').estAgents, null);
  } finally { w.store.close(); }
});

test('gap f: there is no task total anywhere on run or crew', () => {
  const w = storeFor({ 'plan.json': plan({ crews: [row('a', 'running', 4)] }) });
  try {
    const bad = /total|taskCount|tasksTotal|estTasks/i;
    for (const k of Object.keys(w.run())) assert.doesNotMatch(k, bad, `run.${k}`);
    for (const k of Object.keys(crewBy(w.run(), 'a'))) assert.doesNotMatch(k, bad, `crew.${k}`);
  } finally { w.store.close(); }
});

test('gap f: estAgents follows a plan.json change', async () => {
  const w = storeFor({ 'plan.json': plan({ crews: [row('a', 'running', 2)] }) });
  try {
    assert.equal(crewBy(w.run(), 'a').estAgents, 2);
    writeFileSync(join(w.truss, 'plan.json'), plan({ crews: [row('a', 'running', 6)] }));
    await until(() => crewBy(w.run(), 'a').estAgents === 6, 'estAgents 6');
  } finally { w.store.close(); }
});

// ---------------------------------------------------------------------------
// Gap g
// ---------------------------------------------------------------------------
const T = (m: number) => `2026-10-27T09:${String(m).padStart(2, '0')}:00.000Z`;

test('gap g: every crew has a stuck key, null for a quiet running crew', () => {
  const w = storeFor({
    'plan.json': plan({ crews: [row('a', 'running', 1)] }),
    'events.jsonl': jsonl([spawn(T(0), 'a', 'a')]),
  });
  try {
    assert.ok('stuck' in crewBy(w.run(), 'a'));
    assert.equal(crewBy(w.run(), 'a').stuck, null);
  } finally { w.store.close(); }
});

test('gap g: the latest stall wins when a crew has several', () => {
  const w = storeFor({
    'plan.json': plan({ crews: [row('a', 'running', 2)] }),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a'), spawn(T(1), 'a', 'a-one'), spawn(T(1), 'a', 'a-two'),
      stall(T(20), 'a', 'a-one', 'agent', 10),
      stall(T(40), 'a', 'a-two', 'agent', 25),
    ]),
  });
  try {
    const s = crewBy(w.run(), 'a').stuck;
    assert.ok(s, 'stuck is set');
    assert.equal(s.detail, 'a-two stalled 25 min');
    assert.equal(s.minutes, 25);
    assert.equal(Date.parse(s.since), Date.parse(T(15)));
  } finally { w.store.close(); }
});

test('gap g: since is RFC 3339 UTC', () => {
  const w = storeFor({
    'plan.json': plan({ crews: [row('a', 'running', 1)] }),
    'events.jsonl': jsonl([spawn(T(0), 'a', 'a'), stall(T(30), 'a', 'a', 'idle-foreman', 12)]),
  });
  try {
    const s = crewBy(w.run(), 'a').stuck;
    assert.ok(s, 'stuck is set');
    assert.match(s.since, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    assert.equal(s.kind, 'idle-foreman');
    assert.equal(s.detail, 'a stalled 12 min');
  } finally { w.store.close(); }
});

test('gap g: a later event from a different agent does not clear the stall', () => {
  const w = storeFor({
    'plan.json': plan({ crews: [row('a', 'running', 2)] }),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a-one'), spawn(T(1), 'a', 'a-two'),
      stall(T(20), 'a', 'a-one', 'agent', 10),
      tag(T(25), 'a', 'a-two'),
    ]),
  });
  try {
    const s = crewBy(w.run(), 'a').stuck;
    assert.ok(s, 'a-one is still stalled');
    assert.equal(s.kind, 'stalled');
    assert.equal(s.detail, 'a-one stalled 10 min');
  } finally { w.store.close(); }
});

test('gap g: stuck clears when the stalled agent speaks again, and when the crew stops running', async () => {
  const w = storeFor({
    'plan.json': plan({ crews: [row('a', 'running', 1)] }),
    'events.jsonl': jsonl([spawn(T(0), 'a', 'a'), stall(T(30), 'a', 'a', 'agent', 10)]),
  });
  try {
    assert.ok(crewBy(w.run(), 'a').stuck, 'stuck at first');
    writeFileSync(join(w.truss, 'events.jsonl'), jsonl([spawn(T(0), 'a', 'a'), stall(T(30), 'a', 'a', 'agent', 10), tag(T(35), 'a', 'a')]));
    await until(() => crewBy(w.run(), 'a').stuck === null, 'stuck to clear after a later event');
  } finally { w.store.close(); }

  const x = storeFor({
    'plan.json': plan({ crews: [row('b', 'running', 1)] }),
    'events.jsonl': jsonl([spawn(T(0), 'b', 'b'), stall(T(30), 'b', 'b', 'agent', 10)]),
  });
  try {
    assert.ok(crewBy(x.run(), 'b').stuck, 'stuck while running');
    writeFileSync(join(x.truss, 'plan.json'), plan({ crews: [row('b', 'dropped', 1)] }));
    await until(() => crewBy(x.run(), 'b').stuck === null, 'stuck to clear once the crew is not running');
  } finally { x.store.close(); }
});
