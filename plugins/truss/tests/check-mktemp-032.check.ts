import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { bashRun, envFailure, envVerdict, MKTEMP_PREFIX } from '../bin/factory/check.ts'

const tmp = (): string => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'truss-mktemp-')))
const EPERM = 'mktemp: mkstemp failed on /var/folders/hc/abc/T/tmp.gAmUx7uIj9: Operation not permitted'

test('check runs an acceptance script whose bare mktemp writes under TMPDIR', () => {
  const dir = tmp()
  const saved = process.env.TMPDIR
  process.env.TMPDIR = dir
  try {
    assert.ok(MKTEMP_PREFIX.includes('mktemp'))
    const r = bashRun(dir, 'd=$(dirname "$(mktemp)"); echo "$d"')
    assert.equal(r.exit, 0)
    assert.equal(realpathSync(r.text.trim()), dir)
  } finally {
    if (saved === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = saved
  }
})

test('envFailure classes a sandbox mktemp EPERM line as an environment failure', () => {
  assert.equal(envFailure(EPERM), EPERM)
  const d = 'mkdtemp: mkdtemp failed on /var/folders/hc/abc/T/tmp.XXXX: Operation not permitted'
  assert.equal(envFailure(d), d)
})

test('a red check that fails only on a mktemp EPERM is not a valid red record', () => {
  const v = envVerdict(`${EPERM}\nFAIL: mktemp failed\n`)
  assert.notEqual(v.env, undefined)
})

test('mktemp with a template still uses that template', () => {
  const dir = tmp()
  const r = spawnSync('bash', ['-c', `${MKTEMP_PREFIX} f=$(mktemp "${dir}/x.XXXX"); echo "$f"`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout.trim(), new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/x\\.[A-Za-z0-9]{4}$`))
})
