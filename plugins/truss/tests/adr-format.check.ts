// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// The design engineer's ADR template and writing-skill order: agents/design-engineer.md has one "ADR format"
// section whose template lists the five sections in order, and every ADR-writing mode points at it. The
// `clarity` skill is required: the design engineer and the writer block without it, and init and run check for it.
//
// Run with: node --test tests/adr-format.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const text = readFileSync(new URL('../agents/design-engineer.md', import.meta.url), 'utf8').replace(/\r/g, '')

// The body of a `## <name>` section, up to the next `## ` heading outside a code fence.
function section(name) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `## ${name}`)
  assert.ok(start >= 0, `no "## ${name}" section`)
  const out = []
  let fenced = false
  for (const l of lines.slice(start + 1)) {
    if (/^```/.test(l)) fenced = !fenced
    if (!fenced && /^## /.test(l)) break
    out.push(l)
  }
  return out.join('\n')
}

test('ADR format: the template gives the title, Status and Decided by lines, then the five sections in order', () => {
  const body = section('ADR format')
  const fence = body.match(/```\n([\s\S]*?)\n```/)
  assert.ok(fence, 'no fenced template in the ADR format section')
  const tpl = fence[1].split('\n')
  assert.match(tpl[0], /^# ADR-NNNN: /, 'template opens with the ADR-NNNN title')
  assert.ok(tpl.some((l) => /^Status: proposed \| accepted/.test(l)), 'a Status line that starts with the status word')
  assert.ok(tpl.some((l) => /^Decided by: /.test(l)), 'a Decided by line')
  const heads = tpl.filter((l) => l.startsWith('## '))
  assert.deepEqual(heads, ['## Context', '## Decision Drivers', '## Considered Options', '## Decision', '## Consequences'])
  assert.ok(body.includes('`Decided by: default`'), 'the exact engineer-default line is named')
})

test('ADR format: init, design and the extend pass forks and exceptions all point at it', () => {
  assert.match(section('init mode'), /\*\*Decisions:\*\*[^\n]*"ADR format"/)
  assert.match(section('design mode'), /One ADR[^\n]*"ADR format"[^\n]*3,000 words/)
  const ext = section('init mode').split('### Extend pass')[1]
  assert.match(ext, /\*\*Fork:\*\*[^\n]*"ADR format"[^\n]*`Decided by: default`/)
  assert.match(ext, /\*\*Bootstrap exception:\*\*[^\n]*"ADR format"/)
})

const BLOCKED = 'BLOCKED: clarity skill not installed (npx skills add addyosmani/clarity)'

test('clarity is required: the design engineer loads it before ADR or doc prose, else blocks with the install command', () => {
  const body = section('Load the clarity skill')
  assert.match(body, /load the `clarity` skill[^\n]*Skill tool/)
  assert.ok(body.split('\n').includes(BLOCKED), 'the exact BLOCKED line stands on its own line')
  assert.doesNotMatch(body, /`technical-writer`/, 'no technical-writer fallback for ADRs and doc prose')
  assert.match(body, /No other writing skill stands in/)
})

test('clarity is required: the writer blocks on docs and ADRs, and init and run check the skill list before any agent', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r/g, '')
  assert.ok(read('../agents/writer.md').includes(BLOCKED), 'writer.md carries the BLOCKED line')
  for (const p of ['../skills/init/SKILL.md', '../skills/run/SKILL.md']) {
    const t = read(p)
    const gate = t.indexOf('npx skills add addyosmani/clarity')
    assert.ok(gate >= 0, `${p} names the install command`)
    assert.ok(gate < t.indexOf('subagent_type: "truss:design-engineer"'), `${p} checks clarity before it starts the design engineer`)
  }
})
