import { expect } from 'claude-code/testing'

import { SHELL_RULES, worktreeBriefVerdict } from '../hooks/register'
import { world, test } from './harness'

// retro F-10 and F-11: the shell rules, and the refusal of a worktree Agent call whose brief lacks them

test('F-11: the rules name the foreground, no-poll and pid lines', () => {
  expect(SHELL_RULES).toContain('in the foreground with an explicit Bash timeout up to 600000')
  expect(SHELL_RULES).toContain('never sleep-poll a background task or misuse Monitor')
  expect(SHELL_RULES).toContain('by its pid; never pkill or kill by pattern')
})

test('F-10: a worktree Agent call without the rules is refused, quoting the block', async ($, on) => {
  const w = world($, on)
  const r = (await w.agentCall(undefined, { isolation: 'worktree', prompt: 'build the thing' })) as { deny?: string }
  expect(r.deny).toContain(SHELL_RULES)
  expect(w.ran.some(c => c.tool === 'Agent')).toBe(false)
})

test('F-10: a worktree Agent call with the rules goes through unchanged', async ($, on) => {
  const w = world($, on)
  const prompt = `build the thing\n\n${SHELL_RULES}`
  const r = (await w.agentCall(undefined, { isolation: 'worktree', prompt })) as { deny?: string }
  expect(r.deny).toBeUndefined()
  expect(w.ran.filter(c => c.tool === 'Agent').at(-1)?.prompt).toBe(prompt)
})

test('F-10: a call without a worktree is left alone', async ($, on) => {
  const w = world($, on)
  const r = (await w.agentCall(undefined, { prompt: 'search' })) as { deny?: string }
  expect(r.deny).toBeUndefined()
  expect(worktreeBriefVerdict({ isolation: 'none', prompt: 'x' })).toBeUndefined()
})
