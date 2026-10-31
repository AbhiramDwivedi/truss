// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss stability-fixes goal, items 1 and 3: key phrase present AND superseded sentence gone.
//
// Run with: node --test tests/stability-fixes.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` runs tests with no fs. Every read returns ''
// for a missing path, so each test fails on its own assertion.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (...parts: string[]): string => {
  try {
    return readFileSync(join(PLUGIN, ...parts), 'utf8').replace(/[`*]/g, '').replace(/\s+/g, ' ')
  } catch {
    return ''
  }
}
const FOREMAN = read('agents', 'foreman.md')
const CHECKER = read('agents', 'checking-engineer.md')
const STAGE = read('workflows', 'stage.js')

const has = (text: string, re: RegExp, what: string) => assert.match(text, re, `missing: ${what}`)
const gone = (text: string, re: RegExp, what: string) => assert.doesNotMatch(text, re, `still present: ${what}`)

describe('item 1: no-polling rule in every member brief', () => {
  const RULE = /runs? each long command once with run_in_background and waits? for its completion notification/i
  test('foreman.md member-brief list carries the rule', () => {
    has(FOREMAN, RULE, 'no-polling rule')
    has(FOREMAN, /no polling loops, no sleep, no relaunching waiters/i, 'no polling loops, no sleep')
    has(FOREMAN, /never a shared temp path/i, 'no shared temp path')
  })
  test('stage.js memberPrompt runs commands in the foreground with a Bash timeout', () => {
    has(STAGE, /Run every command in the foreground, with an explicit Bash timeout up to 600000; no run_in_background, no Monitor/, 'foreground rule (F-1) in stage.js')
    gone(STAGE, RULE, 'old run_in_background sentence in stage.js')
    has(STAGE, /no polling loops, no sleep, no relaunching waiters/i, 'no polling loops in stage.js')
    has(STAGE, /never a shared temp path/i, 'no shared temp path in stage.js')
  })
})

describe('item 3: checking-engineer.md agrees with the planning rule in run/SKILL.md', () => {
  test('the one-round reconcile and fresh-checker sentence is gone', () => {
    gone(CHECKER, /gives the design engineer one round to reconcile, then may start a fresh checking engineer/, 'superseded reconcile sentence')
    gone(CHECKER, /still disagree after that round/, 'superseded first client trigger')
    gone(CHECKER, /your brief says when the round has happened/, 'superseded round remark')
  })
  test('a disagreement does not send the plan back; the client trigger is an unsettled disagreement', () => {
    has(CHECKER, /does not send the plan back/i, 'a disagree does not send the plan back')
    has(CHECKER, /design engineer's reason doesn't settle it/, 'client trigger: designer reason does not settle it')
  })
})
