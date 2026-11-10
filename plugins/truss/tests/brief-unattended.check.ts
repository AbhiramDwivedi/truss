// @ts-nocheck
// truss 0.25.0 wave 2, C (c-unattended): contract-025 section 7 step 3, the "## Unattended brief" section of
// skills/brief/SKILL.md. Written before the prose. Runs under plain node. Pins key words, case-insensitive, not paragraphs.
//
// Run with: node --test tests/brief-unattended.check.ts
//
// The section runs from the heading `## Unattended brief` to the next `## ` heading. It must hold:
//  1. source: the text `source: {kind: "intake"` (spaces free) and the words `goal sentence` and `own` on the line that
//     says the brief writes its own goal sentence.
//  2. large: a line with `large` and `triage`.
//  3. standard: `by: "fact"`, `by: "default"`, `client-question`, `non-blocking`, `--ref brief:<sid>:<branch>` (`--ref brief:`),
//     and `--title-file`.
//  4. closing question: a line with `closing question` and `skip`, and the text `Defaults filled:` with `E-` ids.
//  5. rule: one line naming `item id`, `own words`, `goal sentence`, `slug`, `branch` and `commit message`. No sentence may
//     tell the PM to use/take/copy the item or queue title for a goal, slug, branch or commit message unless the sentence
//     also says never/not/don't.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SKILL = new URL('../skills/brief/SKILL.md', import.meta.url)

function section(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n')
  const start = lines.findIndex((l) => /^##\s+Unattended brief\s*$/.test(l))
  assert.ok(start >= 0, 'skills/brief/SKILL.md has no "## Unattended brief" section')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s/.test(lines[i])) { end = i; break }
  return lines.slice(start + 1, end).join('\n')
}
const real = (): string => section(readFileSync(SKILL, 'utf8'))
const lineWith = (s: string, ...res: RegExp[]): string | undefined =>
  s.split('\n').find((l) => res.every((r) => r.test(l)))

/** Problems with the rule that goal sentence, slug, branch and commit message come from the item id and the PM's own words. */
export function titleRuleProblems(s: string): string[] {
  const problems: string[] = []
  const rule = lineWith(s, /item id/i, /own words/i, /goal sentence/i, /slug/i, /branch/i, /commit message/i)
  if (rule === undefined) problems.push('no line says the goal sentence, slug, branch and commit message come from the item id and the PM\'s own words')
  const sentences = s.replace(/\n/g, ' ').split(/(?<=[.;:!?])\s+/)
  for (const t of sentences) {
    const uses = /\b(use|using|take|taking|copy|copying|derive|derived|build|name|set)\b/i.test(t)
    const title = /\b(item|queue|intake|issue)\s+title\b|\btitle of the (item|queue)/i.test(t)
    const target = /\b(goal|slug|branch|commit)/i.test(t)
    const negated = /\b(never|not|don't|do not|no)\b/i.test(t)
    if (uses && title && target && !negated) problems.push(`tells the PM to use the title: ${t.trim()}`)
  }
  return problems
}

test('brief unattended: the Unattended brief section records the intake source', () => {
  const s = real()
  assert.ok(/source:\s*\{\s*kind:\s*"intake"/.test(s), 'the section does not record source: {kind: "intake", id}')
  assert.ok(/\bid\b/.test(lineWith(s, /source:\s*\{/) ?? ''), 'the source line does not name the id')
  assert.ok(lineWith(s, /goal sentence/i, /\bown\b/i), 'the section does not say the brief writes its own goal sentence')
  assert.ok(/brief\.json/.test(s), 'the section does not name brief.json')
})

test('brief unattended: a large item goes to triage', () => {
  const l = lineWith(real(), /large/i, /triage/i)
  assert.ok(l, 'no line sends a large item to triage')
  assert.ok(/\bend/i.test(l) || /\bstop/i.test(l), `the large line does not end the run: ${l}`)
})

test('brief unattended: standard branches get by default and a non-blocking client-question', () => {
  const s = real()
  assert.ok(/standard/i.test(s), 'the standard size is not named')
  assert.ok(/by:\s*"fact"/.test(s), 'by: "fact" is missing')
  assert.ok(/by:\s*"default"/.test(s), 'by: "default" is missing')
  assert.ok(/client-question/.test(s), 'client-question is missing')
  assert.ok(/non-blocking/i.test(s), 'non-blocking is missing')
  assert.ok(/--ref brief:/.test(s), '--ref brief:<sid>:<branch> is missing')
  assert.ok(/--title-file/.test(s), '--title-file is missing')
})

test('brief unattended: the closing question is skipped and Defaults filled is logged', () => {
  const s = real()
  const l = lineWith(s, /closing question/i, /skip/i)
  assert.ok(l, 'no line skips the closing question')
  assert.ok(/Defaults filled:/.test(s), '"Defaults filled:" is not logged')
  assert.ok(/E-/.test(lineWith(s, /Defaults filled:/) ?? ''), 'the Defaults filled line does not name the E-ids')
})

test("brief unattended: the goal sentence, slug, branch and commit message come from the item id and the PM's own words, never the queue title, and a planted counter-example is caught", () => {
  const s = real()
  assert.deepEqual(titleRuleProblems(s), [], 'the real section breaks the title rule')
  const planted = `${s}\nUse the item title as the goal.\n`
  const bad = titleRuleProblems(planted)
  assert.ok(bad.some((p) => p.includes('use the title')), `the planted counter-example is not caught: ${JSON.stringify(bad)}`)
  // a section without the rule at all is flagged too
  assert.ok(titleRuleProblems('Proceed as usual.').length > 0)
  // a negated sentence is not flagged
  assert.deepEqual(titleRuleProblems(`${s}\nNever use the queue title as the goal.\n`), [])
})
