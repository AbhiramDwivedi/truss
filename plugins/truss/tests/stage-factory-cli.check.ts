// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0033 review fix: the real CLI contract between workflows/stage.js and bin/factory.ts.
//   stage.js builds `node factory.ts <command> ... --dir D --repo R --status-line` for crew-decision, decision-replies and decisions.
//   This file runs stage.js with a runner that executes that exact argv (no shell, no stubs) against the real factory.ts, and checks
//   stage.js reads the real output shapes: crew-decision {id}; decision-replies an array; decisions {decisions:[...]}.
// Run with: node --test tests/stage-factory-cli.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { mkRepo, mkTrussDir, readEvents, runCli, validateEvent } from './fixtures/workflow-run/harness.ts'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const STAGE = `${PLUGIN}/workflows/stage.js`
const FACTORY = `${PLUGIN}/bin/factory.ts`
const t = (name, fn) => test(name, { timeout: 120000 }, fn)

const ROLES = {
  planner: { agentType: 'truss:planning-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  tester: { agentType: 'proj:tester', model: 'sonnet', effort: 'medium', isolation: 'worktree' },
  builder: { agentType: 'proj:builder', model: 'sonnet', effort: 'low', isolation: 'worktree' },
  resolver: { agentType: 'proj:resolver', model: 'sonnet', effort: 'medium', isolation: 'none' },
  writer: { agentType: 'truss:writer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  rca: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
  stress: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'worktree' },
  qc: { agentType: 'truss:qc-engineer', model: 'opus', effort: 'medium', isolation: 'none' },
  runner: { agentType: 'general-purpose', model: 'sonnet', effort: 'low', isolation: 'none' },
  po: { agentType: 'general-purpose', model: 'opus', effort: 'medium', isolation: 'none' },
}

// A shell line as the runner would parse it, into argv: bare words, and single-quoted words with ' written as '\'' (stage.js sh()).
function words(line) {
  const out = []
  let cur = ''
  let has = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") {
      has = true
      i++
      while (i < line.length && line[i] !== "'") cur += line[i++]
    } else if (c === '\\' && line[i + 1] === "'") {
      cur += "'"
      has = true
      i++
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += c
      has = true
    }
  }
  if (has || cur) out.push(cur)
  return out
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const tick = () => new Promise((r) => setImmediate(r))
const HEAD = 'a1'.repeat(20)
const BASE = 'd4'.repeat(20)
const PATCH = 'e5'.repeat(20)
const PASS = `VERDICT: PASS\n\n## Proof checked\nHead: ${HEAD}\nPatch: ${PATCH}\n`
const rj = (obj, exit = 0) => ({ exit, stdout: JSON.stringify(obj), status: '' })

// Runs stage.js. Runner calls for crew-decision, decision-replies and decisions run the real factory.ts with the argv in the prompt;
// the rest are answered like a green run. hook(cmd, argv, real) can act after a real command (to make the main session reply).
async function runStage(dir, repo, crews, labels, hook = () => {}) {
  const body = readFileSync(STAGE, 'utf8').replace(/^\s*export\s+const\s+meta\b/m, 'const meta')
  const calls = []
  const real = []
  const agent = async (prompt, opts = {}) => {
    const call = { prompt, opts, label: opts.label }
    calls.push(call)
    await tick()
    if (/-runner(-\d+)?$/.test(String(opts.label))) {
      const line = prompt.split('\n').reverse().find((l) => l.startsWith('node '))
      const argv = words(line)
      const cmd = [...line.matchAll(/factory\.ts\s+(\S+)/g)].pop()[1]
      const expect = (line.match(/--expect\s+(\S+)/) || [])[1]
      if (['crew-decision', 'decision-replies', 'decision-ack', 'decision-checkpoint', 'crew-learned', 'decisions'].includes(cmd)) {
        assert.equal(argv[1], FACTORY.replace(/\\/g, '/'), 'the real factory.ts')
        assert.deepEqual(argv.slice(-5), ['--dir', dir, '--repo', repo, '--status-line'], `${cmd}: --dir, --repo and --status-line last`)
        const r = spawnSync(process.execPath, argv.slice(1), { encoding: 'utf8', env: { ...process.env, TRUSS_SAMPLE: undefined } })
        const lines = r.stdout.split('\n').filter(Boolean)
        const status = [...lines].reverse().find((l) => l.startsWith('truss-status: ')) ?? ''
        real.push({ cmd, argv, status: r.status, stdout: r.stdout, stderr: r.stderr })
        await hook(cmd, argv, real)
        return { exit: r.status, stdout: r.stdout, status }
      }
      return cmd === 'admit' ? rj({ admitted: true, parallelism: 4, running: 0, freeMB: 8000, minFreeMB: 2048 }) : cmd === 'reap' ? rj({ reaped: [], skipped: [] }) : cmd === 'check' ? rj(expect === 'red' ? { ok: true } : { ok: true, head: HEAD }) : cmd === 'owns-check' ? rj({ ok: true, outside: [] }) : cmd === 'tests-check' ? rj({ ok: true, tests: [] }) : rj({ merged: true })
    }
    if (!Object.hasOwn(labels, opts.label)) throw new Error(`unscripted label: ${opts.label}`)
    const h = labels[opts.label]
    const v = typeof h === 'function' ? await h(call, calls) : h
    await tick()
    return v === null || v === undefined ? v : structuredClone(v)
  }
  const parallel = async (thunks) => Promise.all(thunks.map(async (th) => { try { return await (typeof th === 'function' ? th() : th) } catch { return null } }))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (item, i) => { try { let prev = item; for (const st of stages) prev = await st(prev, item, i); return prev } catch { return null } }))
  const args = {
    truss: {
      kind: 'stage', dir, repo, plugin: PLUGIN, target: 'main', reworkAllowance: 2, roles: ROLES, scriptPath: STAGE, crews,
      personas: { 'product-owner': { agentType: 'product-owner', model: 'opus', effort: 'medium', file: `${repo}/.claude/agents/product-owner.md`, description: 'Judges the product fit', readOnly: true, loaded: true } },
    },
  }
  const result = await new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'allowance', body)(agent, parallel, pipeline, () => {}, () => {}, structuredClone(args), {})
  return { result, calls, real }
}

