// @ts-nocheck
// truss 0.25.0 wave 2, A2 (contract-025 section 3, 'The paragraph'): the long-term cost paragraph is one text in five places, byte for byte:
// the LONG_TERM_COST constants of workflows/stage.js and workflows/plan.js, and the paragraph in the three agent files.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { REAL_PLUGIN } from './fixtures/workflow-run/harness.ts'

const PARAGRAPH = 'Long-term cost: when the change adds a cost the client carries after this run (a public interface or stored data shape that is costly to change, a new runtime dependency or service, a recurring money or operations cost, or a decision an ADR would record), write one line `LONG-TERM-COST: <what> | later: <the cost> | reversal: cheap|costly|irreversible`. Don\'t write one for code style, for "more code to maintain", or for a cost the approved scope already names. A LONG-TERM-COST line is never a FAIL; the merge waits for the client.'

const read = (rel: string): string => readFileSync(`${REAL_PLUGIN}/${rel}`, 'utf8')

/** The string literal a script assigns to `const LONG_TERM_COST = "..."`, unescaped (the literal is JSON-compatible: double quotes, \" escapes). */
function constantOf(rel: string): string {
  const m = read(rel).match(/^const LONG_TERM_COST = ("(?:[^"\\\n]|\\.)*")\s*$/m)
  assert.ok(m, `${rel} holds no single-line const LONG_TERM_COST = "..."`)
  return JSON.parse(m[1])
}

/** The one line of an agent file that starts the paragraph. */
function lineOf(rel: string): string {
  const lines = read(rel).split(/\r?\n/).filter((l) => l.startsWith('Long-term cost: when the change adds a cost'))
  assert.equal(lines.length, 1, `${rel} holds the paragraph exactly once`)
  return lines[0]
}

test('ltc paragraph: the five copies are byte-equal', () => {
  const copies = {
    'workflows/stage.js': constantOf('workflows/stage.js'),
    'workflows/plan.js': constantOf('workflows/plan.js'),
    'agents/design-engineer.md': lineOf('agents/design-engineer.md'),
    'agents/checking-engineer.md': lineOf('agents/checking-engineer.md'),
    'agents/qc-engineer.md': lineOf('agents/qc-engineer.md'),
  }
  for (const [file, text] of Object.entries(copies)) {
    assert.ok(Buffer.from(text).equals(Buffer.from(PARAGRAPH)), `${file} differs from the contract paragraph:\n${text}`)
  }
})
