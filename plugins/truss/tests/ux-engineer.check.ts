// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0022 U1 and Seams: the ux-engineer prompt carries the mode openings, the verdict lines,
// the states it checks and the stop on any other first line. Written before the prompt exists.
//
// Run with: node --test tests/ux-engineer.check.ts
// Each case reads the prompt inside its own body, so a missing file fails every case on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/\r/g, '')
  } catch {
    return ''
  }
}
const prompt = (): string => read('agents', 'ux-engineer.md')
const has = (text: string, needle: string) => {
  assert.ok(text.length > 0, 'agents/ux-engineer.md is missing or empty')
  assert.ok(text.includes(needle), `agents/ux-engineer.md does not carry ${JSON.stringify(needle)}`)
}
const hasCI = (text: string, needle: string) => {
  assert.ok(text.length > 0, 'agents/ux-engineer.md is missing or empty')
  assert.ok(text.toLowerCase().includes(needle.toLowerCase()), `agents/ux-engineer.md does not mention ${JSON.stringify(needle)}`)
}
const frontmatter = (text: string): string => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''

test('ux-engineer openings 1: the prompt names the UX direction: first line', () => has(prompt(), 'UX direction:'))
test('ux-engineer openings 2: the prompt names the UX review: first line', () => has(prompt(), 'UX review:'))
test('ux-engineer openings 3: both mode openings are named in one prompt', () => {
  const t = prompt()
  has(t, 'UX direction:')
  has(t, 'UX review:')
})
test('ux-engineer openings 4: frontmatter names ux-engineer, model opus, effort medium', () => {
  const fm = frontmatter(prompt())
  assert.ok(/^name: ux-engineer\s*$/m.test(fm), 'frontmatter has no name: ux-engineer')
  assert.ok(/^model: opus\s*$/m.test(fm), 'frontmatter has no model: opus')
  assert.ok(/^effort: medium\s*$/m.test(fm), 'frontmatter has no effort: medium')
})
test('ux-engineer openings 5: the tools value, inline or list, names no write tool', () => {
  const fm = frontmatter(prompt())
  assert.ok(fm.length > 0, 'agents/ux-engineer.md has no frontmatter')
  const lines = fm.split('\n')
  const i = lines.findIndex((l) => /^tools:/.test(l))
  assert.ok(i >= 0, 'frontmatter names no tools')
  const tools = [lines[i]]
  for (let j = i + 1; j < lines.length && /^[ \t-]/.test(lines[j]); j++) tools.push(lines[j])
  const v = tools.join('\n')
  assert.ok(!/\b(Write|Edit|MultiEdit|NotebookEdit)\b/.test(v), `tools value names a write tool: ${v}`)
})

test('ux-engineer verdict 1: the prompt names the UX: PASS verdict line', () => has(prompt(), 'UX: PASS'))
test('ux-engineer verdict 2: the prompt names the UX: REWORK verdict line', () => has(prompt(), 'UX: REWORK'))
test('ux-engineer verdict 3: the prompt names the UX: DIRECTION line', () => has(prompt(), 'UX: DIRECTION'))

test('ux-engineer states 1: the prompt names the empty state', () => hasCI(prompt(), 'empty'))
test('ux-engineer states 2: the prompt names the loading state', () => hasCI(prompt(), 'loading'))
test('ux-engineer states 3: the prompt names the error state', () => hasCI(prompt(), 'error'))
test('ux-engineer states 4: the prompt names the stuck state', () => hasCI(prompt(), 'stuck'))
test('ux-engineer states 5: the prompt names long content', () => hasCI(prompt(), 'long content'))

test('ux-engineer stop 1: the prompt says any other first line stops', () => hasCI(prompt(), 'first line'))
test('ux-engineer stop 2: the prompt stops with BLOCKED:', () => has(prompt(), 'BLOCKED:'))
test('ux-engineer stop 3: first line and BLOCKED: are named together', () => {
  const t = prompt()
  hasCI(t, 'first line')
  has(t, 'BLOCKED:')
})
