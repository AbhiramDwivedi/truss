// @ts-nocheck
// truss 0.29.0 R-86, a crew decision that needs the program manager reaches the program manager's inbox and waits.
// Written from the contract before the change (factory-CLI half; the stage.js cases are added below by the stage tester).
//   inbox KINDS row pm-question {by: 'any', blocking: true}; scope-change stays client-only and blocking
//   factory decision-checkpoint --crew <slug> --status-line   -> a truss-status line that carries checkpoint: true
// Run with: node --test tests/pm-calls-029.check.ts

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, assertOneLine, crew, flat, mkRepo, planObj, runCli, writePlan } from './fixtures/workflow-run/harness.ts'

const t = (name, fn) => test(name, { timeout: 60000 }, fn)

const FACTORY = `${REAL_PLUGIN}/bin/factory.ts`
const CONFIG = { architecture: 'docs/architecture.md', adr: 'docs/adr' }

const temps: string[] = []
process.on('exit', () => {
  for (const d of temps) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3 })
    } catch {}
  }
})

/** A temp git repo with one session dir <repo>/.git/truss/<sid> and its own empty transcripts root. */
function mkWorld() {
  const repo = flat(realpathSync(mkRepo({ config: CONFIG })))
  const sid = `sess-${randomUUID().slice(0, 8)}`
  const dir = `${repo}/.git/truss/${sid}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  writeFileSync(`${dir}/decisions.md`, '')
  writePlan(dir, planObj([crew('crew-a'), crew('crew-b')]))
  const troot = flat(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'pm029-tr-'))))
  temps.push(troot)
  return { repo, dir, troot }
}

/** Runs `factory <command> --repo R --dir D <args>` as a real process. */
const fx = (w, command, args = []) => runCli(FACTORY, command, ['--repo', w.repo, '--dir', w.dir, ...args], w.repo, { TRUSS_TRANSCRIPTS_ROOT: w.troot })

/** escalate with exit 0 expected; returns the printed object. */
function raise(w, kind, crew, extra = []) {
  const r = fx(w, 'escalate', ['--kind', kind, '--title', `title of ${kind}`, '--crew', crew, ...extra])
  assert.equal(r.status, 0, `escalate ${kind}: ${r.stdout} ${r.stderr}`)
  return assertOneLine(r)
}

t('only the linked crew waits on a client scope-change item', () => {
  const w = mkWorld()
  const sc = raise(w, 'scope-change', 'crew-a', ['--blocking'])
  const a = fx(w, 'admit', ['--slug', 'crew-a'])
  const aj = assertOneLine(a)
  assert.equal(aj.admitted, false, a.stdout)
  assert.ok(String(aj.why).includes(`awaiting client: ${sc.id}`), a.stdout)
  const b = fx(w, 'admit', ['--slug', 'crew-b'])
  const bj = assertOneLine(b)
  assert.ok(!String(bj.why ?? '').includes('awaiting client'), b.stdout)
  assert.ok(!String(bj.why ?? '').includes(sc.id), b.stdout)
})

t('the program manager cannot resolve a client scope-change item', () => {
  const w = mkWorld()
  const sc = raise(w, 'scope-change', 'crew-a', ['--blocking'])
  const r = fx(w, 'resolve', [sc.id, '--decision', 'answer', '--by', 'pm', '--code', sc.code])
  assert.notEqual(r.status, 0, `${r.stdout} ${r.stderr}`)
  assert.match(r.stdout, /scope-change is resolved by the client, not by pm/)
  const open = fx(w, 'inbox', ['--kind', 'scope-change', '--crew', 'crew-a'])
  const row = assertOneLine(open).items.find((i) => i.id === sc.id)
  assert.equal(row.state, 'open')
  // positive control: a pm-question item is the program manager's to resolve
  const pq = raise(w, 'pm-question', 'crew-a', ['--blocking'])
  const ok = fx(w, 'resolve', [pq.id, '--decision', 'answer', '--by', 'pm', '--code', pq.code, '--note', 'dollars, not cents'])
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
  const list = fx(w, 'inbox', ['--kind', 'pm-question', '--crew', 'crew-a'])
  const prow = assertOneLine(list).items.find((i) => i.id === pq.id)
  assert.equal(prow.state, 'resolved')
  assert.equal(prow.by, 'pm')
  assert.equal(prow.note, 'dollars, not cents')
})

t('decision-checkpoint prints a truss-status line that confirms the checkpoint', () => {
  const w = mkWorld()
  const r = fx(w, 'decision-checkpoint', ['--crew', 'crew-a', '--status-line'])
  assert.equal(r.status, 0, `${r.stdout} ${r.stderr}`)
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('truss-status: '))
  assert.ok(lines.length > 0, `no truss-status line: ${r.stdout}`)
  const s = JSON.parse(lines[lines.length - 1].slice('truss-status: '.length))
  assert.equal(s.checkpoint, true, JSON.stringify(s))
})

// ---------------------------------------------------------------- stage.js, stubbed agents (the stage tester's cases)
// pattern: crew-knowledge.check.ts exec(); the runner stub also answers escalate, inbox and resolve. Prompts are what the stubs received.

const STAGE = `${REAL_PLUGIN}/workflows/stage.js`
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
  const agent = async (prompt, opts = {}) => {
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
      const branch = flag('branch')
      const key = cmd === 'check' ? `check:${expect}` : cmd === 'integrate' ? `integrate:${branch}` : cmd
      const name = `runner:${slug}:${key}`
      call.runner = { cmd, slug, expect, branch, key, name, rest: m[2] }
      const n = (counters[name] = (counters[name] ?? -1) + 1)
      let out = o.runner ? await o.runner({ cmd, key, slug, expect, branch, n, prompt, call, calls }) : undefined
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
  }
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
const ASK = done('feat/b', { marker: 'QUESTION', text: 'Should the export include archived items?' })
const resOf = (r, slug = 'a') => r.result.find((x) => x.slug === slug)
const callOf = (r, label) => r.calls.find((c) => c.label === label)
const runnerCalls = (r, cmd) => r.calls.filter((c) => c.runner && c.runner.cmd === cmd)
const has = (s, sub) => assert.ok(s.includes(sub), `missing ${JSON.stringify(sub)} in:\n${s.slice(0, 3000)}`)
const ITEM_ID = 'E-20261112-0a1b2c'
const REF = 'crew-call:a:build-export'
const NOTE = 'Include archived items, flagged; the PM ruled it in scope.'
// the factory stub for the item: escalate opens it, inbox shows it open until `state` says resolved with the PM's note
const itemRunner = (kind, state = 'open') => async ({ cmd, slug, calls }) => {
  const opened = calls.some((c) => c.runner && c.runner.cmd === 'escalate')
  if (cmd === 'escalate') return rj({ id: ITEM_ID, kind, deduped: state !== 'open', code: state === 'open' ? 'XK3P9Q' : '', notified: null })
  if (cmd !== 'inbox') return undefined
  const row = { id: ITEM_ID, ts: '2026-11-12T12:30:00.000Z', kind, session: 'sess-1', crews: [slug], ref: REF, blocking: true, title: 'Product call for a', state, applied: false }
  const seen = opened || state === 'resolved'
  return rj({ items: seen ? [state === 'resolved' ? { ...row, decision: 'answer', by: 'pm', note: NOTE } : row] : [], open: seen && state === 'open' ? 1 : 0 })
}

t('an in-scope escalated product call opens a program manager inbox item', async () => {
  const labels = labelsOf('a', { 'a-builder': ASK, 'a-po': 'PO: ESCALATE\nThe export rule is in scope but the requirements do not settle it.' })
  const r = await runStages([entryOf('a')], { labels, runner: itemRunner('pm-question') })
  const esc = runnerCalls(r, 'escalate')
  assert.equal(esc.length, 1, `one escalate call, not a Stop QUESTION with no item; result ${JSON.stringify(r.result).slice(0, 500)}`)
  const p = esc[0].prompt
  assert.match(p, /--kind(?:\s+|=)pm-question\b/)
  assert.match(p, /--crew(?:\s+|=)a\b/)
  assert.match(p, /--blocking\b/)
  assert.match(p, /--ref(?:\s+|=)'?crew-call:a:build-export\b/)
  has(p, 'Should the export include archived items?')
  const s = resOf(r)
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.notEqual(s.tag, 'QUESTION', JSON.stringify(s))
  has(s.text, ITEM_ID)
  assert.equal(runnerCalls(r, 'resolve').length, 0, 'the crew never resolves an item')
  assert.equal(runnerCalls(r, 'crew-decision').length, 0, 'nothing is logged as decided while the item is open')
})

t('the asking task waits while the item is open and resumes with the program manager answer', async () => {
  // pass 1: the item is open, so the asking task gets no answer and nothing after it runs
  const labels = labelsOf('a', { 'a-builder': ASK, 'a-po': 'PO: ESCALATE\nThe export rule is in scope but the requirements do not settle it.' })
  const first = await runStages([entryOf('a')], { labels, runner: itemRunner('pm-question') })
  const s1 = resOf(first)
  assert.equal(s1.state, 'stopped', JSON.stringify(s1))
  has(s1.text, ITEM_ID)
  assert.ok(!first.labels.includes('a-builder-2'), `the asking member was not re-spawned: ${first.labels.join(',')}`)
  assert.ok(!first.labels.includes('a-writer'), 'no task after the asking one ran')
  assert.ok(!first.labels.includes('a-qc'), 'the crew did not reach QC')
  assert.equal(runnerCalls(first, 'crew-decision').length, 0)
  const reads = runnerCalls(first, 'inbox')
  assert.ok(reads.length >= 1, 'the wait is a re-read of the item through a factory runner call')
  assert.match(reads[0].prompt, /--kind(?:\s+|=)pm-question\b/)
  assert.match(reads[0].prompt, /--crew(?:\s+|=)a\b/)
  // pass 2: a resumed stage reads the item as resolved, with the program manager's note
  const again = { 'a-builder': done('feat/b2'), 'a-builder-2': done('feat/b3'), 'a-po': 'PO: ESCALATE\nsame question' }
  const second = await runStages([entryOf('a', { resume: 'stale', tasks: [TT, TF, TD], done: ['write-tests'] })], { labels: labelsOf('a', again), runner: itemRunner('pm-question', 'resolved') })
  const s2 = resOf(second)
  assert.equal(s2.state, 'passed', JSON.stringify(s2))
  const builders = second.calls.filter((c) => /^a-builder(-\d+)?$/.test(String(c.label)))
  assert.ok(builders.length >= 1 && builders.every((c) => c.prompt.includes(NOTE)), `the asking member's prompt carries the program manager's note; ${builders.length} builder prompts`)
  const d = runnerCalls(second, 'crew-decision')
  assert.equal(d.length, 1, 'the call is logged once')
  has(d[0].prompt, '--by program-manager')
  has(d[0].prompt, '--task build-export')
  has(d[0].prompt, 'Include archived items, flagged')
  assert.equal(runnerCalls(second, 'resolve').length, 0, 'the crew never resolves an item')
})

t('a product call that contradicts approved scope or a client ruling opens a client scope-change item', async () => {
  const reply = 'PO: SCOPE-CHANGE\nArchived items are outside the approved scope, which says live items only.'
  const labels = { ...labelsOf('a', { 'a-builder': ASK, 'a-po': reply }), ...labelsOf('b') }
  const r = await runStages([entryOf('a'), entryOf('b')], { labels, runner: itemRunner('scope-change') })
  has(callOf(r, 'a-po').prompt, 'PO: SCOPE-CHANGE')
  const esc = runnerCalls(r, 'escalate')
  assert.equal(esc.length, 1, `one escalate call; result ${JSON.stringify(r.result).slice(0, 500)}`)
  const p = esc[0].prompt
  assert.match(p, /--kind(?:\s+|=)scope-change\b/)
  assert.doesNotMatch(p, /--kind(?:\s+|=)pm-question\b/)
  assert.match(p, /--crew(?:\s+|=)a\b/)
  assert.match(p, /--blocking\b/)
  assert.match(p, /--ref(?:\s+|=)'?crew-call:a:build-export\b/)
  const s = resOf(r)
  assert.equal(s.state, 'stopped', JSON.stringify(s))
  assert.notEqual(s.tag, 'QUESTION', JSON.stringify(s))
  has(s.text, ITEM_ID)
  assert.equal(runnerCalls(r, 'resolve').length, 0, 'the program manager never resolves it, and neither does the crew')
  assert.equal(runnerCalls(r, 'crew-decision').filter((c) => c.runner.slug === 'a').length, 0)
  assert.equal(resOf(r, 'b').state, 'passed', 'only the linked crew waits; every other crew runs')
})

t('a product call with no scope conflict is logged as a crew decision and never waits', async () => {
  const labels = labelsOf('a', { 'a-builder': ASK, 'a-builder-2': done('feat/b2'), 'a-po': 'PO: DECIDE\nInclude archived items, flagged.\nReason: the requirements say export is complete.' })
  const r = await runStages([entryOf('a')], { labels, runner: itemRunner('pm-question') })
  has(callOf(r, 'a-po').prompt, 'PO: SCOPE-CHANGE')
  assert.equal(resOf(r).state, 'passed', JSON.stringify(resOf(r)).slice(0, 500))
  assert.equal(runnerCalls(r, 'escalate').length, 0, 'a call that touches no scope line opens no item')
  assert.equal(runnerCalls(r, 'inbox').length, 0, 'and re-reads none')
  const d = runnerCalls(r, 'crew-decision')
  assert.equal(d.length, 1, 'one crew-decision call')
  has(d[0].prompt, '--by product-owner')
  has(d[0].prompt, '--task build-export')
  has(callOf(r, 'a-builder-2').prompt, 'Include archived items, flagged.')
})
