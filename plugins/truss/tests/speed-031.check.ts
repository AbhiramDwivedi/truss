// @ts-nocheck
// truss 0.31.0, speed goal items 1 and 2, the config, prompts and plan side: the targetedTests key is declared and proposed by
// init, acceptance tests never end in a blanket suite (design-engineer rule, plan-check warning), QC reads green's record instead
// of re-running a green suite, and this repo's heavySlots goes back to the host default. Node built-ins only.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { crew, mkTrussDir, planObj, runCli, writePlan, REAL_FACTORY } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(PLUGIN, '..', '..')
const read = (...p) => readFileSync(join(PLUGIN, ...p), 'utf8')
const json = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('the config schema declares targetedTests and nothing loose under it', () => {
  const t = json(join(PLUGIN, 'docs', 'truss-config.schema.json')).properties.targetedTests
  assert.ok(t, 'targetedTests is declared')
  assert.equal(t.additionalProperties, false)
  assert.deepEqual(Object.keys(t.properties).sort(), ['full', 'fullOn', 'map', 'maxFiles', 'runner'])
  const item = t.properties.map.items
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.required, ['paths'])
  assert.deepEqual(Object.keys(item.properties).sort(), ['paths', 'run', 'tests'])
})

test('this repo uses the host default heavy slots and a valid targetedTests', () => {
  const cfg = json(join(REPO, '.claude', 'truss.json'))
  assert.equal(cfg.heavySlots, undefined, 'heavySlots goes back to the host default')
  const t = cfg.targetedTests
  assert.ok(t && Array.isArray(t.map) && t.map.length > 0, 'the map names the checks the import graph cannot see')
  for (const e of t.map) {
    assert.ok(Array.isArray(e.paths) && e.paths.length > 0)
    for (const k of Object.keys(e)) assert.ok(['paths', 'tests', 'run'].includes(k), k)
    for (const f of e.tests ?? []) assert.ok(readFileSync(join(REPO, f)), `${f} exists`)
  }
})

test('init proposes targetedTests from the project layout', () => {
  const s = read('skills', 'init', 'SKILL.md')
  assert.match(s, /`targetedTests`/)
  assert.match(s, /runner/)
  assert.match(s, /map/)
})

test('the design engineer never ends an acceptance test with a blanket suite', () => {
  const s = read('agents', 'design-engineer.md')
  assert.match(s, /never end(s)? (it )?with a (blanket|whole-suite)/i)
  assert.match(s, /npm test/)
})

test('QC reads the green record instead of re-running a green suite', () => {
  const s = read('agents', 'qc-engineer.md')
  assert.match(s, /Green result/)
  assert.match(s, /do not re-run/i)
})

test('plan-check warns about an acceptance test that ends in a blanket suite', () => {
  const dir = mkTrussDir()
  writePlan(dir, planObj([crew('x', { acceptanceTest: 'node --test tests/x.check.ts && npm test' }), crew('y', { acceptanceTest: 'node --test tests/y.check.ts' })]))
  const r = runCli(REAL_FACTORY, 'plan-check', ['--dir', dir], process.cwd())
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const w = JSON.parse(r.stdout).warnings ?? []
  assert.ok(w.some((x) => /crew x: .*whole test suite/.test(x)), w.join('\n'))
  assert.ok(!w.some((x) => /crew y/.test(x)), w.join('\n'))
})
