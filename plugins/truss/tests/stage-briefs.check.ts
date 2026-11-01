// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0014 Decision 4 and the retro-fixes brief fixes in workflows/stage.js: F-1, F-7, F-24, F-27, F-30, F-32.
// Written from the spec. Every case drives the real stage.js through the same stub harness tests/workflows.check.ts uses
// and reads the prompt of the named member (a-builder, a-tester, a-builder-2, a-tester-2, a-stress); none greps the source.
//
// Run with: node --test tests/stage-briefs.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const PATHS = { 'stage.js': `${PLUGIN}/workflows/stage.js` }
const t = (name, fn) => test(name, { timeout: 20000 }, fn)

const ROLES = {
  designer: { agentType: 'truss:design-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  checker: { agentType: 'truss:checking-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
}
const ROLE_NAMES = Object.keys(ROLES)

// ---------------------------------------------------------------- harness (copied from tests/workflows.check.ts)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function exec(file, args, o = {}) {
  const p = PATHS[file]
  if (!existsSync(p)) throw new Error(`script missing: ${p}`)
  const body = readFileSync(p, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const timeline = []
  const counters = {}
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      // heavy first: its line holds the inner `factory.ts check` after ` -- `, so match heavy, then read the real command after the cut
      const mh = prompt.match(/factory\.ts\s+heavy\b([^\n`]*)/)
      let m
      if (mh) {
        const cut = mh[1].indexOf(' -- ')
        m = cut >= 0 ? mh[1].slice(cut + 4).match(/factory\.ts\s+(check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/) : null
      } else {
        m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/)
      }
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}\\s+([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug')
      const expect = flag('expect')
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      const heavy = !!mh
      call.runner = { cmd, slug, expect, branch, key, name, heavy }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      timeline.push(`start:${name}`)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call, heavy }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(heavy ? { ...plain, heavy: { label: `${slug}-check`, waitedMs: 0, exit: 0 } } : plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
      }
      await ticks(cmd === 'integrate' ? 3 : 1)
      timeline.push(`end:${name}`)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    timeline.push(`start:${opts.label}`)
    const h = labels[opts.label]
    let v
    try {
      v = typeof h === 'function' ? await h(call, calls) : h
    } finally {
      await ticks(2)
      timeline.push(`end:${opts.label}`)
    }
    return v === null || v === undefined ? v : structuredClone(v)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let prev = item
        for (const st of stages) prev = await st(prev, item, i)
        return prev
      } catch {
        return null
      }
    }))
  const phase = () => {}
  const log = () => {}
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, phase, log, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  // admit and reap are their own runner calls around every non-runner spawn; `labels` and `timeline` leave them out
  const isAR = (c) => c.runner?.cmd === 'admit' || c.runner?.cmd === 'reap'
  const arNames = new Set(calls.filter(isAR).map((c) => c.runner.name))
  const notAR = (e) => !arNames.has(e.replace(/^(start|end):/, ''))
  return { result, error, calls, unscripted, timeline: timeline.filter(notAR), allTimeline: timeline, labels: calls.filter((c) => !isAR(c)).map((c) => c.label), allLabels: calls.map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const HEAD2 = 'b2'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const RT0 = 'STRESSTEST: 0 findings'

const T1 = { name: 'write-tests', role: 'tester', effort: 'medium', files: ['tests/a.check.ts'], reads: ['src/a.ts'], brief: 'BRIEF-T1: write the tests for a', after: [] }
const B1 = { name: 'build-it', role: 'builder', effort: 'medium', files: ['src/a.ts'], reads: ['tests/a.check.ts'], brief: 'BRIEF-B1: build a', after: ['write-tests'] }
const PLAN = (...tasks) => ({ tasks: tasks.length ? tasks : [T1, B1], stop: null })
const done = (branch, proof = 'PROOF-' + branch) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof, text: 'finished ' + branch })

const entry = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build a, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: ['/proj/docs/adr/0001-x.md'],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
const base = (slug = 'a', over = {}) => ({
  [`${slug}-planner`]: PLAN(), [`${slug}-tester`]: done('feat/t', 'PROOF-T'), [`${slug}-builder`]: done('feat/b', 'PROOF-B'), [`${slug}-qc`]: PASS, ...over,
})
const stageArgs = (crews) => ({
  truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: PATHS['stage.js'], crews },
})
// every label is scripted by the case, so a failure is an assertion about the missing route, never an unscripted label
async function runStage(crews, o = {}) {
  const r = await exec('stage.js', stageArgs(crews), o)
  assert.deepEqual(r.unscripted, [], `unscripted label(s): ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  r.res = r.result
  return r
}
const call = (r, label) => r.calls.find((c) => c.label === label)
const had = (r, label) => r.calls.some((c) => c.label === label)
const idx = (r, ev) => r.timeline.indexOf(ev)
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 2500)}`)
const hasnt = (s, sub) => assert.ok(!s.includes(sub), `unexpected ${JSON.stringify(sub)}`)
const greenSeq = (...rs) => ({ key, n }) => (key === 'check:green' ? rs[Math.min(n, rs.length - 1)] : undefined)
const gFail = (tail = 'GREEN-TAIL') => rj({ ok: false, tail }, 1)
const gOk = (head = HEAD) => rj({ ok: true, head })
const rtCrew = (o = {}) => entry('a', { stressTest: true, ...o })

// ---------------------------------------------------------------- member prompts (F-1, F-7, F-24, F-30)

const F1 = 'Run every command in the foreground, with an explicit Bash timeout up to 600000; no run_in_background, no Monitor.'
const F7 = 'A permission, classifier, hook or gate refusal is never retried by another route, renamed or encoded: stop BLOCKED and quote the refusal.'
const F30 = 'Never run `pkill -f` or `killall`; stop only a process you started, by its pid.'
const F24 = 'After each commit, run `git log -1 --format=%B` and check that its last block holds the Truss-Crew and Truss-Role lines; if it does not, fix the message with git commit --amend.'

const memberRun = () => runStage([entry('a')], { labels: base() })

t('F-1: a-builder and a-tester prompts say foreground with a Bash timeout up to 600000, and the run_in_background sentence is gone', async () => {
  const r = await memberRun()
  for (const l of ['a-builder', 'a-tester']) {
    const p = call(r, l).prompt
    has(p, F1)
    hasnt(p, 'Run each long command once with run_in_background')
    has(p, 'no polling loops, no sleep, no relaunching waiters')
    has(p, 'never a shared temp path')
  }
})
t('F-7: a-builder prompt says a refusal is never retried by another route, renamed or encoded', async () => {
  const r = await memberRun()
  has(call(r, 'a-builder').prompt, F7)
})
t('F-7: a-stress prompt says a refusal is never retried by another route, renamed or encoded', async () => {
  const r = await runStage([rtCrew()], { labels: base('a', { 'a-stress': RT0 }) })
  has(call(r, 'a-stress').prompt, F7)
})
t('F-30: a-builder prompt forbids pkill -f and killall', async () => {
  const r = await memberRun()
  has(call(r, 'a-builder').prompt, F30)
})
t('F-30: a-stress prompt forbids pkill -f and killall', async () => {
  const r = await runStage([rtCrew()], { labels: base('a', { 'a-stress': RT0 }) })
  has(call(r, 'a-stress').prompt, F30)
})
t('F-24: a-builder prompt self-checks the trailers with git log -1 --format=%B and holds no %(trailers format string', async () => {
  const r = await memberRun()
  const p = call(r, 'a-builder').prompt
  has(p, F24)
  hasnt(p, '%(trailers')
})

// ---------------------------------------------------------------- F-32: Base and Patch lines in the stress brief

t('F-32: a-stress prompt holds the line "Base: <entry.base>" and the line "Patch: git diff <base>...<head>"', async () => {
  const r = await runStage([rtCrew()], { labels: base('a', { 'a-stress': RT0 }) })
  const lines = call(r, 'a-stress').prompt.split('\n')
  assert.ok(lines.includes(`Base: ${BASE}`), `no exact Base line in:\n${lines.join('\n').slice(0, 2000)}`)
  assert.ok(lines.includes(`Patch: git diff ${BASE}...${HEAD}`), `no exact Patch line in:\n${lines.join('\n').slice(0, 2000)}`)
})

// ---------------------------------------------------------------- F-27: tester findings go to a tester fix member

const TF = 'tests/a.check.ts'
const qcFail = (...bullets) => `VERDICT: FAIL\n\n## Findings\n${bullets.map((b) => `- ${b}`).join('\n')}\n`
const stressFindings = (...bullets) => `STRESSTEST: ${bullets.length} findings\n\n## Findings\n${bullets.map((b) => `- ${b}`).join('\n')}\n\n## Notes\n- NOTE-GAP\n`
const fixLabels = { 'a-tester-2': done('feat/ft'), 'a-builder-2': done('feat/fb') }
// the Files you may change line of a prompt, and the line after it
const lineOf = (p, start) => p.split('\n').find((l) => l.startsWith(start)) ?? ''
const lineAfter = (p, start) => {
  const ls = p.split('\n')
  return ls[ls.findIndex((l) => l.startsWith(start)) + 1] ?? ''
}

t('F-27: a QC FAIL whose finding names a tester file runs a-tester-2 (test-writer, Files you may change names it) and no a-builder-2', async () => {
  const r = await runStage([entry('a')], { labels: { ...base('a', { 'a-qc': qcFail(`TFIND ${TF} misses the empty case`), 'a-qc-2': PASS }), ...fixLabels } })
  assert.ok(had(r, 'a-tester-2'), `no a-tester-2; labels: ${r.labels.join(', ')}`)
  const p = call(r, 'a-tester-2').prompt
  has(p, 'Truss-Role: test-writer')
  assert.equal(lineOf(p, 'Files you may change:'), `Files you may change: ${TF}`)
  has(p, 'TFIND')
  assert.ok(!had(r, 'a-builder-2'), 'a builder fix ran for a tester-only finding')
})
t('F-27: one tester-file finding and one other: a-tester-2 runs before a-builder-2, each prompt holding only its own finding', async () => {
  const r = await runStage([entry('a')], {
    labels: { ...base('a', { 'a-qc': qcFail(`TFIND in ${TF}`, 'BFIND in src/a.ts'), 'a-qc-2': PASS }), ...fixLabels },
  })
  assert.ok(had(r, 'a-tester-2'), `no a-tester-2; labels: ${r.labels.join(', ')}`)
  assert.ok(had(r, 'a-builder-2'), 'no a-builder-2')
  const tp = call(r, 'a-tester-2').prompt
  const bp = call(r, 'a-builder-2').prompt
  has(tp, 'TFIND')
  hasnt(tp, 'BFIND')
  has(bp, 'BFIND')
  hasnt(bp, 'TFIND')
  assert.ok(idx(r, 'end:a-tester-2') < idx(r, 'start:a-builder-2'), 'the tester fix did not finish before the builder fix started')
  assert.ok(idx(r, 'end:runner:a:integrate:feat/ft') < idx(r, 'start:a-builder-2'), 'the tester fix was not integrated before the builder fix')
})
t('F-27: stress findings naming a tester file run a-tester-2 with that finding', async () => {
  const r = await runStage([rtCrew()], {
    labels: { ...base('a', { 'a-stress': stressFindings(`SFIND ${TF} never runs the failing path`) }), ...fixLabels },
    runner: greenSeq(gOk(HEAD), gOk(HEAD2)),
  })
  assert.ok(had(r, 'a-tester-2'), `no a-tester-2; labels: ${r.labels.join(', ')}`)
  const p = call(r, 'a-tester-2').prompt
  has(p, 'Truss-Role: test-writer')
  has(p, 'SFIND')
  hasnt(p, 'NOTE-GAP')
  assert.ok(!had(r, 'a-builder-2'), 'a builder fix ran for a tester-only stress finding')
})
t('F-27: a QC FAIL naming no tester file runs a-builder-2 only (today\'s path)', async () => {
  const r = await runStage([entry('a')], { labels: { ...base('a', { 'a-qc': qcFail('BFIND in src/a.ts'), 'a-qc-2': PASS }), ...fixLabels } })
  assert.ok(had(r, 'a-builder-2'))
  has(call(r, 'a-builder-2').prompt, 'BFIND')
  assert.ok(!had(r, 'a-tester-2'), 'a tester fix member started for a finding naming no tester file')
})
t('F-27: a merge-ready resume (no tasks) sends a QC finding naming a tester file to a-tester-2, not a builder', async () => {
  const r = await runStage([entry('a', { resume: 'merge-ready', tasks: [], labelFrom: { tester: 2, builder: 2, qc: 2 } })], {
    labels: { 'a-qc-2': qcFail(`TFIND ${TF} misses the empty case`), 'a-qc-3': PASS, 'a-tester-2': done('feat/ft'), 'a-builder-2': done('feat/fb') },
  })
  assert.ok(had(r, 'a-tester-2'), `no a-tester-2; labels: ${r.labels.join(', ')}`)
  assert.ok(!had(r, 'a-builder-2'), 'a builder fix ran for a tester-only finding')
})
t('F-27: one finding naming a tester file and a code file goes to both a-tester-2 and a-builder-2', async () => {
  const r = await runStage([entry('a')], {
    labels: { ...base('a', { 'a-qc': qcFail(`TFIND in ${TF}; BFIND in src/a.ts`), 'a-qc-2': PASS }), ...fixLabels },
  })
  assert.ok(had(r, 'a-tester-2'), `no a-tester-2; labels: ${r.labels.join(', ')}`)
  assert.ok(had(r, 'a-builder-2'), 'no a-builder-2')
  has(call(r, 'a-builder-2').prompt, 'BFIND')
})
t('F-27: a green-check failure still goes to a-builder-2 (today\'s path)', async () => {
  const r = await runStage([entry('a')], { labels: { ...base(), ...fixLabels }, runner: greenSeq(gFail('TAIL-ONE'), gOk(HEAD2)) })
  assert.ok(had(r, 'a-builder-2'))
  has(call(r, 'a-builder-2').prompt, 'TAIL-ONE')
  assert.ok(!had(r, 'a-tester-2'))
})
t('F-27: a fix builder\'s Files you may change leaves out the tester file, and the next line says a tester owns it', async () => {
  const owns = ['src/**', TF]
  const r = await runStage([entry('a', { owns })], { labels: { ...base(), ...fixLabels }, runner: greenSeq(gFail('TAIL-ONE'), gOk(HEAD2)) })
  const p = call(r, 'a-builder-2').prompt
  const files = lineOf(p, 'Files you may change:')
  assert.ok(files.startsWith('Files you may change:'), 'no Files you may change line')
  hasnt(files, TF)
  has(files, 'src/**')
  assert.equal(lineAfter(p, 'Files you may change:'), `Files a tester owns, which you must not change: ${TF}`)
})
