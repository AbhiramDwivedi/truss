// @ts-nocheck
// ADR-0035: the merge gate that stops a crew loosening its own knowledge lint through .claude/truss.json. Through the real CLI:
// land (solo, lean), finish (full), gated-merge, knowledge-config-gate (before a PR) and mark-merged (a raw merge).
// Run with: node --test plugins/truss/tests/knowledge-config-gate.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { cli, crewWorld, git, mk, mkWorld, say } from './fixtures/ltc/harness.ts'

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

// ---- helpers for the merged-result, gated-merge, mark-merged and forgery cases ----

const prettyCfg = (w, rule) => `{\n  "merge": "sequential",\n  "target": "main",\n  "notify": ${JSON.stringify(baseCfg(w).notify)},\n  "knowledgeBudgets": {\n    "rule": ${rule}\n  }\n\n\n\n\n\n}\n`
const commitMain = (w, text, msg = 'main edits the config') => {
  writeFileSync(`${w.repo}/${CFG}`, text)
  git(w.repo, ['add', CFG])
  git(w.repo, ['commit', '-q', '-m', msg])
}
const prettyMain = (w, rule = 40) => commitMain(w, prettyCfg(w, rule), 'pretty config')
const tipOf = (w, b) => git(w.repo, ['rev-parse', `refs/heads/${b}`])
const integration = (w) => {
  git(w.repo, ['branch', 'integration', 'main'])
  const at = `${mk('gate-int-')}/int`
  git(w.repo, ['worktree', 'add', '-q', at, 'integration'])
  return at
}
const planStatus = (w, slug) => JSON.parse(readFileSync(`${w.dir}/plan.json`, 'utf8')).crews.find((c) => c.slug === slug).status
const gitIn = (cwd, args, input) => {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', windowsHide: true })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
const rows = (cwd, tree) => git(cwd, ['ls-tree', tree]).split('\n').filter(Boolean)
const mktree = (cwd, list) => gitIn(cwd, ['mktree'], list.join('\n') + '\n')
// The crew branch gets one more commit whose tree `edit` rewrites. Trees are built as objects, so no symlink is ever made on disk and no
// case-folding file system is involved: the case is the same on every platform, and none of these needs a skip.
function forge(cw, edit) {
  const root = rows(cw.wt, 'HEAD')
  const dotRow = root.find((r) => r.endsWith('\t.claude'))
  const dotSha = dotRow.split(/\s+/)[2]
  const dot = rows(cw.wt, dotSha)
  const blob = git(cw.wt, ['rev-parse', `HEAD:${CFG}`])
  const out = edit({ root, dot, blob, dotRow })
  const tree = mktree(cw.wt, out.root ?? root.map((r) => (r === dotRow ? `040000 tree ${mktree(cw.wt, out.dot)}\t.claude` : r)))
  const sha = gitIn(cw.wt, ['commit-tree', tree, '-p', 'HEAD', '-m', 'forge'])
  git(cw.wt, ['update-ref', 'refs/heads/truss-a', sha])
  return sha
}
const withoutCfg = (dot) => dot.filter((r) => !r.endsWith('\ttruss.json'))
const refusedForge = (cw, sha, re) => {
  const r = cw.land()
  assert.equal(r.status, 1, say(r))
  assert.match(String(r.json.why), re, say(r))
  assert.notEqual(tipOf(cw.w, 'main'), sha, 'main did not move')
  assert.equal(cw.merged(), false)
}

// ---- item 1: the result that lands ----

test('config gate 13: a clean three-way merge whose result loosens the moved target is refused, though the crew passed against its fork', () => {
  const w = mkWorld()
  prettyMain(w)
  const lastLine = prettyCfg(w, 40).trimEnd().lastIndexOf('}')
  const pretty = prettyCfg(w, 40)
  const crewText = `${pretty.slice(0, lastLine)},\n"knowledgeBudgets": { "rule": 35 }\n}\n`
  const cw = crewWorld(w, { process: 'solo', files: { [CFG]: crewText } })
  commitMain(w, prettyCfg(w, 30), 'client tightens rule to 30')
  const old = tipOf(w, 'main')
  const r = cw.land()
  refused(cw, r, LOOSENED)
  assert.match(r.json.why, /knowledgeBudgets\.rule raised from 30 to 35/)
  assert.equal(tipOf(w, 'main'), old, 'the target did not move')
})

test('config gate 14: a crew that merged main after main itself raised a budget still lands, and so does one that did not merge main', () => {
  const w = mkWorld()
  prettyMain(w)
  const cw = crewWorld(w, { process: 'solo' })
  commitMain(w, prettyCfg(w, 50), 'client raises rule to 50 on main')
  git(cw.wt, ['merge', '-q', '--no-edit', 'main'])
  landed(cw, cw.land())
  assert.equal(git(w.repo, ['show', `main:${CFG}`]).includes('"rule": 50'), true)
  const w2 = mkWorld()
  prettyMain(w2)
  const cw2 = crewWorld(w2, { process: 'solo' })
  commitMain(w2, prettyCfg(w2, 50), 'client raises rule to 50 on main')
  landed(cw2, cw2.land())
})

// ---- item 2: gated-merge, knowledge-config-gate before the PR, mark-merged ----

test('config gate 15: gated-merge --ff-only moves the target when clean, and refuses a loosening or a non-fast-forward without moving it', () => {
  const w = mkWorld()
  crewWorld(w, { process: 'solo' })
  const ok = cli(w, 'gated-merge', ['--branch', 'truss-a', '--ff-only'])
  assert.equal(ok.status, 0, say(ok))
  assert.equal(ok.json.merged, true)
  assert.equal(tipOf(w, 'main'), tipOf(w, 'truss-a'))

  const w2 = mkWorld()
  crewWorld(w2, { process: 'solo', files: { [CFG]: withCfg(w2, { knowledgeBudgets: { rule: 500 } }) } })
  const before = tipOf(w2, 'main')
  const no = cli(w2, 'gated-merge', ['--branch', 'truss-a', '--ff-only'])
  assert.equal(no.status, 1, say(no))
  assert.equal(no.json.merged, false)
  assert.match(no.json.why, LOOSENED)
  assert.equal(tipOf(w2, 'main'), before)

  const w3 = mkWorld()
  crewWorld(w3, { process: 'solo' })
  commitMain(w3, withCfg(w3, { knowledgeBudgets: { rule: 39 } }))
  const behind = tipOf(w3, 'main')
  const nf = cli(w3, 'gated-merge', ['--branch', 'truss-a', '--ff-only'])
  assert.equal(nf.status, 1, say(nf))
  assert.match(nf.json.why, /not a fast-forward/)
  assert.equal(tipOf(w3, 'main'), behind)
})

test('config gate 16: gated-merge makes the --no-ff merge into an integration branch, and on a loosening leaves no merge behind', () => {
  const w = mkWorld()
  const at = integration(w)
  crewWorld(w, { process: 'solo' })
  const ok = cli(w, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(ok.status, 0, say(ok))
  assert.equal(git(at, ['rev-list', '--merges', '--count', 'HEAD~1..HEAD']), '1', 'a merge commit landed')
  gitIn(at, ['merge-base', '--is-ancestor', 'refs/heads/truss-a', 'HEAD'])

  const w2 = mkWorld()
  const at2 = integration(w2)
  crewWorld(w2, { process: 'solo', files: { [CFG]: withCfg(w2, { rulesDir: 'elsewhere' }) } })
  const before = tipOf(w2, 'integration')
  const no = cli(w2, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(no.status, 1, say(no))
  assert.match(no.json.why, LOOSENED)
  assert.equal(tipOf(w2, 'integration'), before)
  assert.equal(git(at2, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true), '', 'no merge left in progress')
})

test('config gate 17: a conflict is left to resolve and --continue judges the resolved tree; a resolution that loosens is refused and aborted', () => {
  const w = mkWorld()
  const at = integration(w)
  const cw = crewWorld(w, { process: 'solo', files: { 'src/shared.txt': 'crew\n' } })
  mkdirSync(`${at}/src`, { recursive: true })
  const c = (text) => {
    writeFileSync(`${at}/src/shared.txt`, text)
    git(at, ['add', 'src/shared.txt'])
  }
  c('integration\n')
  git(at, ['commit', '-q', '-m', 'integration side'])
  const before = tipOf(w, 'integration')
  const first = cli(w, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(first.status, 1, say(first))
  assert.equal(first.json.conflict, true, say(first))
  assert.deepEqual(first.json.files, ['src/shared.txt'])
  c('resolved\n')
  writeFileSync(`${at}/${CFG}`, withCfg(w, { rulesDir: 'elsewhere' }))
  git(at, ['add', CFG])
  const bad = cli(w, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration', '--continue'])
  assert.equal(bad.status, 1, say(bad))
  assert.match(bad.json.why, LOOSENED)
  assert.equal(tipOf(w, 'integration'), before)
  assert.equal(git(at, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true), '', 'the refused merge was aborted')
  const again = cli(w, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(again.json.conflict, true, say(again))
  c('resolved\n')
  const done = cli(w, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration', '--continue'])
  assert.equal(done.status, 0, say(done))
  assert.equal(done.json.merged, true)
  gitIn(at, ['merge-base', '--is-ancestor', cw.head, 'HEAD'])
})

test('config gate 18: knowledge-config-gate refuses an integration branch that loosens the target before its PR', () => {
  const w = mkWorld()
  const at = integration(w)
  writeFileSync(`${at}/${CFG}`, withCfg(w, { knowledgeBudgets: { doc: 900 } }))
  git(at, ['add', CFG])
  git(at, ['commit', '-q', '-m', 'raise on integration'])
  const r = cli(w, 'knowledge-config-gate', ['--branch', 'integration'])
  assert.equal(r.status, 1, say(r))
  assert.match(r.json.why, LOOSENED)
})

test('config gate 19: mark-merged refuses a raw merge of a loosening, by --no-ff and by fast-forward, and leaves the crew unmerged', () => {
  const w = mkWorld()
  crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { rule: 500 } }) } })
  git(w.repo, ['merge', '-q', '--no-ff', '--no-edit', 'truss-a'])
  const r = cli(w, 'mark-merged', ['--slug', 'a'])
  assert.equal(r.status, 1, say(r))
  assert.equal(r.json.merged, false)
  assert.match(r.json.why, LOOSENED)
  assert.equal(planStatus(w, 'a'), 'running')

  const w2 = mkWorld()
  crewWorld(w2, { process: 'solo', files: { [CFG]: withCfg(w2, { rulesDir: 'elsewhere' }), 'src/a/later.ts': 'later\n' } })
  git(w2.repo, ['merge', '-q', '--ff-only', 'truss-a'])
  const ff = cli(w2, 'mark-merged', ['--slug', 'a'])
  assert.equal(ff.status, 1, say(ff))
  assert.match(ff.json.why, LOOSENED)
  assert.equal(planStatus(w2, 'a'), 'running')
})

test('config gate 20: mark-merged records a clean raw merge, and refuses when the reflog cannot name the pre-merge tip', () => {
  const w = mkWorld()
  crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { rule: 30 } }) } })
  git(w.repo, ['merge', '-q', '--ff-only', 'truss-a'])
  const ok = cli(w, 'mark-merged', ['--slug', 'a'])
  assert.equal(ok.status, 0, say(ok))
  assert.equal(planStatus(w, 'a'), 'merged')

  const w2 = mkWorld()
  crewWorld(w2, { process: 'solo' })
  git(w2.repo, ['merge', '-q', '--no-ff', '--no-edit', 'truss-a'])
  git(w2.repo, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
  const r = cli(w2, 'mark-merged', ['--slug', 'a'])
  assert.equal(r.status, 1, say(r))
  assert.match(r.json.why, /could not verify/)
  assert.equal(planStatus(w2, 'a'), 'running')
})