const done = (branch, extra = {}) => ({ task: 'whatever', marker: 'DONE', branch, commit: 'c0'.repeat(20), proof: 'PROOF-' + branch, text: 'finished ' + branch, ...extra })
const TT = { name: 'write-tests', role: 'tester', effort: 'medium', persona: null, files: ['tests/a.check.ts'], reads: [], brief: 'BRIEF-TT', after: [] }
const TF = { name: 'build-ui', role: 'builder', effort: 'low', persona: null, files: ['src/ui/a.ts'], reads: [], brief: 'BRIEF-TF', after: ['write-tests'] }
const OLD = {
  slug: 'a', stage: 1, goalFile: '/proj/.truss/goals/a.md', goal: 'GOAL-TEXT', owns: ['src/**', 'tests/*.ts'], acceptanceTest: 'node --test tests/a.check.ts', highImpact: [], stressTest: false,
  scope: 'SCOPE: build a', worktree: '/wt/a', branch: 'truss/a', base: BASE, architecture: '/proj/docs/ARCH.md', adrs: [], resume: null, tasks: [], done: [], answers: [], spent: 0, labelFrom: {},
}
const ITEM = { kind: 'feature', text: 'export button lives in ExportMenu', source: 'src/ui/a.ts:10' }
const ASK = done('feat/b', { marker: 'QUESTION', text: 'Should the export include archived items? (--all or not)' })
const labels = (o = {}) => ({ 'a-planner': { tasks: [TT, TF], stop: null }, 'a-tester': done('feat/t'), 'a-builder': ASK, 'a-builder-2': done('feat/b2', { learned: [ITEM] }), 'a-po': 'PO: DECIDE\nInclude archived items.\nReason: the requirements say so.', 'a-writer': done('feat/k'), 'a-qc': PASS, ...o })

