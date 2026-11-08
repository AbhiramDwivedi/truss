// Stall clear (crew ui-server-fixes, item 4): a spawn line whose `by` names an agent of the same crew counts as
// a later event of that agent for crew.stuck, so an idle-foreman stall clears when the foreman spawns.
// Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; nothing listens on a port.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../../server/state/index.ts'

const tmpRoot = mkdtempSync(join(tmpdir(), 'truss-stall-clear-'))
after(() => { rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) })
let n = 0
const dir = (name: string) => { const d = join(tmpRoot, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d }

function storeFor(files: Record<string, string>) {
  const repo = dir('repo')
  const truss = dir('truss')
  for (const [name, text] of Object.entries(files)) writeFileSync(join(truss, name), text)
  const store = createStore({ repo, trussDir: truss, pollMs: 40 })
  return { store, run: () => (store.snapshot().state as any).run as any }
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
  model: 'opus', effort: 'high', by: by,
})
const stall = (ts: string, crew: string, agent: string, kind: string, minutes: number) => ({ v: 1, ts, event: 'stall', crew, agent, kind, minutes })

// The foreman a is spawned by main, goes idle, and the stall is logged at T(20). `rest` follows.
function idleForeman(rest: unknown[], extraCrews: string[] = []) {
  return storeFor({
    'plan.json': plan(['a', ...extraCrews]),
    'events.jsonl': jsonl([spawn(T(0), 'a', 'a', 'main'), stall(T(20), 'a', 'a', 'idle-foreman', 12), ...rest]),
  })
}

test('an idle-foreman stall is stuck with no later event', () => {
  const w = idleForeman([])
  try {
    const s = crewBy(w.run(), 'a').stuck
    assert.ok(s, 'stuck is set')
    assert.equal(s.kind, 'idle-foreman')
  } finally { w.store.close() }
})

test('an idle-foreman stall, then a later spawn by the foreman, clears stuck', () => {
  const w = idleForeman([{ ...spawn(T(25), 'a', 'a-builder', 'a'), by: 'a' }])
  try {
    assert.equal(crewBy(w.run(), 'a').stuck, null)
  } finally { w.store.close() }
})

test('a later spawn by main leaves the idle-foreman stall stuck', () => {
  const w = idleForeman([spawn(T(25), 'a', 'a-builder', 'main')])
  try {
    const s = crewBy(w.run(), 'a').stuck
    assert.ok(s, 'still stuck')
    assert.equal(s.kind, 'idle-foreman')
  } finally { w.store.close() }
})

test('a later spawn by factory leaves the stall stuck', () => {
  const w = idleForeman([spawn(T(25), 'a', 'a-builder', 'factory')])
  try {
    assert.ok(crewBy(w.run(), 'a').stuck, 'still stuck')
  } finally { w.store.close() }
})

test('a later spawn by a workflow leaves the stall stuck', () => {
  const w = idleForeman([spawn(T(25), 'a', 'a-builder', 'workflow:wf_1234abcd')])
  try {
    assert.ok(crewBy(w.run(), 'a').stuck, 'still stuck')
  } finally { w.store.close() }
})

test('an earlier-ts spawn by the foreman does not clear the stall', () => {
  const w = idleForeman([spawn(T(10), 'a', 'a-builder', 'a')])
  try {
    const s = crewBy(w.run(), 'a').stuck
    assert.ok(s, 'still stuck')
    assert.equal(s.kind, 'idle-foreman')
  } finally { w.store.close() }
})

test('a later spawn by an agent of a different crew leaves the stall stuck', () => {
  const w = storeFor({
    'plan.json': plan(['a', 'b']),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a', 'main'), spawn(T(0), 'b', 'b', 'main'),
      stall(T(20), 'a', 'a', 'idle-foreman', 12),
      spawn(T(25), 'a', 'a-builder', 'b'),
    ]),
  })
  try {
    assert.ok(crewBy(w.run(), 'a').stuck, 'a is still stuck')
  } finally { w.store.close() }
})

test('a stalled member clears when a later spawn names it as by', () => {
  const w = storeFor({
    'plan.json': plan(['a']),
    'events.jsonl': jsonl([
      spawn(T(0), 'a', 'a', 'main'), spawn(T(1), 'a', 'a-one', 'a'),
      stall(T(20), 'a', 'a-one', 'agent', 10),
      spawn(T(25), 'a', 'a-two', 'a-one'),
    ]),
  })
  try {
    assert.equal(crewBy(w.run(), 'a').stuck, null)
  } finally { w.store.close() }
})

// gap g's "a later event from a different agent does not clear the stall" is ui/test/state/gaps.test.ts's.
test('gap g still holds: the stalled agent speaking again clears stuck', () => {
  const w = idleForeman([{ v: 1, ts: T(35), event: 'tag', crew: 'a', agent: 'a', tag: 'DONE' }])
  try {
    assert.equal(crewBy(w.run(), 'a').stuck, null)
  } finally { w.store.close() }
})