// ---- item 3: forgery ----

test('config gate 21: .claude/truss.json as a symlink is refused, whatever the link says', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo' })
  const sha = forge(cw, ({ dot, blob }) => ({ dot: [...withoutCfg(dot), `120000 blob ${blob}\ttruss.json`] }))
  refusedForge(cw, sha, /could not verify.*mode 100644/)
})

test('config gate 22: .claude itself as a symlink is refused, so the file cannot go absent behind it', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo' })
  const sha = forge(cw, ({ root, blob, dotRow }) => ({ root: root.map((r) => (r === dotRow ? `120000 blob ${blob}\t.claude` : r)) }))
  refusedForge(cw, sha, /could not verify.*symlink or a file/)
})

test('config gate 23: a path that equals the config only when case-folded is refused and is not repeated', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo' })
  const sha = forge(cw, ({ dot, blob }) => ({ dot: [...dot, `100644 blob ${blob}\tTRUSS.JSON`] }))
  refusedForge(cw, sha, /could not verify.*differs from it only by case/)
  const w2 = mkWorld()
  const cw2 = crewWorld(w2, { process: 'solo' })
  const sha2 = forge(cw2, ({ root, blob }) => ({ root: [...root, `100644 blob ${blob}\t.CLAUDE`] }))
  refusedForge(cw2, sha2, /could not verify.*differs from it only by case/)
})

