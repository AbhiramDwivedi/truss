// @ts-nocheck
// 0.32.0 hotfix: a batched gates call that passes green and stops on owns. factory gates prints green's head at the top level
// only; the green sub-result must still carry it, so green() passes and the owns stop reaches scope() as its QUESTION, never as
// "the green check gave no head". Single-step test (ADR-0050): gates.js, check.js, green.js and scope.js each load alone through
// loadStageStep, wired to one another and to stubs. Node built-ins only.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

const SRC = path.join(import.meta.dirname, '../workflows-src/stage')

class Stop {
  constructor(tag, text, at) {
    this.tag = tag
    this.text = text
    this.at = at
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const sh = (v) => String(v)

// the stdout factory gates printed in the live run (exit 1): green passed, owns stopped
const LIVE = {
  ok: false,
  stopped: 'owns',
  gates: { green: true, owns: false },
  codes: { green: 0, owns: 1 },
  head: 'ca23278aaaabbbbccccddddeeeeffff000011112',
  steps: { green: { ok: true, exit: 0, tests: 'targeted' }, owns: { ok: false, outside: ['.claude/rules/plugin-tests.md'] } },
}

async function world() {
  const { loadStageStep } = await import('../bin/build-stage.ts')
  const runs = []
  const runFactory = async (crew, command, key, line) => {
    runs.push(line || command)
    if (command === 'gates') return { met: false, parsed: LIVE, exit: 1, out: `exit 1\n${JSON.stringify(LIVE)}` }
    throw new Error(`unscripted runner command: ${command}`)
  }
  const base = { args: {}, agent: async () => assert.fail('no agent call expected'), log: () => {}, Stop, isPlainObject, sh, runFactory, F: { plugin: '/p', repo: '/r', dir: '/d', reworkAllowance: 3 }, unmoved: () => false, passedAt: () => {} }
  const gates = (await loadStageStep(path.join(SRC, 'gates.js'), { ...base, trussDir: () => '/d', testsCheckExtra: () => null, hasCodeTasks: () => true, knowledgeFilesExist: () => false, spendOf: () => 0, peekLabel: () => null, titleOf: () => null, STATUS_PREFIX: 'truss-status: ' })).scope
  const check = (await loadStageStep(path.join(SRC, 'check.js'), { ...base, takeGate: gates.takeGate, heavyLine: gates.heavyLine })).scope
  const green = (await loadStageStep(path.join(SRC, 'green.js'), { ...base, check: check.check, sourceChangesOf: () => [], envOf: gates.envOf, knownOf: gates.knownOf, clip: (s) => s })).scope
  const scope = (await loadStageStep(path.join(SRC, 'scope.js'), { ...base, takeGate: gates.takeGate })).scope
  return { gates, green, scope, runs }
}

test('gates owns stop: green passes with the top-level head and the owns stop becomes the scope QUESTION', async () => {
  const w = await world()
  const crew = { slug: 's', e: { worktree: '/wt', answers: [] }, head: null, moves: 0, proofs: [] }
  await w.gates.gates(crew, { green: true, owns: true })
  await w.green.green(crew)
  assert.equal(crew.head, LIVE.head, 'a met green check carries the top-level head')
  await assert.rejects(w.scope.scope(crew), (err) => {
    assert.ok(err instanceof Stop, String(err))
    assert.equal(err.tag, 'QUESTION', err.text)
    assert.equal(err.text, 'Files changed outside the crew owns: .claude/rules/plugin-tests.md. Extend owns?')
    assert.equal(err.at, 'scope')
    return true
  })
  assert.equal(w.runs.length, 1, 'green and owns both came from the one gates call')
})

test('gates owns stop: a green sub-result that carries its own head keeps it', async () => {
  const w = await world()
  const own = 'feedfacefeedfacefeedfacefeedfacefeedface'
  LIVE.steps.green.head = own
  try {
    const crew = { slug: 's', e: { worktree: '/wt', answers: [] }, head: null, moves: 0, proofs: [] }
    await w.gates.gates(crew, { green: true, owns: true })
    await w.green.green(crew)
    assert.equal(crew.head, own)
  } finally {
    delete LIVE.steps.green.head
  }
})
