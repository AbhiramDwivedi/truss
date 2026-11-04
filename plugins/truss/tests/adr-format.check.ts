// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// The design engineer's ADR template and writing-skill order: agents/design-engineer.md has one "ADR format"
// section whose template lists the five sections in order, and every ADR-writing mode points at it. The
// `clarity` skill ships with truss as `truss:clarity`: the design engineer and the writer load it, and nothing asks the user to install it.
//
// Run with: node --test tests/adr-format.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r/g, '')

test('clarity ships with truss: skill, LICENSE and UPSTREAM.md exist, the skill is named clarity, every linked file is there', () => {
  const dir = '../skills/clarity/'
  for (const f of ['SKILL.md', 'LICENSE', 'UPSTREAM.md']) assert.ok(existsSync(new URL(dir + f, import.meta.url)), `${f} exists`)
  const skill = read(dir + 'SKILL.md')
  assert.match(skill, /^---\nname: clarity\n/, 'front matter name is clarity')
  assert.match(read(dir + 'LICENSE'), /^MIT License[\s\S]*Copyright \(c\) \d{4} Addy Osmani/)
  assert.match(read(dir + 'UPSTREAM.md'), /github\.com\/addyosmani\/clarity[\s\S]*[0-9a-f]{40}/)
  for (const m of skill.matchAll(/\b((?:references|scripts)\/[\w.-]+\.(?:md|py))/g)) {
    assert.ok(existsSync(new URL(dir + m[1], import.meta.url)), `${m[1]} exists`)
  }
})

test('clarity is bundled: the design engineer and the writer load truss:clarity, nothing asks for an install', () => {
  const body = section('Load the clarity skill')
  assert.match(body, /load `truss:clarity`[^\n]*Skill tool/)
  assert.match(body, /load fails, say so in your report[^\n]*`technical-writer`/)
  assert.ok(!body.includes('BLOCKED'), 'no BLOCKED stop')
  assert.match(read('../agents/writer.md'), /load `truss:clarity`[^\n]*Skill tool/)
  for (const p of ['../agents/design-engineer.md', '../agents/writer.md', '../skills/init/SKILL.md', '../skills/run/SKILL.md', '../README.md']) {
    const t = read(p)
    assert.ok(!t.includes('npx skills add'), `${p} has no npx skills add`)
    assert.ok(!t.includes('BLOCKED: clarity'), `${p} has no BLOCKED: clarity`)
  }
  assert.match(read('../README.md'), /bundles the \[clarity\]\(https:\/\/github\.com\/addyosmani\/clarity\)[^\n]*`truss:clarity`[^\n]*MIT/)
})

