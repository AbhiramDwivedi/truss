// @ts-nocheck
// ADR-0032, the prose side of persona agents: the hiring step, the product-owner judge, the planner's persona
// rule, the QC Standards rubric and the ADR itself. These pin prose only; the mechanics (stage.js, factory.ts
// `personas` map and `persona-install`) have their own checks.
//
// Run with: node --test tests/personas-prose.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r/g, '')
const RUN = read('../skills/run/SKILL.md')
const DESIGN = read('../agents/design-engineer.md')
const PLANNER = read('../agents/planning-engineer.md')
const QC = read('../agents/qc-engineer.md')
const PROJECT_MANAGER = read('../agents/project-manager.md')
const CHECKING = read('../agents/checking-engineer.md')
const INIT = read('../skills/init/SKILL.md')

test('run skill: the hiring step exists and installs approved personas before crews start', () => {
  assert.match(RUN, /### Hire the personas the goal needs/)
  assert.match(RUN, /<truss dir>\/personas\/<name>\.md/)
  assert.match(RUN, /persona-install --from <truss dir>\/personas --repo <repo>/)
  assert.match(RUN, /before you start any crew/)
  assert.match(RUN, /the client approves them with the plan/)
  assert.match(RUN, /inlined until the next restart/)
})

test('run skill: "Truss never writes agents or skills" is gone and general-purpose is no longer the code default', () => {
  assert.ok(!/Truss never writes agents/i.test(RUN), 'the old sentence is still there')
  assert.ok(!/members run as `general-purpose` with a prompt that says what the job is/.test(RUN))
  assert.match(RUN, /`general-purpose` is only for work with no stack, such as a pure git chore/)
})

test('run skill: the inventory sorts personas from judges and the report lists stale personas as amendments', () => {
  assert.match(RUN, /\*\*personas\*\*[^\n]*\*\*judges\*\*/)
  assert.match(RUN, /stale[^\n]*amendment/)
})

test('the product-owner judge: drafted by the design engineer, consulted by the PM and the checking engineer, advice only', () => {
  assert.match(RUN, /`product-owner` judge/)
  assert.match(RUN, /read the `product-owner` file before they make or recommend a product call[^\n]*advice for the PM's own calls[^\n]*the PM rules/)
  assert.match(DESIGN, /\*\*The product-owner judge\.\*\*[^\n]*read-only `product-owner` persona/)
  assert.match(DESIGN, /who the users are[^\n]*domain rules a generic engineer would get wrong[^\n]*"done"[^\n]*pointers to the requirements doc/)
  assert.match(CHECKING, /## Product-owner judge/)
  assert.match(CHECKING, /the PM rules, with the client/)
})

test('design engineer: staffing pass, persona rules and day-0 proposals; never a generic builder persona', () => {
  assert.match(DESIGN, /\*\*Staffing pass\.\*\*/)
  assert.match(DESIGN, /Never draft a generic "builder"/)
  assert.match(DESIGN, /^## Persona rules$/m)
  assert.match(DESIGN, /kit:persona/)
  assert.match(DESIGN, /Pointers, not copies/)
  assert.match(DESIGN, /Every named path exists/)
  assert.match(DESIGN, /Persona proposals, when the project has no personas/)
})

test('planning engineer: a persona per task, split along persona areas, effort high allowed', () => {
  assert.match(PLANNER, /"persona": "<name>\|null"/)
  assert.match(PLANNER, /A task never spans two personas' areas/)
  assert.match(PLANNER, /`effort` is `low`, `medium` or `high`/)
})

test('QC engineer: a Standards block is held to, each ruling quotes the item, a violation is a FAIL; first-line format unchanged', () => {
  assert.match(QC, /\*\*Standards\.\*\*/)
  assert.match(QC, /`Standards:` block/)
  assert.match(QC, /quote the item/)
  assert.match(QC, /A violated standard is a FAIL/)
  assert.match(QC, /VERDICT: PASS/)
  assert.ok(/^tools: Read, Grep, Glob, Bash$/m.test(QC), 'the QC engineer stays read-only')
})

test('project manager and checking engineer: delegate by persona, QC brief lists Standards, drafts are reviewed', () => {
  assert.match(PROJECT_MANAGER, /Give each member task a persona/)
  assert.match(PROJECT_MANAGER, /`Standards:` block/)
  assert.match(CHECKING, /## Persona draft review/)
  assert.match(CHECKING, /Not stack-specific/)
  assert.match(CHECKING, /A named path doesn't exist/)
  assert.match(CHECKING, /Rot\./)
  assert.match(CHECKING, /Boilerplate\./)
})

test('init: day-0 personas and the product-owner judge are proposed; roles mapping is the fallback', () => {
  assert.match(INIT, /Propose day-0 personas/)
  assert.match(INIT, /product-owner/)
  assert.match(INIT, /fallback only for an area no persona covers/)
})

test('ADR-0032 exists, follows the ADR format and the plugin version is plugin.json with kit ^0.4.0', () => {
  assert.ok(existsSync(new URL('../docs/adr/0032-persona-agents.md', import.meta.url)))
  const adr = read('../docs/adr/0032-persona-agents.md')
  assert.match(adr.split('\n')[0], /^# ADR-0032: /)
  assert.ok(/^Status: accepted/m.test(adr), 'a Status line that starts with the status word')
  assert.ok(/^Decided by: /m.test(adr), 'a Decided by line')
  const heads = adr.split('\n').filter((l) => /^## /.test(l))
  assert.deepEqual(heads, ['## Context', '## Decision Drivers', '## Considered Options', '## Decision', '## Consequences'])
  const pj = JSON.parse(read('../.claude-plugin/plugin.json'))
  assert.match(pj.version, /^\d+\.\d+\.\d+$/)
  assert.equal(pj.dependencies.find((d) => d.name === 'kit').version, '^0.4.0')
  assert.match(read('../CHANGELOG.md'), /^## 0\.22\.0 /m)
})
