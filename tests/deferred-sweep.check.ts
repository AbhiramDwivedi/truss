// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.9.2: a fresh checker sorts the end-of-run list into keep or drop before the client's report. Written before the prompts change.
//
// Run with: node --test tests/deferred-sweep.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion. Every failure says "producer missing".

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
const CHECKER = read('agents', 'checking-engineer.md')
const RUN = read('skills', 'run', 'SKILL.md')

// a section: from its heading to the next `\n## ` heading or the end ('' when the heading is missing)
const section = (doc: string, heading: string): string => {
  const i = doc.indexOf(heading)
  if (i < 0) return ''
  const rest = doc.slice(i + heading.length)
  const j = rest.search(/\n## /)
  return j < 0 ? doc.slice(i) : doc.slice(i, i + heading.length + j)
}
const has = (text: string, needle: string, label: string) =>
  assert.ok(text.includes(needle), `producer missing: ${label} does not carry ${JSON.stringify(needle)}`)

test('checking-engineer.md has an End-of-run sweep section with its trigger and rules', () => {
  const s = section(CHECKER, '## End-of-run sweep')
  for (const n of ['End-of-run sweep.', 'names a concrete failure', "When you can't tell, drop."]) {
    has(s, n, 'checking-engineer.md `## End-of-run sweep`')
  }
})

test('checking-engineer.md Report section gives the sweep format', () => {
  const s = section(CHECKER, '## Report')
  for (const n of ['SWEEP: keep | drop', '## Sweep']) has(s, n, 'checking-engineer.md `## Report`')
})

test('checking-engineer.md Items section still recommends only answer, defer, pass', () => {
  const s = section(CHECKER, '## Items')
  has(s, 'For each item, recommend `answer`', 'checking-engineer.md `## Items`')
  assert.ok(/recommend `answer`[^\n]*`defer`[^\n]*`pass`/.test(s), 'producer missing: Items does not list answer, defer, pass')
  assert.ok(!/\bdrop\b/i.test(s), 'producer missing: Items must not contain the word drop (retro counts answer/defer/pass only)')
})

test('run SKILL.md section 10 starts with the sweep and bans listing dropped items', () => {
  const s = section(RUN, '## 10. Report to the client')
  has(s, 'End-of-run sweep.', 'run SKILL.md section 10')
  const a = s.indexOf('End-of-run sweep.')
  const b = s.indexOf('Before anything leaves the machine, report:')
  assert.ok(a >= 0 && b >= 0 && a < b, 'producer missing: the sweep paragraph must come before "Before anything leaves the machine, report:"')
  has(s, 'only the number it dropped', 'run SKILL.md section 10')
  has(s, 'never name or list one, not even for information', 'run SKILL.md section 10')
  assert.ok(!s.includes('- the deferred items;'), 'producer missing: section 10 still lists "- the deferred items;"')
})
