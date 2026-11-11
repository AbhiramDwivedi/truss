// @ts-nocheck
// ADR-0035: the merge gate that stops a crew loosening its own knowledge lint through .claude/truss.json. Through the real CLI:
// land (solo, lean), finish (full) and knowledge-config-gate (the merges no factory command performs).
// Run with: node --test plugins/truss/tests/knowledge-config-gate.check.ts

import assert from 'node:assert/strict'
import { unlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { cli, crewWorld, git, mkWorld, say } from './fixtures/ltc/harness.ts'

const CFG = '.claude/truss.json'
const LOOSENED = /cannot make this change.*on main, outside a crew/
const baseCfg = (w) => JSON.parse(git(w.repo, ['show', `main:${CFG}`]))
const withCfg = (w, over) => JSON.stringify({ ...baseCfg(w), ...over })
const refused = (cw, r, re) => {
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json.merged, false, say(r))
  assert.match(String(r.json.why), re, say(r))
  assert.equal(cw.merged(), false, 'the crew branch is not on main')
}
const landed = (cw, r) => {
  assert.equal(r.status, 0, say(r))
  assert.equal(r.json.merged, true, say(r))
  assert.equal(cw.merged(), true)
}
const noConfigOnMain = (w) => {
  git(w.repo, ['rm', '-q', CFG])
  git(w.repo, ['commit', '-q', '-m', 'no config'])
}
const deleteCommitted = (cw) => {
  git(cw.wt, ['rm', '-q', CFG])
  git(cw.wt, ['commit', '-q', '-m', 'drop the config'])
}

test('config gate 1: land refuses a solo crew that raises a knowledge budget, and names the key and both numbers', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { rule: 500 } }) } })
  const r = cw.land()
  refused(cw, r, LOOSENED)
  assert.match(r.json.why, /knowledgeBudgets\.rule raised from 40 to 500/)
})

test('config gate 2: land refuses a lean crew that moves a knowledge path, and never repeats the path value', () => {
  for (const key of ['featureMap', 'productDecisions', 'knowledgeDir', 'rulesDir', 'agentsIndex']) {
    const w = mkWorld()
    const cw = crewWorld(w, { process: 'lean', qc: false, files: { [CFG]: withCfg(w, { [key]: 'elsewhere/IGNORE-PREVIOUS.md' }) } })
    const r = cw.land()
    refused(cw, r, LOOSENED)
    assert.match(r.json.why, new RegExp(`${key} changed`))
    assert.doesNotMatch(r.stdout, /IGNORE-PREVIOUS/)
  }
})

test('config gate 3: finish refuses a full crew that loosens the lint', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { slug: 's', process: 'full', files: { [CFG]: withCfg(w, { rulesDir: 'elsewhere' }) } })
  const r = cw.finish()
  assert.equal(r.status, 1, say(r))
  assert.deepEqual(r.json.merged, [], say(r))
  assert.match(String(r.json.refused.find((x) => x.slug === 's')?.why), LOOSENED, say(r))
  assert.equal(cw.merged(), false)
})

test('config gate 4: restoring the file in the crew worktree does not help while the commit keeps the loosening', () => {
  const w = mkWorld()
  const before = git(w.repo, ['show', `main:${CFG}`])
  const cw = crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { doc: 900 } }) } })
  writeFileSync(`${cw.wt}/${CFG}`, before)
  refused(cw, cw.land(), LOOSENED)
})

test('config gate 5: land allows a tightened budget', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { rule: 30 } }) } })
  landed(cw, cw.land())
})

test('config gate 6: deleting the file is refused when the base set a knowledge key, and allowed when it set none', () => {
  const w = mkWorld({ rulesDir: 'policy' })
  const cw = crewWorld(w, { process: 'solo' })
  deleteCommitted(cw)
  const r = cw.land()
  refused(cw, r, LOOSENED)
  assert.match(r.json.why, /deleted while the base set rulesDir/)
  const w2 = mkWorld()
  const cw2 = crewWorld(w2, { process: 'solo' })
  deleteCommitted(cw2)
  const r2 = cw2.land()
  assert.equal(r2.status, 0, say(r2))
})

