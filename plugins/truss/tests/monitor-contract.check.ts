// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 5 and Seams to pin, section 5: the contract between monitor-wiring (agents/resource-monitor.md,
// skills/run/SKILL.md) and the PM. Written from the spec before any producer exists.
//
// Run with: node --test tests/monitor-contract.check.ts
// Each producer is read from $TRUSS_CONTRACT_ROOT/<repo path>; with the variable unset the root is the repo root.
// With no producer it prints `producer missing: <label>` and the cases that need it fail.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO).replace(/\\/g, '/')
const AGENT_PATH = `${ROOT}/agents/resource-monitor.md`
const SKILL_PATH = `${ROOT}/skills/run/SKILL.md`
const AGENT_MISSING = 'producer missing: agents/resource-monitor.md'
const SKILL_MISSING = 'producer missing: skills/run resources'
const mt = (name, fn) => test(name, { timeout: 20000 }, fn)

const agentText = existsSync(AGENT_PATH) ? readFileSync(AGENT_PATH, 'utf8') : null
const skillText = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, 'utf8') : ''
const agentMissing = agentText === null
// the PM step is missing until the run skill names the monitor
const skillMissing = !skillText.includes('truss:resource-monitor')
if (agentMissing) console.log(AGENT_MISSING)
if (skillMissing) console.log(SKILL_MISSING)

// the lines between the first two `---` fences
function frontmatter(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  if (lines[0].trim() !== '---') return []
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end < 0 ? [] : lines.slice(1, end)
}

const TOOLS_LINE = /^tools: *[A-Z][A-Za-z]*(, *[A-Z][A-Za-z]*)*$/
const FORBIDDEN = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']

mt('case: tools line', () => {
  if (agentMissing) assert.fail(AGENT_MISSING)
  const fm = frontmatter(agentText)
  assert.ok(fm.length > 0, 'agents/resource-monitor.md has no frontmatter between --- fences')
  const lines = fm.filter((l) => /^tools\s*:/.test(l))
  assert.equal(lines.length, 1, `the frontmatter needs exactly one tools line, found ${lines.length}`)
  assert.match(lines[0], TOOLS_LINE, `the tools line must be one line of capitalised names, such as "tools: Bash, Read": ${JSON.stringify(lines[0])}`)
  const names = lines[0].replace(/^tools:\s*/, '').split(',').map((s) => s.trim())
  for (const bad of FORBIDDEN) assert.ok(!names.includes(bad), `the monitor must not have ${bad}: ${lines[0]}`)
  assert.ok(names.length > 0 && names.every(Boolean), 'the tools list is never empty')
})

mt('the monitor agent has model: haiku', () => {
  if (agentMissing) assert.fail(AGENT_MISSING)
  const fm = frontmatter(agentText)
  assert.ok(fm.some((l) => /^model: *haiku\s*$/.test(l)), `the frontmatter needs "model: haiku":\n${fm.join('\n')}`)
})

mt('the run skill names the monitor, the parallelism file and held', () => {
  if (skillMissing) assert.fail(SKILL_MISSING)
  for (const word of ['truss:resource-monitor', 'parallelism', 'held']) {
    assert.ok(skillText.includes(word), `skills/run/SKILL.md does not name ${word}`)
  }
})
