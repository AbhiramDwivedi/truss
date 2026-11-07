import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// retro F-10 and F-11: one source of truth for the shell rules. The hook's SHELL_RULES constant (hooks/register.ts) and
// the block skills/run/SKILL.md tells the PM to copy must be the same text.

const here = (p: string) => new URL(`../${p}`, import.meta.url)
const hook = readFileSync(here('hooks/register.ts'), 'utf8')
const skill = readFileSync(here('skills/run/SKILL.md'), 'utf8')

const constant = /export const SHELL_RULES =\s*"((?:[^"\\]|\\.)*)"/.exec(hook)?.[1]

test('the hook holds a SHELL_RULES constant', () => {
  assert.ok(constant !== undefined && constant.length > 200)
})

test('SKILL.md quotes the hook constant word for word', () => {
  assert.ok(constant !== undefined)
  assert.ok(skill.includes(`"${constant}"`))
})

test('the rules carry the foreground, no-poll and pid lines', () => {
  assert.ok(constant !== undefined)
  assert.match(constant, /in the foreground with an explicit Bash timeout up to 600000/)
  assert.match(constant, /never sleep-poll a background task or misuse Monitor \(pass its documented arguments only\)/)
  assert.match(constant, /Stop only a process you started, by its pid; never pkill or kill by pattern/)
})

test('SKILL.md no longer tells the PM to Edit or Write decisions.md', () => {
  assert.doesNotMatch(skill, /plugin stamps HH:MM/)
  assert.match(skill, /written only through `factory\.ts decide`/)
})
