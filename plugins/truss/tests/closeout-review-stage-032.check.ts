// @ts-nocheck
// truss 0.32.0 closeout, review-stage: the stage.js side of the crew-decisions diff (`git diff 29953ee2^1 29953ee2`, R-86, ADR-0047),
// now in workflows-src/stage/ (replies.js pendingCall, takeCall, restoreCalls) and bundled into workflows/stage.js.
// Each case pins one finding of the QC pass or the reviewer pass (see docs/goals/0.32.0-closeout.md) through a stubbed agent().
// To see a case red, point TRUSS_STAGE_UNDER_TEST at an older stage.js (a file path), as the doc rows say; unset, the committed bundle runs.
// Run with: node --test tests/closeout-review-stage-032.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gatesAware } from './fixtures/gates-stub.ts'
import { REAL_PLUGIN } from './fixtures/workflow-run/harness.ts'

const t = (name, fn) => test(name, { timeout: 60000 }, fn)

const STAGE = process.env.TRUSS_STAGE_UNDER_TEST || `${REAL_PLUGIN}/workflows/stage.js`
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
  ux: { agentType: 'truss:ux-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  po: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
}
const PERSONAS = { 'product-owner': { agentType: 'product-owner', model: 'opus', effort: 'medium', file: '/proj/.claude/agents/product-owner.md', description: 'Judges the product fit', readOnly: true, loaded: true } }

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const ticks = async (n) => {
  for (let i = 0; i < n; i++) await tick()
}
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj) })

async function execStage(args, o = {}) {
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const unscripted = []
  const counters = {}
  const agent = gatesAware(async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label, i: calls.length }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const m = prompt.match(/factory\.ts\s+(admit|reap|check|integrate|owns-check|tests-check|sync|crew-decision|decision-replies|decision-ack|decision-checkpoint|crew-learned|knowledge-commit|knowledge-lint|decisions|escalate|inbox|resolve)\b([^\n]*)/)
      if (!m) {
        unscripted.push(`${opts.label} (no factory.ts command in prompt)`)
        throw new Error(`unparsable runner prompt for label ${opts.label}`)
      }
      const cmd = m[1]
      const flag = (name) => (m[2].match(new RegExp(`--${name}(?:\\s+|=)([^\\s\`]+)`)) || [])[1]
      const slug = flag('slug') ?? flag('crew')
      const expect = flag('expect')
      const key = cmd === 'check' ? `check:${expect}` : cmd
      const name = `runner:${slug}:${key}`
      call.runner = { cmd, slug, expect, key, name, rest: m[2] }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, n, prompt, call, calls }) : undefined
      if (out === undefined) {
        const plain = expect === 'red' ? { ok: true } : { ok: true, head: HEAD }
        out =
          cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(plain) : cmd === 'integrate' ? rj({ merged: true }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : cmd === 'crew-decision' ? rj({ id: `d${n + 1}` }) : cmd === 'decision-replies' ? rj([]) : cmd === 'decision-ack' ? rj({ acked: [], already: [] }) : cmd === 'decision-checkpoint' || cmd === 'crew-learned' || cmd === 'knowledge-commit' ? rj({ ok: true }) : cmd === 'decisions' ? rj({ decisions: [] }) : cmd === 'inbox' ? rj({ items: [], open: 0 }) : rj({ merged: true })
      }
      await ticks(1)
      return out
    }
    const labels = o.labels ?? {}
    if (!Object.hasOwn(labels, opts.label)) {
      unscripted.push(String(opts.label))
      throw new Error(`unscripted label: ${opts.label}`)
    }
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await ticks(2)
    return v === null || v === undefined ? v : structuredClone(v)
  })
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let prev = item; for (const st of stages) prev = await st(prev, item, i); return prev } catch { return null } }))
  let result
  let error
  try {
    result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  } catch (e) {
    error = e
  }
  return { result, error, calls, unscripted, labels: calls.map((c) => c.label) }
}

