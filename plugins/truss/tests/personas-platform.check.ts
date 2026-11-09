// @ts-nocheck
// truss ADR-0033, personas off Linux. Written from the contract before the change.
//   1. sessionStart reads the CLAUDE_PID process start time on macOS (ps elapsed time) and Windows (PowerShell), through injectable seams
//   2. every read-only persona carries inlineType, a plugin agent type whose tools are read-only, so an inlined judge never holds Write or Edit
// Run with: node --test tests/personas-platform.check.ts

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkRepo, mkTrussDir, runCli, tmp } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const factory = await import('../bin/factory.ts')
const t = (name, fn) => test(name, { timeout: 60000 }, fn)
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0)

const probe = (replies, calls = []) => ({
  now: () => NOW,
  exec: (file, args) => {
    calls.push([file, args])
    return typeof replies === 'function' ? replies(file, args) : replies
  },
})

t('start 1: macOS reads the elapsed time of the CLAUDE_PID process with ps (argument array), one second earlier for the 1 s resolution', () => {
  const calls = []
  const s = factory.sessionStart({ CLAUDE_PID: '4242' }, 'darwin', probe('  01:02:03\n', calls))
  assert.equal(s, NOW - (3723 + 1) * 1000)
  assert.deepEqual(calls, [['ps', ['-o', 'etime=', '-p', '4242']]])
})

t('start 2: ps elapsed time forms mm:ss, hh:mm:ss and dd-hh:mm:ss', () => {
  const at = (txt) => factory.sessionStart({ CLAUDE_PID: '1' }, 'darwin', probe(txt))
  assert.equal(at('05:07'), NOW - (307 + 1) * 1000)
  assert.equal(at('2-03:04:05\n'), NOW - (2 * 86400 + 3 * 3600 + 4 * 60 + 5 + 1) * 1000)
})

t('start 3: Windows asks PowerShell for the process start as epoch ms, with no shell string, and falls back to pwsh', () => {
  const calls = []
  const s = factory.sessionStart({ CLAUDE_PID: '777' }, 'win32', probe((file) => (file === 'powershell.exe' ? '1762689600123\r\n' : undefined), calls))
  assert.equal(s, 1762689600123)
  assert.equal(calls[0][0], 'powershell.exe')
  assert.ok(Array.isArray(calls[0][1]) && calls[0][1].includes('-NoProfile') && calls[0][1].some((a) => a.includes('Get-Process -Id 777')), JSON.stringify(calls[0]))
  const calls2 = []
  const s2 = factory.sessionStart({ CLAUDE_PID: '777' }, 'win32', probe((file) => (file === 'pwsh' ? '1762689600123' : undefined), calls2))
  assert.equal(s2, 1762689600123)
  assert.deepEqual(calls2.map((c) => c[0]), ['powershell.exe', 'pwsh'])
})

t('start 4: unreadable output, a missing pid, a bad pid and other platforms give undefined; the test override still wins', () => {
  assert.equal(factory.sessionStart({ CLAUDE_PID: '1' }, 'darwin', probe(undefined)), undefined)
  assert.equal(factory.sessionStart({ CLAUDE_PID: '1' }, 'darwin', probe('garbage')), undefined)
  assert.equal(factory.sessionStart({ CLAUDE_PID: '1' }, 'win32', probe('not a number')), undefined)
  const calls = []
  assert.equal(factory.sessionStart({}, 'darwin', probe('01:00', calls)), undefined)
  assert.equal(factory.sessionStart({ CLAUDE_PID: '12; rm -rf' }, 'win32', probe('1', calls)), undefined)
  assert.equal(factory.sessionStart({ CLAUDE_PID: '5' }, 'freebsd', probe('01:00', calls)), undefined)
  assert.deepEqual(calls, [], 'no process was started')
  assert.equal(factory.sessionStart({ CLAUDE_PID: '1', TRUSS_SESSION_START: '1234' }, 'darwin', probe('01:00', calls)), 1234)
  assert.deepEqual(calls, [])
})

