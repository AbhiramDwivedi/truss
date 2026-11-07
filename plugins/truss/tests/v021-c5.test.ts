import { expect } from 'claude-code/testing'

import { DECISION_LOG_REFUSAL } from '../hooks/register'
import { ROOT, world, test } from './harness'

// retro F-9 (replaces truss 0.2.1 C5): an Edit or Write of this session's decisions.md is refused, never rewritten,
// and the refusal points at `factory.ts decide`

const LOG = `${ROOT}/decisions.md`
const ran = (w: ReturnType<typeof world>, tool: string) => w.ran.filter(c => c.tool === tool).at(-1)

test('F-9: a Write of the decision log is refused with the decide command, and never runs', async ($, on) => {
  const w = world($, on)
  const r = (await $.tool.call({ tool: 'Write', file_path: LOG, content: '- HH:MM | a | b | none | followed\n' } as never)) as { deny?: string }
  expect(r.deny).toBe(DECISION_LOG_REFUSAL)
  expect(r.deny).toContain('factory.ts decide --dir')
  expect(r.deny).toContain('--line')
  expect(ran(w, 'Write')).toBeUndefined()
})

test('F-9: an Edit of the decision log is refused', async ($, on) => {
  const w = world($, on)
  const r = (await $.tool.call({ tool: 'Edit', file_path: LOG, old_string: 'a', new_string: '- 10:40 | b | c | none | followed\n' } as never)) as { deny?: string }
  expect(r.deny).toBe(DECISION_LOG_REFUSAL)
  expect(ran(w, 'Edit')).toBeUndefined()
})

test('F-9: a Windows path to the log is matched', async ($, on) => {
  world($, on)
  const r = (await $.tool.call({ tool: 'Write', file_path: 'C:\\r\\.git\\truss\\s1\\decisions.md', content: 'x\n' } as never)) as { deny?: string }
  expect(r.deny).toBe(DECISION_LOG_REFUSAL)
})

test('F-9: other files and another session\'s log go through untouched', async ($, on) => {
  const w = world($, on)
  const text = '- 10:40 | merge auth | x | none | followed\n'
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/notes/decisions.md', content: text } as never)
  expect(ran(w, 'Write')?.content).toBe(text)
  await $.tool.call({ tool: 'Write', file_path: 'C:/r/.git/truss/s2/decisions.md', content: text } as never)
  expect(ran(w, 'Write')?.content).toBe(text)
})

test('F-9: fails open: a call the check cannot read goes through as made', async ($, on) => {
  const w = world($, on)
  const text = '- 10:40 | merge auth | x | none | followed\n'
  const r = (await $.tool.call({ tool: 'Write', content: text } as never)) as { deny?: string }
  expect(r.deny).toBeUndefined()
  expect(ran(w, 'Write')?.content).toBe(text)
  expect(w.logs.some(l => l.includes('decision log failed'))).toBe(true)
})
