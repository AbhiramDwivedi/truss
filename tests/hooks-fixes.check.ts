// @ts-nocheck
// truss plugin-fixes (ADR-0016 Decision 2), hooks-fixes crew: the item-2 text pins, the wiring of designerResumeVerdict
// (item 1), and behaviour controls for messages it must let through. The verdict rule itself is pinned by
// tests/plugin-fixes-hooks-contract.check.ts. register.ts is loaded dynamically inside each test, so a missing export
// fails one case, not the load.
//
// Run with: node --test tests/hooks-fixes.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { codeOnly } from './hooks-load.check.ts'

const ROOT = new URL('..', import.meta.url).pathname
const REGISTER = new URL('../hooks/register.ts', import.meta.url)

async function exportOf(name: string): Promise<any> {
  let mod: Record<string, unknown>
  try {
    mod = await import('../hooks/register.ts')
  } catch (err) {
    assert.fail(`producer missing: hooks ${name} (register.ts did not load: ${(err as Error).message})`)
  }
  assert.ok(name in mod, `producer missing: hooks ${name} is not exported`)
  return mod[name]
}

test('item 2: MAIN_MODEL_REFUSAL names no model, and the four pins carry its text', async () => {
  const text = String(await exportOf('MAIN_MODEL_REFUSAL'))
  assert.ok(!/opus|sonnet/i.test(text), `MAIN_MODEL_REFUSAL names a model: ${text}`)
  assert.ok(text.startsWith('[truss] Refused:'), `MAIN_MODEL_REFUSAL does not start "[truss] Refused:": ${text}`)
  assert.ok(/model/.test(text), 'MAIN_MODEL_REFUSAL does not mention model')
  const pin = '${MARK}' + text.slice(7).replaceAll('`', '\\`')
  const pins: [string, RegExp][] = [
    ['tests/contract-gates.test.ts', /constant\(.MAIN_MODEL_REFUSAL.\)\)\.toBe\(/],
    ['tests/contract-gates.test.ts', /^\s*const model = \{ deny: /],
    ['tests/contract-gates.test.ts', /^const mainModelRefusal = /],
    ['docs/adr/0004-scope-repair-and-head-gates.md', /^export const MAIN_MODEL_REFUSAL = /],
  ]
  const failures: string[] = []
  for (const [path, re] of pins) {
    const lines = readFileSync(ROOT + path, 'utf8').split('\n')
    const i = lines.findIndex(l => re.test(l))
    if (i < 0) failures.push(`${path} lost its MAIN_MODEL_REFUSAL pin ${re}`)
    else if (!(lines[i] + (lines[i + 1] ?? '')).includes(pin)) failures.push(`${path}:${i + 1} does not pin the new MAIN_MODEL_REFUSAL text`)
  }
  assert.deepEqual(failures, [])
})

test('item 2: no main-session model refusal in a pin file lists a model', () => {
  for (const path of ['tests/contract-gates.test.ts', 'docs/adr/0004-scope-repair-and-head-gates.md']) {
    const bad = readFileSync(ROOT + path, 'utf8')
      .split('\n')
      .filter(l => /main session sets/.test(l) && /model/.test(l) && /opus|sonnet/i.test(l))
    assert.deepEqual(bad, [], `${path} still carries a model list in the main-session model refusal`)
  }
})

test('item 1: designerResumeVerdict is wired into the SendMessage main-session branch before next(e), through refuse()', () => {
  const raw = readFileSync(REGISTER, 'utf8')
  const src = codeOnly(raw) // same length as raw, strings blanked: find the handler in raw, read its code from src
  const start = raw.search(/on\(\s*['"]tool\.call['"]\s*,\s*\{\s*tool:\s*['"]SendMessage['"]/)
  assert.ok(start >= 0, 'no SendMessage tool.call handler found')
  const rest = src.slice(start + 1)
  const nextOn = rest.search(/\n  on\(/)
  const handler = nextOn < 0 ? rest : rest.slice(0, nextOn)
  const branchAt = handler.search(/e\.agentId\s*===\s*undefined/)
  assert.ok(branchAt >= 0, 'no main-session branch (e.agentId === undefined) in the SendMessage handler')
  const branch = handler.slice(branchAt)
  const nextAt = branch.search(/await\s+next\(\s*e\s*\)/)
  assert.ok(nextAt >= 0, 'no await next(e) in the main-session branch')
  const before = branch.slice(0, nextAt)
  const call = before.search(/designerResumeVerdict\s*\([^)]*input\.to/)
  assert.ok(call >= 0, 'no designerResumeVerdict(... input.to ...) call before the first await next(e) in the main-session branch')
  assert.match(before.slice(call), /refuse\(\s*\$\s*,\s*state\s*,\s*refusalsLogged\s*,\s*e\s*,/, 'its deny is not returned through refuse($, state, refusalsLogged, e, ...)')
})

const AGENTS = [
  { id: 'f1', name: 'foreman-y', type: 'truss:foreman', status: 'running' },
  { id: 'q1', name: 'qc-engineer-z', type: 'truss:qc-engineer', status: 'running' },
  { id: 'd1', name: 'designer-amend-x', type: 'truss:design-engineer', status: 'completed' },
]

test('control: designerResumeVerdict lets a message to a live foreman, a QC engineer, or an unlisted designer-named agent through', async () => {
  const d = await exportOf('designerResumeVerdict')
  assert.equal(typeof d, 'function', 'designerResumeVerdict is not a function')
  const none = new Map()
  const listed = new Map([['other-id', 'plan']])
  assert.equal(d('foreman-y', AGENTS, listed), undefined, 'live foreman')
  assert.equal(d('f1', AGENTS, listed), undefined, 'live foreman by id')
  assert.equal(d('qc-engineer-z', AGENTS, listed), undefined, 'qc engineer')
  assert.equal(d('q1', AGENTS, listed), undefined, 'qc engineer by id')
  assert.equal(d('designer-amend-x', AGENTS, none), undefined, 'designer-named agent absent from planDesigners')
  assert.equal(d('designer-amend-x', AGENTS, listed), undefined, 'designer-named agent absent from a non-empty planDesigners')
})

test('control: designerResumeVerdict gives undefined for a non-string to', async () => {
  const d = await exportOf('designerResumeVerdict')
  assert.equal(typeof d, 'function', 'designerResumeVerdict is not a function')
  const designers = new Map([['d1', 'amend']])
  for (const to of [undefined, 42, { name: 'designer-amend-x' }, null, ['d1']]) {
    assert.equal(d(to, AGENTS, designers), undefined, `to = ${JSON.stringify(to)}`)
  }
})
