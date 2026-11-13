// @ts-nocheck
// truss 0.31.0 speed goal, item 3: no stops on obvious calls. Every gate is graded by risk: dangerous actions (production,
// money, secrets, force-push, deleting delivered work) stay the client's; the rest are the program manager's, each with a
// logged evidence line. The session audit cases live in fixtures/workflow-run/finish.cases.ts (run by factory.check.ts).
// Run with: node --test plugins/truss/tests/obvious-calls-031.check.ts

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN, assertOneLine, crew, flat, mkRepo, planObj, runCli, writePlan } from './fixtures/workflow-run/harness.ts'

const t = (name, fn) => test(name, { timeout: 60000 }, fn)
const FACTORY = `${REAL_PLUGIN}/bin/factory.ts`

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
  const repo = flat(realpathSync(mkRepo({ config: { architecture: 'docs/architecture.md', adr: 'docs/adr' } })))
  const dir = `${repo}/.git/truss/sess-${randomUUID().slice(0, 8)}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${dir}/events.jsonl`, '')
  writeFileSync(`${dir}/decisions.md`, '')
  writePlan(dir, planObj([crew('crew-a')]))
  const troot = flat(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'oc031-tr-'))))
  temps.push(troot)
  return { repo, dir, troot }
}
const fx = (w, command, args = []) => runCli(FACTORY, command, ['--repo', w.repo, '--dir', w.dir, ...args], w.repo, { TRUSS_TRANSCRIPTS_ROOT: w.troot })
function raise(w, kind) {
  const r = fx(w, 'escalate', ['--kind', kind, '--title', `title of ${kind}`, '--crew', 'crew-a'])
  assert.equal(r.status, 0, `escalate ${kind}: ${r.stdout} ${r.stderr}`)
  return assertOneLine(r)
}

// ---------------------------------------------------------------------------------------------------------------
// gate grades in the inbox

t('allowance-spent is the program manager\'s call, resolved with its evidence in --note', () => {
  const w = mkWorld()
  const it = raise(w, 'allowance-spent')
  const bare = fx(w, 'resolve', [it.id, '--decision', 'answer', '--by', 'pm', '--code', it.code])
  assert.notEqual(bare.status, 0, `a pm resolve with no evidence must be refused: ${bare.stdout}`)
  assert.match(bare.stdout, /--note/)
  const ok = fx(w, 'resolve', [it.id, '--decision', 'answer', '--by', 'pm', '--code', it.code, '--note', 're-planned: crew-a from qc-3; the QC FAILs were one flaky timing test'])
  assert.equal(ok.status, 0, `${ok.stdout} ${ok.stderr}`)
  const row = assertOneLine(fx(w, 'inbox', ['--kind', 'allowance-spent'])).items.find((i) => i.id === it.id)
  assert.notEqual(row.state, 'open', JSON.stringify(row))
})

for (const kind of ['scope-change', 'client-trigger', 'long-term-cost', 'budget', 'doctor-bundle', 'push-pr', 'prod-deploy', 'intake-triage', 'client-question']) {
  t(`${kind} stays the client's: resolve --by pm is refused`, () => {
    const w = mkWorld()
    const it = raise(w, kind)
    const r = fx(w, 'resolve', [it.id, '--decision', 'approve', '--by', 'pm', '--code', it.code, '--note', 'evidence'])
    assert.notEqual(r.status, 0, r.stdout)
    assert.match(r.stdout, new RegExp(`${kind} is resolved by the client, not by pm`))
  })
}

// ---------------------------------------------------------------------------------------------------------------
// the program manager and project manager prompts (client ruling 2026-11-13)

const PROMPTS = { 'program manager (skills/run/SKILL.md)': `${REAL_PLUGIN}/skills/run/SKILL.md`, 'project manager (agents/project-manager.md)': `${REAL_PLUGIN}/agents/project-manager.md` }
for (const [who, file] of Object.entries(PROMPTS)) {
  t(`the ${who} prompt says the role is brave, empowered and accountable, and that gates stay gates`, () => {
    const text = readFileSync(file, 'utf8')
    for (const word of ['brave', 'empowered', 'accountable']) assert.match(text, new RegExp(`\\b${word}\\b`), `${who} lacks "${word}"`)
    assert.match(text, /brave, empowered and accountable/, `${who} must say the three words together`)
    assert.match(text, /Gates stay gates/, `${who} must say gates stay gates`)
  })
}

t('the program manager prompt makes a session-audit hit its own call, with the evidence in the waiver line', () => {
  const text = readFileSync(PROMPTS['program manager (skills/run/SKILL.md)'], 'utf8')
  assert.match(text, /audit waived: <run id> \| <evidence>/)
  assert.doesNotMatch(text, /Other `refused` and `audit` entries go to the client/)
})
