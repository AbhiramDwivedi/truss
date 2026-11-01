// @ts-nocheck
// truss ADR-0014 Decision 2 / goal fixes-design Seams 1 (main-edit-gate-contract): `mainEditVerdict` in hooks/register.ts
// refuses a main-thread Edit or Write on repo files while a run is active, and allows everything else. Red until crew
// hook-gates exports it. Imports only node built-ins and the producer, loaded dynamically: a missing producer or export
// makes every case fail with exactly `producer missing: hooks mainEditVerdict`, never a module-load crash.
//
// Run with: node --test tests/main-edit-gate-contract.check.ts

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

const MISSING = 'producer missing: hooks mainEditVerdict'

async function load(): Promise<(call: unknown, ctx: unknown) => { deny: string } | undefined> {
  let mod: Record<string, unknown>
  try {
    mod = await import('../hooks/register.ts')
  } catch {
    throw new Error(MISSING)
  }
  if (typeof mod.mainEditVerdict !== 'function') throw new Error(MISSING)
  return mod.mainEditVerdict as (call: unknown, ctx: unknown) => { deny: string } | undefined
}

const seg = (): string => randomBytes(6).toString('hex')

// a fresh layout per case: random segments so no real path can match by accident
const base = `/tmp/gate-${seg()}`
const repoRoot = `${base}/repo-${seg()}`
const worktreeRoot = `${repoRoot}/.claude/worktrees/wt-${seg()}`
const otherWorktree = `${base}/wt-${seg()}`
const trussDir = `${repoRoot}/.git/truss/${seg()}`
const home = `${base}/home-${seg()}`

const plan = (...statuses: string[]): string =>
  JSON.stringify({ version: 1, approval: 'auto', crews: statuses.map((status, i) => ({ name: `crew-${seg()}-${i}`, status })) })

const RUNNING = plan('running')
const ctxWith = (over: Record<string, unknown> = {}) => ({
  repoRoot,
  worktreeRoots: [worktreeRoot, otherWorktree],
  trussDir,
  planText: RUNNING,
  architecture: 'docs/architecture.md',
  ...over,
})
const callOf = (tool: string, filePath: unknown, agentId?: string) => ({ tool, filePath, agentId })

function assertRefused(v: { deny: string } | undefined): void {
  assert.ok(v !== undefined, 'expected a refusal, got undefined')
  assert.equal(typeof v.deny, 'string')
  assert.ok(v.deny.startsWith('[truss] Refused:'), `deny must start with "[truss] Refused:": ${v.deny}`)
  assert.match(v.deny, /delegat/i, 'deny must tell the PM to delegate')
  assert.match(v.deny, /crew|agent/i, 'deny must name a crew or agent')
}

test('case: Write to hooks/register.ts is refused while a crew runs', async () => {
  const f = await load()
  assertRefused(f(callOf('Write', `${repoRoot}/hooks/register.ts`), ctxWith()))
})

test('case: Edit to hooks/register.ts is refused while a crew runs', async () => {
  const f = await load()
  assertRefused(f(callOf('Edit', `${repoRoot}/hooks/register.ts`), ctxWith()))
})

test('case: MultiEdit and NotebookEdit on a repo file are refused too', async () => {
  const f = await load()
  assertRefused(f(callOf('MultiEdit', `${repoRoot}/src/${seg()}.ts`), ctxWith()))
  assertRefused(f(callOf('NotebookEdit', `${repoRoot}/notebooks/${seg()}.ipynb`), ctxWith()))
})

test('case: the same path inside a worktree root is refused', async () => {
  const f = await load()
  assertRefused(f(callOf('Write', `${worktreeRoot}/hooks/register.ts`), ctxWith()))
  assertRefused(f(callOf('Edit', `${otherWorktree}/hooks/register.ts`), ctxWith()))
})

test('case: a planned crew counts as an active run', async () => {
  const f = await load()
  assertRefused(f(callOf('Write', `${repoRoot}/hooks/register.ts`), ctxWith({ planText: plan('merged', 'planned') })))
})

test('case: a plan with a running crew among merged and dropped ones is still active', async () => {
  const f = await load()
  assertRefused(f(callOf('Edit', `${repoRoot}/docs/${seg()}.md`), ctxWith({ planText: plan('merged', 'dropped', 'running') })))
})

