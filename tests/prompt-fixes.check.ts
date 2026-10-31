// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss crew prompt-fixes: every check of the crew's acceptance-test probe as its own named test, plus the two
// QC-addition tightenings (checker-29 G3 and G4). Written from the spec before the prompts change.
//
// Run with: node --test tests/prompt-fixes.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p: string): string => {
  try {
    return readFileSync(join(P, p), 'utf8')
  } catch {
    return ''
  }
}
const lines = (p: string): string[] => r(p).split('\n')

const DE = r('agents/design-engineer.md')
const PE = lines('agents/planning-engineer.md')
const STALE_FILES = ['skills/run/SKILL.md', 'agents/checking-engineer.md', 'workflows/stage.js', 'docs/architecture.md']

test('control: design-engineer.md keeps plan-check', () => {
  assert.match(DE, /plan-check/)
})

test('item 4: design-engineer.md says a refused command is reported, never retried another way', () => {
  assert.match(DE, /refused command is reported,? never retried/i)
})

test('item 12: design-engineer.md has the acceptance-proof file rule', () => {
  assert.match(DE, /only files from earlier stages or (the crew.s|its) own(ed)? (owned )?files/i)
})

test('item 10: planning-engineer.md has the no report .md deliverable rule', () => {
  assert.ok(
    PE.some((l) => /report|summary|findings/i.test(l) && /\.md/.test(l) && /deliverable/i.test(l) && /hand-back/i.test(l)),
    'no line names a report/summary/findings .md, a deliverable and the hand-back',
  )
})

for (const p of ['agents/planning-engineer.md', 'workflows/stage.js']) {
  test(`item 15: ${p} says members run plain node --test, the green step runs the acceptance test`, () => {
    assert.ok(
      lines(p).some((l) => /node --test/.test(l) && /green step/i.test(l)),
      `${p} has no line with both "node --test" and "green step"`,
    )
  })
}

test('item 8: no stale qc-engineer stress-test-mode reference remains', () => {
  const bad = []
  for (const p of STALE_FILES)
    lines(p).forEach((l, i) => {
      if (/qc-engineer/.test(l) && /stress-test mode|accepts it \(f533265\)/i.test(l)) bad.push(`${p}:${i + 1}`)
    })
  assert.deepEqual(bad, [], 'still points the stress test at qc-engineer')
})

test('item 8: skills/run/SKILL.md and agents/checking-engineer.md name agents/stress-engineer.md', () => {
  const missing = ['skills/run/SKILL.md', 'agents/checking-engineer.md'].filter((p) => !r(p).includes('agents/stress-engineer.md'))
  assert.deepEqual(missing, [])
})

test('item 8: architecture start/end-state row names agents/stress-engineer.md', () => {
  assert.ok(
    lines('docs/architecture.md').some(
      (l) => l.includes('stress test') && l.includes('start and end state') && l.includes('agents/stress-engineer.md'),
    ),
  )
})

test('G3: architecture start/end-state row drops agents/qc-engineer.md', () => {
  const rows = lines('docs/architecture.md').filter((l) => l.includes('stress test') && l.includes('start and end state'))
  assert.ok(rows.length > 0, 'no start/end-state row found')
  for (const l of rows) assert.ok(!l.includes('agents/qc-engineer.md'), `row still names agents/qc-engineer.md: ${l}`)
})

test('G3: no line says the stress test runs as qc-engineer "today"', () => {
  const bad = []
  for (const p of STALE_FILES)
    lines(p).forEach((l, i) => {
      if (/qc-engineer/.test(l) && /stress/i.test(l) && /\btoday\b/i.test(l)) bad.push(`${p}:${i + 1}`)
    })
  assert.deepEqual(bad, [])
})

test('item 15 / G4: no non-comment stage.js line tells a member to run the acceptance test', () => {
  const bad = []
  lines('workflows/stage.js').forEach((l, i) => {
    if (/^\s*\/\//.test(l)) return
    if (/\brun\b[^.;]{0,30}\bacceptance[ -](test|script)/i.test(l) && !/\b(never|not|n.t)\b[^.;]{0,30}\brun\b/i.test(l))
      bad.push(`${i + 1}: ${l.trim()}`)
  })
  assert.deepEqual(bad, [])
})

test('G4 tightened: no non-comment stage.js line says run/execute with acceptance test/check/script un-negated', () => {
  const bad = []
  lines('workflows/stage.js').forEach((l, i) => {
    if (/^\s*\/\//.test(l)) return
    if (
      /\b(run|execute)\b[^.;]{0,30}\bacceptance[ -](test|check|script)/i.test(l) &&
      !/\b(never|not|n.t)\b[^.;]{0,30}\b(run|execute)\b/i.test(l)
    )
      bad.push(`${i + 1}: ${l.trim()}`)
  })
  assert.deepEqual(bad, [])
})

async function shapeLedger() {
  const { parseRequirements } = await import(P + '/brief/ledger.ts')
  const b = r('skills/brief/SKILL.md')
  const i = b.indexOf('The shape')
  const blk = i < 0 ? '' : (b.slice(i).split('```')[1] ?? '')
  return parseRequirements(blk)
}

test('control: the brief shape example has at least 2 requirements', async () => {
  assert.ok((await shapeLedger()).requirements.length >= 2)
})

test('F-36: the brief shape example parses with no errors', async () => {
  assert.deepEqual((await shapeLedger()).errors, [])
})

test('F-36: the brief shape example has a constraint', async () => {
  assert.ok((await shapeLedger()).requirements.some((q) => q.kind === 'constraint'))
})

test('F-44: checking-engineer.md names the report path pattern reports/<crew>/<name>.md', () => {
  assert.match(r('agents/checking-engineer.md'), /reports\/<crew>\/[^\s`]*\.md/)
})

test('P-3: retro skill has a general-purpose fallback for an unloaded truss:retro-judge', () => {
  assert.ok(lines('skills/retro/SKILL.md').some((l) => l.includes('truss:retro-judge') && l.includes('general-purpose')))
})
