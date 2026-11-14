// @ts-nocheck
// 0.32.0 crew deferred-fixes (R-138): the items 0.31.0's report deferred are fixed, or deferred with a reason in the ledger at
// tests/fixtures/deferred-031/ledger.json. Written from the crew brief before the code.
//
// Contract these cases pin (the builder meets it without changing this file):
// - plan.json may carry an optional top-level string `target`. It wins over .claude/truss.json `target` wherever a truss dir is known:
//   `factory settings --dir D` and the `truss.target` of `factory start` both report it. It must be a valid git branch name, or plan-check refuses.
// - plan-args and start never fail because the session workflows folder refuses mkdir. This file simulates the refusal portably: the folder
//   <transcripts root>/<project>/<sid>/workflows is a regular file, so mkdir of workflows/scripts fails (ENOTDIR, the portable stand-in for the
//   sandbox's EPERM). The commands then pick another writable place and still hand back a scriptPath that exists and holds the real script.
// - tests/fixtures/deferred-031/deferred-section-031.md is a verbatim copy of the "Deferred or unverified" section of the 0.31.0 report.
//   The ledger holds one entry per bullet of that section. The test reads only the fixture and never skips.
//
// Run with: node --test tests/deferred-032.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { cli, mkWorld } from './fixtures/ltc/harness.ts'
import { REAL_PLUGIN, assertOneLine, crew, flat, git, mkEnv, planObj, writeGoal, writePlan } from './fixtures/workflow-run/harness.ts'

const say = (r: any): string => `exit ${r.status}; stdout ${String(r.stdout).slice(0, 700)}; stderr ${String(r.stderr).slice(0, 300)}`

// ---------------------------------------------------------------------------------------------------------------
// the plan.json target override

function targetWorld(configTarget: string, planTarget?: string) {
  const env = mkEnv({ config: { merge: 'sequential', target: configTarget } })
  for (const b of new Set([configTarget, planTarget].filter((b) => b && b !== 'main'))) git(env.repo, ['branch', b as string])
  writePlan(env.dir, planObj([crew('s')], planTarget === undefined ? {} : { target: planTarget }))
  writeGoal(env.dir, 's')
  return env
}

test("a plan.json target overrides the .claude/truss.json target for that run's factory commands", () => {
  const env = targetWorld('develop', 'release-9.9')
  const s = assertOneLine(env.run('settings'))
  assert.equal(s.target, 'release-9.9', 'settings --dir reports the plan target')
  assert.equal(s.merge, 'sequential', 'the other keys still come from .claude/truss.json')
  const st = env.run('start', { stage: 'next' })
  assert.equal(st.status, 0, say(st))
  assert.equal(assertOneLine(st).truss.target, 'release-9.9', 'start threads the plan target to its truss args')
  const noDir = assertOneLine(env.run('settings', { dir: null }))
  assert.equal(noDir.target, 'develop', 'with no truss dir known the .claude/truss.json target stands')
})

test('a plan with no target uses the .claude/truss.json target', () => {
  const env = targetWorld('develop')
  assert.equal(assertOneLine(env.run('settings')).target, 'develop')
  const st = env.run('start', { stage: 'next' })
  assert.equal(st.status, 0, say(st))
  assert.equal(assertOneLine(st).truss.target, 'develop')
})