t('cli 1: crew-decision, decisions and decision-replies run on the real factory.ts with stage.js argv; stage.js reads {id}, {decisions} and the array', async () => {
  const dir = mkTrussDir()
  const repo = mkRepo()
  // another crew's call and its main-session ack, made through the real CLI before this crew starts
  const other = runCli(FACTORY, 'crew-decision', ['--crew', 'b', '--task', 'build-api', '--question', 'Do exports include archived items?', '--answer', 'No, archived items are excluded', '--by', 'product-owner', '--dir', dir, '--repo', repo])
  assert.equal(other.status, 0, other.stderr)
  assert.deepEqual(other.json, { id: 'd-b-1' })
  const ack = runCli(FACTORY, 'decision-reply', ['d-b-1', 'ack', '--dir', dir, '--repo', repo])
  assert.equal(ack.status, 0, ack.stderr)

  const hook = (cmd, argv, real) => {
    if (cmd !== 'crew-decision') return
    // the main session overrules this crew's call, through the real CLI, after the crew logged it
    const mine = JSON.parse(real.at(-1).stdout.split('\n')[0]).id
    const r = runCli(FACTORY, 'decision-reply', [mine, 'change', '--note', 'Exclude archived items.', '--dir', dir, '--repo', repo])
    assert.equal(r.status, 0, r.stderr)
  }
  const r = await runStage(dir, repo, [OLD], labels({ 'a-builder-3': done('feat/b3') }), hook)

  // every real command exited 0 and printed its status line last
  for (const x of r.real) {
    assert.equal(x.status, 0, `${x.cmd}: ${x.stderr}${x.stdout}`)
    assert.ok(x.stdout.trimEnd().split('\n').at(-1).startsWith('truss-status: '), `${x.cmd} prints the status line last`)
  }
  const made = r.real.filter((x) => x.cmd === 'crew-decision')
  assert.equal(made.length, 1)
  assert.deepEqual(JSON.parse(made[0].stdout.split('\n')[0]), { id: 'd-a-1' })
  // flags stage.js sent: free text goes in the --flag=value form, so a value that starts with -- cannot be read as a flag
  assert.ok(made[0].argv.includes('--question=Should the export include archived items? (--all or not)'), made[0].argv.join(' | '))
  assert.ok(made[0].argv.includes('--answer=Include archived items.'), made[0].argv.join(' | '))

  // decisions: {decisions:[...]}; the product owner's brief carries crew b's call and its reply, and stage.js read the object
  const listed = r.real.find((x) => x.cmd === 'decisions')
  assert.ok(listed, 'stage.js called factory decisions')
  const shape = JSON.parse(listed.stdout.split('\n')[0])
  assert.ok(Array.isArray(shape.decisions))
  const po = r.calls.find((c) => c.label === 'a-po').prompt
  assert.ok(po.includes('Do exports include archived items?') && po.includes('No, archived items are excluded'), po)
  assert.ok(/"?reply"?:\s*"?ack/.test(po) || po.includes('ack'), 'the reply status of the other crew call')

  // decision-replies: an array; stage.js took the change, re-ran the member, and the result carries the real id
  const polled = r.real.filter((x) => x.cmd === 'decision-replies')
  assert.ok(polled.length >= 1)
  assert.ok(polled.some((x) => Array.isArray(JSON.parse(x.stdout.split('\n')[0])) && JSON.parse(x.stdout.split('\n')[0]).some((y) => y.id === 'd-a-1' && y.reply === 'change')), 'a real poll returned the change')
  const mine = r.result.find((x) => x.slug === 'a')
  assert.equal(mine.state, 'passed', JSON.stringify(mine).slice(0, 600))
  assert.deepEqual(mine.decisions.map((d) => [d.id, d.reply]), [['d-a-1', 'change']])
  assert.ok(r.calls.some((c) => /^a-builder/.test(c.label) && c.prompt.includes('Main session changed product call d-a-1: Exclude archived items.')), `labels ${r.calls.map((c) => c.label)}`)

  // the reply was acked only after it was applied: the real ack took it, so the late read after QC finds nothing, and there is no late field
  const acked = r.real.filter((x) => x.cmd === 'decision-ack')
  assert.equal(acked.length, 1)
  assert.ok(acked[0].argv.includes('--ids') && acked[0].argv.includes('d-a-1'), acked[0].argv.join(' '))
  assert.deepEqual(JSON.parse(acked[0].stdout.split('\n')[0]), { acked: ['d-a-1'], already: [] })
  assert.equal(polled.length, 2, 'the checkpoint read and the late read')
  assert.deepEqual(JSON.parse(polled[1].stdout.split('\n')[0]), [])
  assert.equal(mine.late, undefined)
  assert.equal(r.real.filter((x) => x.cmd === 'decision-checkpoint').length, 1)
  // the learned item of the re-run member went to the crew store
  const learned = r.real.filter((x) => x.cmd === 'crew-learned')
  assert.equal(learned.length, 1)
  assert.ok(learned[0].argv.some((a) => a.startsWith('--add=') && a.includes('export button lives in ExportMenu')), learned[0].argv.join(' | '))
  assert.ok(learned[0].argv.includes('--slug') && learned[0].argv.includes('a'))

  // the events factory wrote carry the contract fields (docs/events.schema.json is checked in tests/events-schema.check.ts)
  const ev = readEvents(dir)
  for (const e of ev) assert.deepEqual(validateEvent(e), [], JSON.stringify(e))
  assert.ok(ev.some((e) => e.event === 'crew-decision' && e.id === 'd-a-1' && e.by === 'product-owner'))
  assert.ok(ev.some((e) => e.event === 'decision-reply' && e.id === 'd-a-1' && e.reply === 'change' && e.note === 'Exclude archived items.'))
})

t('cli 2: with no crew decisions yet, the real decisions output {"decisions":[]} reads as none in the product owner brief', async () => {
  const dir = mkTrussDir()
  const repo = mkRepo()
  const r = await runStage(dir, repo, [OLD], labels())
  assert.ok(r.real.length > 0, `no real command ran; labels ${r.calls.map((c) => c.label)}; result ${JSON.stringify(r.result).slice(0, 800)}`)
  const listed = r.real.find((x) => x.cmd === 'decisions')
  assert.equal(listed.stdout.split('\n')[0], '{"decisions":[]}')
  const po = r.calls.find((c) => c.label === 'a-po').prompt
  assert.match(po, /Product calls of this run so far[^\n]*: none/)
})
