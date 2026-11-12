// @ts-nocheck
// truss 0.29.0 R-86, a crew decision that needs the program manager reaches the program manager's inbox and waits.
// Written from the contract before the change (factory-CLI half; the stage.js cases are added below by the stage tester).
//   inbox KINDS row pm-question {by: 'any', blocking: true}; scope-change stays client-only and blocking
//   factory decision-checkpoint --crew <slug> --status-line   -> a truss-status line that carries checkpoint: true
// Run with: node --test tests/pm-calls-029.check.ts

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
