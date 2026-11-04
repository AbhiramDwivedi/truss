// fixes5 item 54 (crew ui-fixes5): a successor foreman a-<n> clears crew a's idle-foreman stall; controls pin
// the by-credit rule at reduce.ts that stays. Erasable TypeScript, node:test, built-ins only. Nothing listens on a port.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const uiDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { createStore } = (await import(pathToFileURL(join(uiDir, 'server/state/index.ts')).href)) as any

const tmpRoot = mkdtempSync(join(tmpdir(), 'truss-fixes5-state-'))
after(() => { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
let n = 0
const dir = (name: string) => { const d = join(tmpRoot, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d }

function storeFor(files: Record<string, string>) {
  const repo = dir('repo')
  const truss = dir('truss')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(truss, name), text)
  const store = createStore({ repo, trussDir: truss, pollMs: 40 })
  return { store, truss, run: () => (store.snapshot().state as any).run as any }
}
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
const crewBy = (run: any, slug: string) => run.crews.find((c: any) => c.slug === slug)
const T = (m: number) => `2026-10-27T09:${String(m).padStart(2, '0')}:00.000Z`

const plan = (slugs: string[]) =>
  JSON.stringify({
    version: 3, goal: 'First goal', approval: 'auto', approvedAt: null, architecture: 'docs/architecture.md',
    maxParallelCrews: 2, reworkAllowance: 2,
    crews: slugs.map((slug) => ({
      slug, stage: 0, verdict: 'build', modules: ['m'], owns: [`src/${slug}.ts`], acceptanceTest: 'npm test',
      acceptanceTestProved: true, estAgents: 2, status: 'running',
    })),
  })
const spawn = (ts: string, crew: string, agent: string, by: string) => ({
  v: 1, ts, event: 'spawn', crew, agent, agentId: 'id-' + agent, type: agent === crew ? 'truss:foreman' : 'kit:builder',
  model: 'opus', effort: 'high', by,
})
const stall = (ts: string, crew: string, agent: string, kind: string, minutes: number) => ({ v: 1, ts, event: 'stall', crew, agent, kind, minutes })
const tag = (ts: string, crew: string, agent: string) => ({ v: 1, ts, event: 'tag', crew, agent, tag: 'DONE' })

test('i54 2: a later line of successor foreman a-2 clears the idle-foreman stall of crew a; a kind agent stall still needs the stalled agent', () => {
  const w = storeFor({
    'plan.json': plan(['a']),
    'events.jsonl': jsonl([spawn(T(0), 'a', 'a', 'main'), stall(T(20), 'a', 'a', 'idle-foreman', 12), tag(T(25), 'a', 'a-2')]),
  })
  const x = storeFor({
    'plan.json': plan(['a']),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a', 'main'), spawn(T(1), 'a', 'm', 'a'),
      stall(T(20), 'a', 'm', 'agent', 10), tag(T(25), 'a', 'a-2'),
    ]),
  })
  try {
    assert.equal(crewBy(w.run(), 'a').stuck, null, 'successor a-2 cleared the idle-foreman stall')
    const s = crewBy(x.run(), 'a').stuck
    assert.ok(s, 'agent stall of m is still stuck after a-2 speaks')
    assert.equal(s.kind, 'stalled')
  } finally { w.store.close(); x.store.close() }
})

test('i54 3: spawns by successor a-2, logged under crew a-2 (hook shape) or under crew a, clear the idle-foreman stall of crew a', () => {
  const run = (rows: unknown[]) => storeFor({ 'plan.json': plan(['a']), 'events.jsonl': jsonl([spawn(T(0), 'a', 'a', 'main'), stall(T(20), 'a', 'a', 'idle-foreman', 12), ...rows]) })
  const h = run([spawn(T(25), 'a-2', 'k', 'a-2')])
  const u = run([spawn(T(25), 'a', 'k', 'a-2')])
  const c = run([spawn(T(25), 'a-2', 'k', 'other')])
  try {
    assert.equal(crewBy(h.run(), 'a').stuck, null, 'hook shape (crew a-2) cleared it')
    assert.equal(crewBy(u.run(), 'a').stuck, null, 'spawn by a-2 under crew a cleared it')
    assert.equal(crewBy(c.run(), 'a').stuck?.kind, 'idle-foreman', 'a spawn by an unrelated name under crew a-2 does not')
  } finally { h.store.close(); u.store.close(); c.store.close() }
})

