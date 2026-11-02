// @ts-nocheck
// compose-design contract cp: how init, the run SKILL and the foreman use kit and subagent-limits (ADR-0021)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const init = read('../skills/init/SKILL.md')
const run = read('../skills/run/SKILL.md')
const foreman = read('../agents/foreman.md')

const KIT_ABSENT = 'kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)'
const OLD_MISSING = 'no kit manifest; truss init carries on without one (run /kit:init on its own to set kit up)'
const OLD_FOREMAN = 'If the `subagent-limits:split-work` skill is available'
const LOAD_SPLIT = 'Load the `subagent-limits:split-work` skill before splitting work.'
const TYPES = '--type builder=kit:builder --type tester=kit:test-writer'

test('control: the three files load and hold today\'s text', () => {
  assert.ok(init.length > 0 && run.length > 0 && foreman.length > 0)
  assert.ok(init.includes('## 5. Build on kit\'s manifest'))
  assert.ok(run.includes('plan-args'))
  assert.ok(foreman.includes('subagent-limits:split-work'))
})

test('control: init keeps the kit-absent line word for word', () => {
  assert.ok(init.includes(KIT_ABSENT))
})

test('control: init still runs kit:init with the declare args on a manifest without declarations', () => {
  assert.ok(init.includes('Skill({ skill: "kit:init", args: "declare read-only: truss:qc-engineer, truss:checking-engineer" })'))
})

test('cp 1: init runs kit:init through the Skill tool on a missing manifest, and drops the no-manifest line', () => {
  assert.ok(init.includes('Skill({ skill: "kit:init" })'), 'init never runs Skill({ skill: "kit:init" }) with no args')
  assert.ok(!init.includes(OLD_MISSING), 'init still prints the old no-manifest line')
  assert.ok(!init.includes("**Missing, and `kit:init` is among the session's skills:** don't run `kit:init`"), 'init still says not to run kit:init on a missing manifest')
})

test('cp 2: init proposes the kit roles and the subagent-limits values', () => {
  for (const w of ['build: kit:builder', 'test: kit:test-writer', 'nudgeAtK', 'stopAtK']) {
    assert.ok(init.includes(w), `init never names ${w}`)
  }
})

test('cp 3: the run SKILL passes the kit types only when kit is loaded', () => {
  assert.ok(run.includes(TYPES), `run SKILL never holds ${TYPES}`)
  assert.ok(run.includes('only when kit is loaded'), 'run SKILL never says "only when kit is loaded"')
})

test('cp 4: the foreman loads split-work unconditionally', () => {
  assert.ok(foreman.includes(LOAD_SPLIT), 'foreman never holds the unconditional load line')
  assert.ok(!foreman.includes(OLD_FOREMAN), 'foreman still loads split-work only if available')
})
