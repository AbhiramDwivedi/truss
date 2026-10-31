// @ts-nocheck
// truss ADR-0014 Seams (section 2): `roleAudit` in bin/factory.ts, and the file shapes of the stress persona.
// Red until crew stress-persona builds agents/stress-engineer.md, the roles.json row and the exported roleAudit.
// Imports only node built-ins besides the producer: contract-stubs copies this file alone beside a stub bin/factory.ts
// and runs only the `^case:` tests.
//
// Run with: node --test tests/stress-engineer-contract.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let roleAudit: any
try {
  const mod = await import('../bin/factory.ts')
  roleAudit = mod.roleAudit
} catch {
  roleAudit = undefined
}

const audit = (role: string, agentType: string | undefined, tools: string[]): string | undefined => {
  if (typeof roleAudit !== 'function') assert.fail('producer missing: factory roleAudit')
  return roleAudit(role, agentType, tools)
}

const accepted = (role: string, agentType: string | undefined, tools: string[]): void => {
  assert.equal(audit(role, agentType, tools), undefined)
}
const flagged = (role: string, agentType: string | undefined, tools: string[]): void => {
  const why = audit(role, agentType, tools)
  assert.equal(typeof why, 'string', `expected a reason for ${role} as ${agentType} using ${tools.join(',') || 'nothing'}`)
  assert.ok((why as string).length > 0, 'the reason is empty')
}

// reads a repo file; a missing file fails with the producer-missing line, never at module load
const read = (rel: string, missing: string): string => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8').replace(/\r/g, '')
  } catch {
    assert.fail(`producer missing: ${missing}`)
  }
}
const readAgent = (name: string): string => read(`agents/${name}.md`, `agents/${name}.md`)

const frontmatter = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  assert.ok(m, 'no frontmatter')
  const out: Record<string, string> = {}
  for (const l of m[1].split('\n')) {
    const k = /^([A-Za-z-]+):\s*(.*)$/.exec(l)
    if (k) out[k[1]] = k[2].trim()
  }
  return out
}
const toolsOf = (text: string): string[] =>
  (frontmatter(text).tools ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')

test('case: stress as truss:stress-engineer is accepted', () => {
  accepted('stress', 'truss:stress-engineer', ['Read', 'Bash'])
})
test('case: stress as truss:qc-engineer is accepted', () => {
  accepted('stress', 'truss:qc-engineer', ['Read', 'Bash'])
})
test('case: stress as truss:stress-engineer using Write and Edit is accepted', () => {
  accepted('stress', 'truss:stress-engineer', ['Read', 'Write', 'Edit', 'Bash'])
})
test('case: qc as truss:qc-engineer using Read is accepted', () => {
  accepted('qc', 'truss:qc-engineer', ['Read'])
})
test('case: builder as general-purpose using Write is accepted', () => {
  accepted('builder', 'general-purpose', ['Read', 'Write'])
})
test('case: stress as general-purpose is flagged', () => {
  flagged('stress', 'general-purpose', ['Read'])
})
test('case: qc as truss:qc-engineer using Write is flagged', () => {
  flagged('qc', 'truss:qc-engineer', ['Read', 'Write'])
})
test('case: qc as truss:stress-engineer is flagged', () => {
  flagged('qc', 'truss:stress-engineer', ['Read'])
})

test('file: stress-engineer.md frontmatter tools include Write and Edit', () => {
  const tools = toolsOf(readAgent('stress-engineer'))
  assert.ok(tools.includes('Write'), `tools: ${tools.join(', ')}`)
  assert.ok(tools.includes('Edit'), `tools: ${tools.join(', ')}`)
})
test('file: workflows/roles.json maps stress to truss:stress-engineer', () => {
  const roles = JSON.parse(read('workflows/roles.json', 'workflows/roles.json'))
  assert.equal(roles.stress?.agentType, 'truss:stress-engineer')
})
test('file: qc-engineer.md tools are exactly Read, Grep, Glob, Bash', () => {
  assert.deepEqual(toolsOf(readAgent('qc-engineer')), ['Read', 'Grep', 'Glob', 'Bash'])
})
test('file: stress-engineer.md worktree check accepts worktree-wf_ branches', () => {
  const text = readAgent('stress-engineer')
  assert.ok(text.includes('worktree-wf_'), 'no worktree-wf_ in the worktree check')
  assert.ok(text.includes('worktree-agent-'), 'no worktree-agent- in the worktree check')
})