test('control 1: i54 a spawn by crew member named main does not clear a stall on that member (member main)', () => {
  const mem = (by: string) => storeFor({
    'plan.json': plan(['a']),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a', 'main'), spawn(T(1), 'a', 'main', 'a'),
      stall(T(20), 'a', 'main', 'agent', 10), spawn(T(25), 'a', 'x', by),
    ]),
  })
  const w = mem('main')
  const ok = storeFor({ 'plan.json': plan(['a']), 'events.jsonl': jsonl([spawn(T(0), 'a', 'a', 'main'), spawn(T(1), 'a', 'main', 'a'), stall(T(20), 'a', 'main', 'agent', 10), tag(T(25), 'a', 'main')]) })
  try {
    const s = crewBy(w.run(), 'a').stuck
    assert.ok(s, 'still stuck')
    assert.equal(s.kind, 'stalled')
    assert.equal(crewBy(ok.run(), 'a').stuck, null, 'sanity: the member own later line clears the same stall')
  } finally { w.store.close(); ok.store.close() }
})

test('control 2: i54 a spawn by crew member named workflow:x does not clear a stall on that member (member workflow:x)', () => {
  const mem = (by: string) => storeFor({
    'plan.json': plan(['a']),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a', 'main'), spawn(T(1), 'a', 'workflow:x', 'a'),
      stall(T(20), 'a', 'workflow:x', 'agent', 10), spawn(T(25), 'a', 'x', by),
    ]),
  })
  const w = mem('workflow:x')
  const ok = storeFor({ 'plan.json': plan(['a']), 'events.jsonl': jsonl([spawn(T(0), 'a', 'a', 'main'), spawn(T(1), 'a', 'workflow:x', 'a'), stall(T(20), 'a', 'workflow:x', 'agent', 10), tag(T(25), 'a', 'workflow:x')]) })
  try {
    const s = crewBy(w.run(), 'a').stuck
    assert.ok(s, 'still stuck')
    assert.equal(s.kind, 'stalled')
    assert.equal(crewBy(ok.run(), 'a').stuck, null, 'sanity: the member own later line clears the same stall')
  } finally { w.store.close(); ok.store.close() }
})

test('control 3: i54 in a crew slugged factory a spawn by factory does not clear its foreman stall (crew factory)', () => {
  const w = storeFor({
    'plan.json': plan(['factory']),
    'events.jsonl': jsonl([
      spawn(T(0), 'factory', 'factory', 'main'), stall(T(20), 'factory', 'factory', 'idle-foreman', 12),
      spawn(T(25), 'factory', 'factory-b', 'factory'),
    ]),
  })
  try {
    const s = crewBy(w.run(), 'factory').stuck
    assert.ok(s, 'still stuck')
    assert.equal(s.kind, 'idle-foreman')
  } finally { w.store.close() }
})

test('control 4: i54 a stall in events.1.jsonl then the stalled agent line in events.jsonl clears it (events.1.jsonl)', () => {
  const w = storeFor({
    'plan.json': plan(['a']),
    'events.1.jsonl': jsonl([spawn(T(0), 'a', 'a', 'main'), stall(T(20), 'a', 'a', 'idle-foreman', 12)]),
    'events.jsonl': jsonl([tag(T(35), 'a', 'a')]),
  })
  try {
    assert.equal(crewBy(w.run(), 'a').stuck, null)
  } finally { w.store.close() }
})
