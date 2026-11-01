// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss pm-prompts crew (goal retro-fixes): the prompt rules F-9, F-35, F-38, F-39 and P-8, pinned before the prompts change.
// Each assertion matches one sentence by its meaning, so the key word showing up elsewhere does not pass it.
//
// Run with: node --test tests/pm-prompts.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { extractSnippet, parseSnippets } from '../evals/snippets.ts'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
// markdown noise (backticks, bold) dropped and whitespace collapsed, so line wraps and formatting don't matter
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/[`*]/g, '').replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
const RUN = read('skills', 'run', 'SKILL.md')
const CHECKING = read('agents', 'checking-engineer.md')
const DESIGN = read('agents', 'design-engineer.md')
const PLANNING = read('agents', 'planning-engineer.md')

// sentences, so every regex of one rule must hit the same sentence
const sentences = (text: string): string[] => text.split(/(?<=[.!?:;])\s+/)
const sentenceWith = (text: string, res: RegExp[]): string | undefined => sentences(text).find((s) => res.every((re) => re.test(s)))
const rule = (text: string, res: RegExp[], what: string) =>
  assert.ok(sentenceWith(text, res) !== undefined, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `superseded text still there: ${what}`)

describe('pm-prompts', () => {
  test('1a P-8 run skill: the PM never writes code, tests or docs itself, hotfixes included', () => {
    assert.ok(RUN !== '', 'producer missing: skills/run/SKILL.md')
    rule(RUN, [/\bPM\b/, /\bnever\b/i, /\bcode\b/, /\btests\b/, /\bdocs\b/, /hotfix/i],
      'skills/run/SKILL.md: the PM never writes code, tests or docs itself, hotfixes included')
  })

  test('1b P-8 run skill: a "factory broken" path sends even a hotfix to a crew or a started agent', () => {
    rule(RUN, [/factory (is )?broken/i, /hotfix/i, /\b(crew|agent)\b/i, /\b(delegat|send|start)/i],
      'skills/run/SKILL.md: "factory broken" path where the PM delegates even a hotfix to a crew or agent')
  })

  test('2 P-8 checking engineer: never recommends that the PM write code', () => {
    rule(CHECKING, [/\bnever\b/i, /recommend/i, /\bPM\b/, /write code/i],
      'agents/checking-engineer.md: a sentence saying it never recommends that the PM write code')
  })

  test('3 F-35 run skill: decisions.md Edits anchor on stamped lines', () => {
    rule(RUN, [/decisions\.md/, /\bEdit/, /anchor/i, /stamped/i],
      'skills/run/SKILL.md: decisions.md Edits anchor on lines already stamped')
  })

  test('3b F-35 run skill: the PM re-reads decisions.md tail before the Edit', () => {
    rule(RUN, [/re-?read/i, /\btail\b/i, /decisions\.md/, /\bEdit/],
      'skills/run/SKILL.md: re-read the decisions.md tail before the Edit')
  })

  test('4a F-38 run skill: every brief for an Agent started in a worktree carries the shell rules', () => {
    const re1 = /\b(every|each) brief\b[^.]*worktree[^.]*shell rules/i
    const re2 = /shell rules[^.]*\b(every|each) brief\b[^.]*worktree/i
    assert.ok(re1.test(RUN) || re2.test(RUN), 'missing: skills/run/SKILL.md: every brief for an Agent the PM starts in a worktree carries the SHELL rules')
  })

  test('4b F-38 run skill: the shell rules name one plain command per Bash call, Write/Edit not a heredoc, a script in a file', () => {
    has(RUN, /one plain command per Bash call/i, 'skills/run/SKILL.md: one plain command per Bash call')
    has(RUN, /Write and (change files with the )?Edit[^.]*never a shell heredoc|never a shell heredoc/i, 'skills/run/SKILL.md: Write/Edit, never a shell heredoc')
    has(RUN, /script in a file/i, 'skills/run/SKILL.md: a script in a file, not inline text')
  })

  test('5 run skill example row: the stress test names truss:stress-engineer, not qc-engineer in stress-test mode', () => {
    rule(RUN, [/\| auth \|/, /stress test truss:stress-engineer/],
      'skills/run/SKILL.md:226 example row: stress test truss:stress-engineer')
    gone(RUN, /truss:qc-engineer in stress-test mode/, 'skills/run/SKILL.md: "truss:qc-engineer in stress-test mode"')
  })

  test('6a F-39 design engineer: validates with factory.ts plan-check, no npx ajv', () => {
    rule(DESIGN, [/factory\.ts plan-check/, /validat/i, /\bnode\b/], 'agents/design-engineer.md: validate with node <plugin>/bin/factory.ts plan-check')
    gone(DESIGN, /npx -y -p ajv-cli/, 'agents/design-engineer.md: npx -y -p ajv-cli')
    gone(DESIGN, /ajv validate/, 'agents/design-engineer.md: ajv validate')
  })

  test('6b F-39 design engineer: probes and harnesses go in script files', () => {
    rule(DESIGN, [/\b(probes?|harness(es)?)\b/i, /script files?/i],
      'agents/design-engineer.md: probes and harnesses go in script files')
  })

  test('6c F-39 design engineer: no rm -rf of a variable', () => {
    rule(DESIGN, [/\b(never|no|don't|do not)\b/i, /rm -rf/, /variable/i],
      'agents/design-engineer.md: a rule forbids rm -rf of a variable')
    gone(DESIGN, /rm -rf \$/, 'agents/design-engineer.md: rm -rf $VAR')
  })

  test('6d F-39 design engineer: packs are read with the Read tool', () => {
    rule(DESIGN, [/\bpacks?\b/i, /\bRead tool\b/],
      'agents/design-engineer.md: packs are read with the Read tool')
  })

  test('7 F-9 planning engineer: each Check is one plain command, logic goes in a script file', () => {
    rule(PLANNING, [/\bChecks?\b/, /one plain command/i], 'agents/planning-engineer.md: each Check is one plain command')
    rule(PLANNING, [/\blogic\b/i, /script file/i], 'agents/planning-engineer.md: logic goes in a script file')
  })

  test('8 keep: ADR-0007 Snippets still finds the inline git diff --no-color span in skills/run/SKILL.md', () => {
    const adr = readFileSync(join(PLUGIN, 'docs', 'adr', '0007-behaviour-evals.md'), 'utf8').replace(/\r/g, '')
    const line = parseSnippets(adr).find((l) => l.file === 'skills/run/SKILL.md' && l.opening === 'git diff --no-color')
    assert.ok(line, 'ADR-0007 Snippets no longer lists skills/run/SKILL.md git diff --no-color')
    assert.equal(line.form, 'inline')
    const text = extractSnippet(join(PLUGIN, 'skills', 'run', 'SKILL.md'), line)
    assert.equal(typeof text, 'string', 'missing: skills/run/SKILL.md: the inline git diff --no-color span')
    assert.ok(text.includes('git diff --no-color'))
  })
})

function has(text: string, re: RegExp, what: string) {
  assert.match(text, re, `missing: ${what}`)
}