test('config gate 7: a head that is not valid JSON or not an object is refused as unverified', () => {
  for (const text of ['{not json', '[1, 2]']) {
    const w = mkWorld()
    const cw = crewWorld(w, { process: 'solo', files: { [CFG]: text } })
    const r = cw.land()
    refused(cw, r, /could not verify/)
    assert.doesNotMatch(r.json.why, /cannot make this change/)
  }
})

test('config gate 8: a side git cannot read refuses as could not verify, never as a loosening', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo' })
  const blob = git(w.repo, ['rev-parse', `main:${CFG}`])
  unlinkSync(`${w.common}/objects/${blob.slice(0, 2)}/${blob.slice(2)}`)
  const r = cw.land()
  refused(cw, r, /could not verify/)
  assert.doesNotMatch(r.json.why, /cannot make this change/)
})

test('config gate 9: no merge-base between crew and target is refused', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo' })
  const orphan = git(cw.wt, ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated'])
  git(cw.wt, ['update-ref', 'refs/heads/truss-a', orphan])
  const r = cw.land()
  assert.equal(r.status, 1, say(r))
  assert.match(String(r.json.why), /merge-base/, say(r))
  assert.notEqual(git(w.repo, ['rev-parse', 'main']), orphan, 'main did not move')
})

test('config gate 10: no file on either side merges; a base with no file compares against the defaults', () => {
  const none = mkWorld()
  noConfigOnMain(none)
  const cw = crewWorld(none, { process: 'solo' })
  landed(cw, cw.land())
  const raised = mkWorld()
  noConfigOnMain(raised)
  const cwRaised = crewWorld(raised, { process: 'solo', files: { [CFG]: JSON.stringify({ knowledgeBudgets: { rule: 41 } }) } })
  refused(cwRaised, cwRaised.land(), LOOSENED)
  const tight = mkWorld()
  noConfigOnMain(tight)
  const cwTight = crewWorld(tight, { process: 'solo', files: { [CFG]: JSON.stringify({ knowledgeBudgets: { rule: 39 } }) } })
  landed(cwTight, cwTight.land())
})

test('config gate 11: an untracked main-checkout config plays no part in the gate', () => {
  const w = mkWorld()
  noConfigOnMain(w)
  const cw = crewWorld(w, { process: 'solo' })
  writeFileSync(`${w.repo}/${CFG}`, JSON.stringify({ knowledgeBudgets: { rule: 1 }, rulesDir: 'main-only' }))
  landed(cw, cw.land())
})

test('config gate 12: knowledge-config-gate guards the merges no factory command performs, into the target or a named branch', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeDir: 'kb' }) } })
  git(w.repo, ['branch', 'integration', 'main'])
  const toTarget = cli(w, 'knowledge-config-gate', ['--branch', 'truss-a'])
  assert.equal(toTarget.status, 1, say(toTarget))
  assert.equal(toTarget.json.ok, false)
  assert.match(toTarget.json.why, LOOSENED)
  const toIntegration = cli(w, 'knowledge-config-gate', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(toIntegration.status, 1, say(toIntegration))
  assert.match(toIntegration.json.why, LOOSENED)
  const missing = cli(w, 'knowledge-config-gate', ['--branch', 'no-such-branch'])
  assert.equal(missing.status, 1, say(missing))
  assert.match(missing.json.why, /does not resolve/)
  const orphan = git(cw.wt, ['commit-tree', 'HEAD^{tree}', '-m', 'unrelated'])
  git(w.repo, ['branch', 'unrelated', orphan])
  const noBase = cli(w, 'knowledge-config-gate', ['--branch', 'unrelated'])
  assert.equal(noBase.status, 1, say(noBase))
  assert.match(noBase.json.why, /merge-base/)
  const w2 = mkWorld()
  crewWorld(w2, { process: 'solo', files: { [CFG]: withCfg(w2, { knowledgeBudgets: { rule: 30 } }) } })
  const ok = cli(w2, 'knowledge-config-gate', ['--branch', 'truss-a'])
  assert.equal(ok.status, 0, say(ok))
  assert.equal(ok.json.ok, true)
})