test('plan-check refuses a plan target that is not a valid branch name', () => {
  const check = (target: unknown) => {
    const env = mkEnv()
    writePlan(env.dir, planObj([crew('alpha')], { target }))
    const res = env.run('plan-check', { repo: null })
    return { res, json: assertOneLine(res) }
  }
  for (const good of ['release-0.32.0', 'feature/x', 'main']) {
    const { res, json } = check(good)
    assert.equal(res.status, 0, `${good}: ${say(res)}`)
    assert.equal(json.ok, true, good)
  }
  for (const bad of ['has space', '-leading-dash', 'a..b', 'x;rm -rf', 'a~1', 'a:b', 'ends/', 'name.lock', '', 7]) {
    const { res, json } = check(bad)
    assert.equal(res.status, 1, `${JSON.stringify(bad)} should be refused: ${say(res)}`)
    assert.equal(json.ok, false, JSON.stringify(bad))
    assert.ok(json.errors.some((e: string) => /target/i.test(e)), `${JSON.stringify(bad)}: an error names the target: ${JSON.stringify(json.errors)}`)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// the scripts dir the sandbox refuses

/** A session world whose main transcript is found, and whose workflows folder cannot be made (it is a regular file). */
function blockedWorld() {
  const w = mkWorld()
  const proj = `${w.troot}/proj`
  mkdirSync(`${proj}/${w.sid}`, { recursive: true })
  writeFileSync(`${proj}/${w.sid}.jsonl`, '{}\n')
  const blocker = `${proj}/${w.sid}/workflows`
  writeFileSync(blocker, 'not a folder')
  return { w, blocker, plugin: flat(w.factory).replace(/\/bin\/factory\.ts$/, '') }
}

function assertWritableScript(scriptPath: string, blocker: string, source: string) {
  assert.equal(typeof scriptPath, 'string')
  assert.ok(!flat(scriptPath).startsWith(`${blocker}/`), `scriptPath is under the refused folder: ${scriptPath}`)
  assert.ok(existsSync(scriptPath), `scriptPath does not exist: ${scriptPath}`)
  assert.ok(readFileSync(scriptPath).equals(readFileSync(source)), 'scriptPath holds the script byte for byte')
}

test('plan-args picks a writable scripts dir when the session workflows folder refuses mkdir', () => {
  const { w, blocker, plugin } = blockedWorld()
  const brief = `${w.dir}/brief.md`
  writeFileSync(brief, 'Build the thing.')
  const r = cli(w, 'plan-args', ['--brief-file', brief])
  assert.equal(r.status, 0, say(r))
  assertWritableScript(assertOneLine(r).truss.scriptPath, blocker, `${plugin}/workflows/plan.js`)
})

test('start picks a writable scripts dir when the session workflows folder refuses mkdir', () => {
  const { w, blocker, plugin } = blockedWorld()
  writePlan(w.dir, planObj([crew('s')]))
  writeGoal(w.dir, 's')
  const r = cli(w, 'start', ['--stage', 'next'])
  assert.equal(r.status, 0, say(r))
  assertWritableScript(assertOneLine(r).truss.scriptPath, blocker, `${plugin}/workflows/stage.js`)
})

// ---------------------------------------------------------------------------------------------------------------
// the requirement stamps

test('R-116 to R-124 Added stamps are not the T00:00:00Z placeholder', () => {
  const text = readFileSync(`${REAL_PLUGIN}/docs/requirements.md`, 'utf8')
  for (let n = 116; n <= 124; n++) {
    const m = new RegExp(`^## R-${n}:[^\\n]*\\n(?:(?!## R-)[^\\n]*\\n)*?Added: (\\S+)`, 'm').exec(text)
    assert.ok(m, `R-${n} has an Added line`)
    assert.ok(!/T00:00:00Z$/.test(m[1]), `R-${n} Added is the placeholder: ${m[1]}`)
    assert.match(m[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `R-${n} Added is an ISO time`)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// the deferred ledger

const REPORT = new URL('./fixtures/deferred-031/deferred-section-031.md', import.meta.url)
const LEDGER = `${REAL_PLUGIN}/tests/fixtures/deferred-031/ledger.json`
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const THIS_TITLE = 'every deferred item in report-0.31.0.md has a passing test title or a reason line in the deferred ledger'

/** The bullets of the report's "Deferred or unverified" section, each joined to one line. */
function deferredBullets(report: string): string[] {
  const lines = report.split('\n')
  const at = lines.findIndex((l) => /^##\s+Deferred or unverified\s*$/.test(l))
  assert.ok(at >= 0, 'the report has a "Deferred or unverified" section')
  const out: string[] = []
  for (const l of lines.slice(at + 1)) {
    if (/^##\s/.test(l)) break
    if (/^- /.test(l)) out.push(l.slice(2).trim())
    else if (/^\s+\S/.test(l) && out.length > 0) out[out.length - 1] += ` ${l.trim()}`
  }
  return out
}

test(THIS_TITLE, { timeout: 600_000 }, () => {
  const bullets = deferredBullets(readFileSync(REPORT, 'utf8'))
  assert.ok(bullets.length >= 10, `the report lists its deferred bullets (found ${bullets.length})`)
  assert.ok(existsSync(LEDGER), `the ledger is missing: ${LEDGER}`)
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'))
  assert.ok(Array.isArray(ledger.entries), 'the ledger holds an entries array')
  const entries: any[] = ledger.entries
  const keys = new Set<string>()
  for (const e of entries) {
    assert.match(String(e.key), /^[a-z0-9]+(-[a-z0-9]+)*$/, `entry key: ${JSON.stringify(e.key)}`)
    assert.ok(!keys.has(e.key), `duplicate key ${e.key}`)
    keys.add(e.key)
    assert.equal(typeof e.text, 'string', `${e.key}: text`)
    const hasTest = e.test !== undefined || e.title !== undefined
    const hasReason = e.reason !== undefined
    assert.ok(hasTest !== hasReason, `${e.key}: holds either {test, title} or {reason}, not both and not neither`)
    if (hasReason) assert.ok(typeof e.reason === 'string' && e.reason.trim() !== '' && !e.reason.includes('\n'), `${e.key}: reason is one non-empty line`)
  }
  // one entry per bullet, matched by the bullet's text; an entry with source "ruling" serves a program manager ruling, not a bullet
  // each bullet of the fixture equals the text of its ledger entry, word for word
  const bulletEntries = entries.filter((e) => e.source !== 'ruling')
  assert.deepEqual(bulletEntries.map((e) => e.text), bullets, 'the fixture bullets equal the ledger entry texts, in order')
  for (const b of bullets) assert.ok(entries.some((e) => e.text === b), `no ledger entry for the deferred item: ${b}`)
  for (const e of entries) assert.ok(e.source === 'ruling' || bullets.includes(e.text), `${e.key}: its text is no bullet of the report (stale entry)`)

  const failures: string[] = []
  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  for (const e of entries.filter((x) => x.test !== undefined)) {
    if (e.test === 'tests/deferred-032.check.ts' && e.title === THIS_TITLE) {
      failures.push(`${e.key}: the ledger case cannot point at itself`)
      continue
    }
    const file = `${REAL_PLUGIN}/${e.test}`
    if (!existsSync(file)) {
      failures.push(`${e.key}: test file ${e.test} does not exist`)
      continue
    }
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', `^${esc(e.title)}$`, file], { encoding: 'utf8', env: childEnv, cwd: REAL_PLUGIN, windowsHide: true, timeout: 400_000 })
    const printed = String(r.stdout).split('\n').some((l) => new RegExp(`^\\s*ok \\d+ - ${esc(e.title)}\\s*$`).test(l))
    if (r.status !== 0 || !printed) failures.push(`${e.key}: "${e.title}" in ${e.test} did not print ok (exit ${r.status})`)
  }
  assert.deepEqual(failures, [], failures.join('\n'))
})