t('start 5: on Linux the /proc path is kept and the probe is not used', () => {
  const calls = []
  const s = factory.sessionStart({ CLAUDE_PID: String(process.pid) }, 'linux', probe('01:00', calls))
  if (process.platform === 'linux') assert.ok(typeof s === 'number' && s <= Date.now() && s > Date.now() - 6 * 3600_000, String(s))
  assert.deepEqual(calls, [])
})

// ---------------------------------------------------------------- inlineType

const agentTools = (name) => {
  const text = readFileSync(`${PLUGIN}/agents/${name}.md`, 'utf8')
  const m = /^tools:\s*(.*)$/m.exec(text.split('---')[1])
  return (m?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}
const file = (name, tools) => `---\nname: ${name}\ndescription: ${name} area\n${tools === undefined ? '' : `tools: ${tools}\n`}---\n\nBody of ${name}.\n`

function personasOf(files) {
  const repo = mkRepo({ files: Object.fromEntries(Object.entries(files).map(([n, text]) => [`.claude/agents/${n}.md`, text])) })
  const dir = mkTrussDir()
  const brief = `${tmp('pp-brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  const r = runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', dir, '--repo', repo, '--brief-file', brief], repo, { TRUSS_SESSION_START: String(Date.now() + 3_600_000) })
  assert.equal(r.status, 0, r.stderr + r.stdout)
  return r.json.truss.personas
}

t('inline 1: a read-only persona carries inlineType, an editing persona does not; the type is a plugin agent that cannot write', () => {
  const p = personasOf({
    'judge-bash': file('judge-bash', 'Read, Grep, Glob, Bash'),
    'judge-plain': file('judge-plain', 'Read, Grep, Glob'),
    'judge-web': file('judge-web', 'Read, WebFetch'),
    'dev-all': file('dev-all'),
    'dev-write': file('dev-write', 'Read, Write, Edit, Bash'),
  })
  assert.equal(p['judge-bash'].readOnly, true)
  assert.equal(p['judge-bash'].inlineType, 'truss:judge')
  assert.equal(p['judge-plain'].inlineType, 'truss:judge')
  assert.equal(p['judge-web'].inlineType, 'truss:judge')
  assert.ok(!Object.hasOwn(p['dev-all'], 'inlineType'))
  assert.ok(!Object.hasOwn(p['dev-write'], 'inlineType'))
  for (const type of new Set(['judge-bash', 'judge-plain', 'judge-web'].map((n) => p[n].inlineType))) {
    const tools = agentTools(type.slice('truss:'.length))
    assert.ok(tools.length > 0 && !tools.some((x) => x === 'Write' || x === 'Edit' || x === '*'), `${type}: ${tools}`)
  }
})

t('inline 2: inlineType is present on an unloaded and a loaded read-only persona alike', () => {
  const repo = mkRepo({ files: { '.claude/agents/judge.md': file('judge', 'Read, Grep, Glob') } })
  const dir = mkTrussDir()
  const brief = `${tmp('pp-brief-')}/brief.md`
  writeFileSync(brief, 'brief\n')
  for (const [start, loaded] of [[Date.now() + 3_600_000, true], [Date.now() - 3_600_000, false]]) {
    const r = runCli(`${PLUGIN}/bin/factory.ts`, 'plan-args', ['--dir', dir, '--repo', repo, '--brief-file', brief], repo, { TRUSS_SESSION_START: String(start) })
    const j = r.json.truss.personas.judge
    assert.equal(j.loaded, loaded)
    assert.equal(j.inlineType, 'truss:judge')
  }
})

t('inline 3: agents/judge.md is a neutral read-only host: fixed name, description, tools, model, effort, and the BLOCKED reply', () => {
  const text = readFileSync(`${PLUGIN}/agents/judge.md`, 'utf8')
  const fm = text.split('---')[1]
  assert.match(fm, /^name: judge$/m)
  assert.match(fm, /^description: Runs a read-only judge persona whose definition is inlined at the top of its brief\. Never writes, edits, commits or pushes\. Started by truss workflows only\.$/m)
  assert.match(fm, /^model: sonnet$/m)
  assert.match(fm, /^effort: medium$/m)
  assert.deepEqual(agentTools('judge'), ['Read', 'Grep', 'Glob', 'Bash'])
  assert.ok(text.includes('BLOCKED: no persona definition in the brief'))
})