test('config gate 24: a replace ref cannot show the gate a commit other than the one that would land', () => {
  const w = mkWorld()
  const cw = crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { rule: 500 } }) } })
  const benign = git(cw.wt, ['commit-tree', `${cw.base}^{tree}`, '-p', cw.base, '-m', 'looks clean'])
  git(cw.wt, ['replace', cw.head, benign])
  refused(cw, cw.land(), LOOSENED)
})

// ---- item 4: single mode, a raise main made itself ----

test('config gate 25: into an integration branch, a crew that forked from or merged a later main is not blamed for a raise main made', () => {
  const later = mkWorld()
  integration(later)
  commitMain(later, withCfg(later, { knowledgeBudgets: { rule: 50 } }), 'client raises on main')
  crewWorld(later, { process: 'solo' })
  const r = cli(later, 'knowledge-config-gate', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(r.status, 0, say(r))
  const m = cli(later, 'gated-merge', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(m.status, 0, say(m))

  const merged = mkWorld()
  integration(merged)
  const cw = crewWorld(merged, { process: 'solo' })
  commitMain(merged, withCfg(merged, { knowledgeBudgets: { rule: 50 } }), 'client raises on main')
  git(cw.wt, ['merge', '-q', '--no-edit', 'main'])
  const r2 = cli(merged, 'knowledge-config-gate', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(r2.status, 0, say(r2))
})

test('config gate 26: into an integration branch, a crew that raises past what main holds is still refused', () => {
  const w = mkWorld()
  integration(w)
  commitMain(w, withCfg(w, { knowledgeBudgets: { rule: 50 } }), 'client raises on main')
  crewWorld(w, { process: 'solo', files: { [CFG]: withCfg(w, { knowledgeBudgets: { rule: 60 } }) } })
  const r = cli(w, 'knowledge-config-gate', ['--branch', 'truss-a', '--into', 'integration'])
  assert.equal(r.status, 1, say(r))
  assert.match(r.json.why, LOOSENED)
})