const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const done = (branch, extra = {}) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch, ...extra })
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] }
const TF = { name: 'build-export', role: 'builder', effort: 'low', persona: null, files: ['src/export.ts'], reads: [], brief: 'BRIEF-TF', after: ['write-tests'] }
const TD = { name: 'write-docs', role: 'writer', effort: 'medium', persona: null, files: ['docs/export.md'], reads: [], brief: 'BRIEF-TD', after: ['build-export'] }
const entryOf = (slug = 'a', o = {}) => ({
  slug, stage: 1, goalFile: `/proj/.truss/goals/${slug}.md`, goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts', 'docs/**'],
  acceptanceTest: 'node --test tests/a.check.ts', highImpact: ['src/core/**'], stressTest: false, scope: 'SCOPE-VERBATIM: build the export, nothing else',
  worktree: `/wt/${slug}`, branch: `truss/${slug}`, base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [],
  resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {}, ...o,
})
async function runStages(crews, o = {}) {
  const args = { truss: { kind: 'stage', dir: '/proj/.truss', repo: '/proj', plugin: REAL_PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE, crews, personas: PERSONAS } }
  const r = await execStage(args, o)
  assert.deepEqual(r.unscripted, [], `unscripted: ${r.unscripted.join(', ')}`)
  if (r.error) throw r.error
  return r
}
const labelsOf = (slug, over = {}) => ({ [`${slug}-planner`]: { tasks: [TT, TF, TD], stop: null }, [`${slug}-tester`]: done('feat/t'), [`${slug}-builder`]: done('feat/b'), [`${slug}-writer`]: done('feat/w'), [`${slug}-writer-2`]: done('feat/k'), [`${slug}-qc`]: PASS, ...over })
const resOf = (r, slug = 'a') => r.result.find((x) => x.slug === slug)
const runnerCalls = (r, cmd) => r.calls.filter((c) => c.runner && c.runner.cmd === cmd)
const kindOf = (prompt) => (prompt.match(/--kind(?:\s+|=)(\S+)/) || [])[1]
const resolvedRow = (id, ref, note, ts = '2026-11-12T12:30:00.000Z') => ({ id, ts, kind: 'pm-question', session: 'sess-1', crews: ['a'], ref, blocking: true, title: 'Product call for a', state: 'resolved', applied: false, decision: 'answer', by: 'pm', note })
// the inbox answers only the pm-question read, with these rows
const inboxOf = (rows) => ({ cmd, prompt }) => (cmd === 'inbox' ? rj({ items: kindOf(prompt) === 'pm-question' ? rows : [], open: 0 }) : undefined)

// QC pass, R-86 and ADR-0047 "pendingCall is the one place a resumed member reads its item": a writer that asked a question at the
// knowledge step must start with the answer of its resolved item (pendingCall in knowledge()). Red on stage.js at 1d95d43, where only
// runTask read the item.
t('closeout-review-stage: a resumed knowledge writer starts with the program manager answer to its pm-question', async () => {
  const NOTE = 'KNOWLEDGE-ANSWER: record the archived rule under product decisions'
  const seeded = [{ kind: 'product', text: 'export keeps archived items -> yes', source: 'earlier run', task: 'build-export', member: 'po' }]
  const row = resolvedRow('E-20261112-kkkkkk', 'crew-call:a:knowledge', NOTE)
  const r = await runStages([entryOf('a', { resume: 'stale', tasks: [TT, TF, TD], done: ['write-tests', 'build-export', 'write-docs'], learned: seeded })], { labels: labelsOf('a'), runner: inboxOf([row]) })
  assert.equal(resOf(r).state, 'passed', JSON.stringify(resOf(r)).slice(0, 500))
  const writers = r.calls.filter((c) => /^a-writer(-\d+)?$/.test(String(c.label)))
  assert.ok(writers.length >= 1, `the knowledge writer ran: ${r.labels.join(',')}`)
  assert.ok(writers[0].prompt.includes(NOTE), `the knowledge writer's first prompt carries the program manager's note:\n${writers[0].prompt.slice(0, 1500)}`)
  const d = runnerCalls(r, 'crew-decision')
  assert.equal(d.length, 1, 'the answer is logged once as a crew decision')
  assert.ok(d[0].prompt.includes('--by program-manager'), d[0].prompt)
})

// QC pass, same rule at the green step: a fix member spawned on a resume starts with the answer of a resolved item no earlier run used.
// Red on stage.js at 1d95d43 (fixBuilder had no pendingCall). The sibling case "a resolved item the crew already used answers no later
// fix member on a later resume" (pm-calls-029) is the other half: a used item answers none.
t('closeout-review-stage: a resumed fix member starts with the answer of an unused resolved pm-question at its step', async () => {
  const NOTE = 'FIX-ANSWER: drop the legacy CSV column'
  const row = resolvedRow('E-20261112-ffffff', 'crew-call:a:green', NOTE)
  const runner = async (c) => {
    const inbox = await inboxOf([row])(c)
    if (inbox) return inbox
    if (c.key === 'check:green') return c.n === 0 ? rj({ ok: false, tail: 'timezone case fails' }, 1) : undefined
    return undefined
  }
  const r = await runStages([entryOf('a', { resume: 'stale', tasks: [TT, TF, TD], done: ['write-tests', 'build-export', 'write-docs'] })], { labels: labelsOf('a', { 'a-builder': done('feat/fix') }), runner })
  const fix = r.calls.filter((c) => /^a-builder(-\d+)?$/.test(String(c.label)))
  assert.ok(fix.length >= 1, `a fix builder ran for the timezone failure: ${r.labels.join(',')}`)
  assert.ok(fix[0].prompt.includes('timezone case'), 'the fix prompt names the failure')
  assert.ok(fix[0].prompt.includes(NOTE), `the fix member's first prompt carries the answer of its resolved item:\n${fix[0].prompt.slice(0, 1500)}`)
})

// QC pass, ADR-0047 "the logged question ends (inbox item <id>)": a task that asks the same question twice opens two items, and the
// second item's answer is a new decision even when its text equals the first answer. Red on stage.js at be2128b, whose pendingCall
// treated an earlier decision of the task with the same question or answer as the item already logged and dropped the second.
t('closeout-review-stage: a second inbox item for a re-asked question is logged although its answer equals the first one', async () => {
  const SAME = 'Include archived items, flagged.'
  const REF = 'crew-call:a:build-export'
  const first = resolvedRow('E-20261112-111111', REF, SAME, '2026-11-12T12:00:00.000Z')
  const second = resolvedRow('E-20261112-222222', REF, SAME, '2026-11-12T13:00:00.000Z')
  const runner = async (c) => {
    const inbox = await inboxOf([first, second])(c)
    if (inbox) return inbox
    if (c.cmd === 'decisions') return rj({ decisions: [{ id: 'd1', crew: 'a', task: 'build-export', question: `Product call for a (inbox item ${first.id})`, answer: SAME, by: 'program-manager' }] })
    return undefined
  }
  const again = { 'a-builder': done('feat/b2'), 'a-builder-2': done('feat/b3') }
  const r = await runStages([entryOf('a', { resume: 'stale', tasks: [TT, TF, TD], done: ['write-tests'] })], { labels: labelsOf('a', again), runner })
  assert.equal(resOf(r).state, 'passed', JSON.stringify(resOf(r)).slice(0, 500))
  const d = runnerCalls(r, 'crew-decision')
  assert.equal(d.length, 1, `the second item is logged as one crew decision, not dropped as already logged; ${d.length} crew-decision calls`)
  assert.ok(d[0].prompt.includes(`(inbox item ${second.id})`), d[0].prompt)
  const builders = r.calls.filter((c) => /^a-builder(-\d+)?$/.test(String(c.label)))
  assert.ok(builders.length >= 1 && builders.every((c) => c.prompt.includes(SAME)), 'the asking member still carries the answer')
})
