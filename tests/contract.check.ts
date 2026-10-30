// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.4.0 contract, truss ADR-0002 "Seams": the init, run and designer prompts and the
// truss.json schema, read as text. Written by the design crew before stage 1 changes the prompts.
//
// Run with: node --test tests/contract.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` gives tests no fs. Every read goes through
// `read`, which returns '' for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return ''
  }
}
const init = () => read('skills', 'init', 'SKILL.md')
const run = () => read('skills', 'run', 'SKILL.md')
const designer = () => read('agents', 'design-engineer.md')
const schemaText = () => read('docs', 'truss-config.schema.json')

const has = (text: string, phrase: string, where: string) => assert.ok(text.includes(phrase), `${where} does not name: ${phrase}`)
const lacks = (text: string, phrase: string, where: string) => assert.ok(!text.includes(phrase), `${where} still holds: ${phrase}`)

// ---------- 1. init builds on kit's manifest ----------

test('init names the kit manifest path', () => has(init(), '.claude/kit/manifest.json', 'skills/init/SKILL.md'))

test('init runs kit:init with the declare args', () => {
  has(init(), 'kit:init', 'skills/init/SKILL.md')
  has(init(), 'declare read-only: truss:qc-engineer, truss:checking-engineer', 'skills/init/SKILL.md')
})

test('init says what it does when kit is not installed', () =>
  has(init(), 'kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)', 'skills/init/SKILL.md'))

// ---------- 2. init writes only declared truss.json keys ----------

test('init names the config schema', () => has(init(), 'truss-config.schema.json', 'skills/init/SKILL.md'))

test('init names each new key the schema declares', () => {
  const props = Object.keys(JSON.parse(schemaText() || '{}').properties ?? {})
  for (const key of ['roles', 'deploy', 'writingSkill', 'promptOverrides']) {
    assert.ok(props.includes(key), `truss-config.schema.json does not declare ${key}`)
    has(init(), key, 'skills/init/SKILL.md')
  }
})

// ---------- 3. run skill: ports from worktrees, prompt overrides, roles ----------

test('run names PORT_BASE, Prompt overrides: and roles', () => {
  has(run(), 'PORT_BASE', 'skills/run/SKILL.md')
  has(run(), 'Prompt overrides:', 'skills/run/SKILL.md')
  has(run(), 'roles', 'skills/run/SKILL.md')
})

test('run no longer holds the invented port range 4100-4109', () => {
  assert.ok(run() !== '', 'skills/run/SKILL.md not found')
  lacks(run(), '4100-4109', 'skills/run/SKILL.md')
})

// ---------- 4. designer: diagrams and ports ----------

test('designer asks for mermaid diagrams', () => has(designer(), 'mermaid', 'agents/design-engineer.md'))

test('designer holds the no-setup-script ports line', () =>
  has(designer(), 'ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)', 'agents/design-engineer.md'))

test('designer no longer holds "port range"', () => {
  assert.ok(designer() !== '', 'agents/design-engineer.md not found')
  lacks(designer(), 'port range', 'agents/design-engineer.md')
})

// ---------- 5. the config schema ----------

test('the config schema parses as JSON and is closed', () => {
  const schema = JSON.parse(schemaText())
  assert.equal(schema.additionalProperties, false)
})

test('each promptOverrides value pattern takes a file directly under .claude/truss/prompts/', () => {
  const schema = JSON.parse(schemaText())
  const roles = schema.properties?.promptOverrides?.properties ?? {}
  assert.deepEqual(Object.keys(roles).sort(), ['checking-engineer', 'commissioning-engineer', 'design-engineer', 'foreman', 'qc-engineer', 'writer'])
  for (const [role, def] of Object.entries(roles)) {
    let node = def
    if (node.$ref) node = node.$ref.replace(/^#\//, '').split('/').reduce((o, k) => o?.[k], schema)
    assert.equal(typeof node?.pattern, 'string', `promptOverrides.${role} has no pattern`)
    const re = new RegExp(node.pattern)
    assert.ok(re.test('.claude/truss/prompts/qc-engineer.md'), `${role}: rejects .claude/truss/prompts/qc-engineer.md`)
    assert.ok(!re.test('../qc-engineer.md'), `${role}: accepts ../qc-engineer.md`)
    assert.ok(!re.test('.claude/truss/prompts/a/b.md'), `${role}: accepts .claude/truss/prompts/a/b.md`)
  }
})

// ---------- 5. run skill: decisions.md grammar (ADR-0003) ----------

// docs/adr/0003-event-log-and-retro.md:59: "Each `## Run <start> | <goal>` heading starts a run."
test('run names the "## Run <start> | <goal>" heading form', () =>
  has(run(), '## Run <start> | <goal>', 'skills/run/SKILL.md'))

// docs/adr/0003-event-log-and-retro.md:37: "- HH:MM | checker-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>"
test('run names the "checker-<n> RECOMMEND" decision line form', () =>
  has(run(), 'checker-<n> RECOMMEND', 'skills/run/SKILL.md'))
