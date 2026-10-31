// @ts-nocheck
// truss ADR-0014 / goal fixes-design Seams 4: no constant answer passes any of the three contracts.
// For each contract: mkdtemp tree, the contract copied to the same relative path, a deny-all stub producer and then an
// allow-all stub, `node --test --test-name-pattern '^case:'` run on it. Each run must exit non-zero, show at least one
// `not ok`, and show no `producer missing` line. Green from stage 0 on. Node built-ins only.
//
// Run with: node --test tests/contract-stubs.check.ts

import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REFUSE = "'[truss] Refused: delegate this edit to a crew or agent'"

const contracts = [
  {
    name: 'main-edit-gate',
    contract: 'tests/main-edit-gate-contract.check.ts',
    stub: 'hooks/register.ts',
    deny: `export function mainEditVerdict() { return { deny: ${REFUSE} } }\n`,
    allow: 'export function mainEditVerdict() { return undefined }\n',
  },
  {
    name: 'stress-engineer',
    contract: 'tests/stress-engineer-contract.check.ts',
    stub: 'bin/factory.ts',
    deny: "export function roleAudit() { return 'always a reason' }\n",
    allow: 'export function roleAudit() { return undefined }\n',
  },
  {
    name: 'background-reply',
    contract: 'ui/contract/background-reply.check.ts',
    stub: 'ui/server/session/index.ts',
    deny:
      'export function replyStep(state, msg, backgroundTasks) {\n' +
      "  return { state, open: { text: String(msg && msg.result), isError: false, backgroundTasks } }\n" +
      '}\n',
    allow: 'export function replyStep(state) { return { state, open: null } }\n',
  },
]

function runStub(c: (typeof contracts)[number], kind: 'deny' | 'allow') {
  const dir = mkdtempSync(join(tmpdir(), `contract-stubs-${c.name}-${kind}-`))
  try {
    mkdirSync(dirname(join(dir, c.contract)), { recursive: true })
    cpSync(join(ROOT, c.contract), join(dir, c.contract))
    mkdirSync(dirname(join(dir, c.stub)), { recursive: true })
    writeFileSync(join(dir, c.stub), c[kind])
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    return spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', '--test-name-pattern', '^case:', join(dir, c.contract)],
      { cwd: dir, encoding: 'utf8', timeout: 60000, env },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const c of contracts) {
  for (const kind of ['deny', 'allow'] as const) {
    test(`stub: ${c.name} ${kind}-all stub fails the contract`, () => {
      const r = runStub(c, kind)
      const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      assert.equal(r.error, undefined, `spawn failed: ${r.error}`)
      assert.notEqual(r.status, 0, `a ${kind}-all stub passed ${c.contract}`)
      assert.match(out, /^\s*not ok /m, `no "not ok" line in the ${kind}-all run:\n${out}`)
      assert.ok(!out.includes('producer missing'), `the stub was not loaded (producer missing):\n${out}`)
    })
  }
}