test('case: decisions.md and plan.json in the truss dir are allowed', async () => {
  const f = await load()
  assert.equal(f(callOf('Write', `${trussDir}/decisions.md`), ctxWith()), undefined)
  assert.equal(f(callOf('Edit', `${trussDir}/plan.json`), ctxWith()), undefined)
})

test('case: the requirements path beside the architecture doc is allowed', async () => {
  const f = await load()
  assert.equal(f(callOf('Write', `${repoRoot}/docs/requirements.md`), ctxWith()), undefined)
  assert.equal(f(callOf('Edit', `${repoRoot}/docs/requirements.md`), ctxWith()), undefined)
})

test('case: the requirements path follows the architecture key, not a fixed docs/ folder', async () => {
  const f = await load()
  const arch = `design-${seg()}/arch.md`
  const ctx = ctxWith({ architecture: arch })
  assert.equal(f(callOf('Write', `${repoRoot}/${arch.split('/')[0]}/requirements.md`), ctx), undefined)
  assertRefused(f(callOf('Write', `${repoRoot}/docs/requirements.md`), ctx))
})

test('case: another file beside requirements.md is still refused', async () => {
  const f = await load()
  assertRefused(f(callOf('Write', `${repoRoot}/docs/architecture.md`), ctxWith()))
})

test('case: .claude/settings.json is allowed', async () => {
  const f = await load()
  assert.equal(f(callOf('Edit', `${repoRoot}/.claude/settings.json`), ctxWith()), undefined)
})

test('case: paths outside the repo and its worktrees are allowed', async () => {
  const f = await load()
  for (const p of [
    `${home}/.claude/projects/${seg()}/memory/MEMORY.md`,
    `${home}/.claude/settings.json`,
    `${base}/scratchpad-${seg()}/notes.txt`,
    `/tmp/other-${seg()}/hooks/register.ts`,
  ]) {
    assert.equal(f(callOf('Write', p), ctxWith()), undefined, p)
  }
})

test('case: with every crew merged or dropped there is no run and nothing is refused', async () => {
  const f = await load()
  assert.equal(f(callOf('Write', `${repoRoot}/hooks/register.ts`), ctxWith({ planText: plan('merged', 'dropped', 'merged') })), undefined)
  assert.equal(f(callOf('Edit', `${worktreeRoot}/hooks/register.ts`), ctxWith({ planText: plan('dropped') })), undefined)
})

test('case: a subagent call (agentId present) is never gated', async () => {
  const f = await load()
  assert.equal(f(callOf('Write', `${repoRoot}/hooks/register.ts`, `agent-${seg()}`), ctxWith()), undefined)
  assert.equal(f(callOf('Edit', `${worktreeRoot}/hooks/register.ts`, `agent-${seg()}`), ctxWith()), undefined)
})

test('case: fails open when planText is undefined or does not parse', async () => {
  const f = await load()
  const p = `${repoRoot}/hooks/register.ts`
  assert.equal(f(callOf('Write', p), ctxWith({ planText: undefined })), undefined)
  assert.equal(f(callOf('Write', p), ctxWith({ planText: '{ not json' })), undefined)
  assert.equal(f(callOf('Write', p), ctxWith({ planText: '' })), undefined)
  assert.equal(f(callOf('Write', p), ctxWith({ planText: '{"version":1}' })), undefined)
})

test('case: a tool other than Edit, Write, MultiEdit or NotebookEdit is allowed', async () => {
  const f = await load()
  for (const tool of ['Read', 'Bash', 'Grep', 'Glob', 'Agent']) {
    assert.equal(f(callOf(tool, `${repoRoot}/hooks/register.ts`), ctxWith()), undefined, tool)
  }
})

test('case: a filePath that is not a string does not throw and is not refused', async () => {
  const f = await load()
  for (const fp of [undefined, null, 42, {}]) {
    assert.equal(f(callOf('Write', fp), ctxWith()), undefined)
  }
})

test('case: an undefined truss dir still refuses a repo file and allows an outside one', async () => {
  const f = await load()
  assertRefused(f(callOf('Write', `${repoRoot}/hooks/register.ts`), ctxWith({ trussDir: undefined })))
  assert.equal(f(callOf('Write', `${home}/.claude/x-${seg()}.md`), ctxWith({ trussDir: undefined })), undefined)
})
