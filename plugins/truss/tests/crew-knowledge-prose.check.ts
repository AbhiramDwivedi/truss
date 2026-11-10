// @ts-nocheck
// ADR-0033, the prose side of crew knowledge capture, crew-level product calls and the product-owner plan
// review. These pin prose only; the mechanics (stage.js, plan.js, factory.ts) have their own checks.
//
// Run with: node --test tests/crew-knowledge-prose.check.ts

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r/g, '')
const RUN = read('../skills/run/SKILL.md')
const FOREMAN = read('../agents/foreman.md')
const WRITER = read('../agents/writer.md')
const QC = read('../agents/qc-engineer.md')
const CHECKING = read('../agents/checking-engineer.md')
const DESIGN = read('../agents/design-engineer.md')
const PLANNER = read('../agents/planning-engineer.md')
const INIT = read('../skills/init/SKILL.md')

test('run skill: the PM no longer decides in-crew product calls as the product owner', () => {
  assert.doesNotMatch(RUN, /decide for it as its product owner/)
  assert.match(RUN, /A product question inside a crew is the crew lead's call/)
})

test('run skill: crew product calls route through the product-owner persona with PO: DECIDE / ESCALATE', () => {
  assert.match(RUN, /Product call: crew <slug>/)
  assert.match(RUN, /PO: DECIDE/)
  assert.match(RUN, /PO: ESCALATE/)
  assert.match(RUN, /PO crew <slug>: <question> \| <answer> \| product-owner \| decided/)
  assert.match(RUN, /touches another crew's area/)
})

test('run skill: watch crew decisions with ack and change', () => {
  assert.match(RUN, /\*\*Watch crew decisions\.\*\*/)
  assert.match(RUN, /crew-decision --crew <slug>/)
  assert.match(RUN, /decision-reply <id> ack/)
  assert.match(RUN, /decision-reply <id> change --note/)
  assert.match(RUN, /decision-replies --crew <slug>/)
  assert.match(RUN, /A call you never answer counts as accepted/)
})

test('product calls see every crew decision of the run; direct crew members follow persona routing', () => {
  assert.match(RUN, /carries every crew decision of the run so far/)
  assert.match(FOREMAN, /every crew decision of the run so far/)
  assert.match(read('../docs/adr/0033-crew-knowledge-and-product-calls.md'), /parallel crews stay consistent/)
  assert.match(RUN, /start `<slug>-tester`, as the persona whose area/)
  assert.match(RUN, /Start `<slug>-builder` as the persona whose area/)
  assert.doesNotMatch(RUN, /Start `<slug>-builder` on Sonnet/)
})

test('run skill: plan mode has the product-owner plan review', () => {
  assert.match(RUN, /### Have the product owner review the acceptance criteria/)
  assert.match(RUN, /Plan review:/)
  assert.match(RUN, /PO: ACCEPT/)
  assert.match(RUN, /PO: REVISE/)
  assert.match(RUN, /<n>\. <crew>: <what>\. Fix: <fix>/)
  assert.match(RUN, /A second `REVISE`/)
})

test('run skill: solo and lean crews run the knowledge step and the PM decides their product calls', () => {
  assert.match(RUN, /Knowledge: crew <slug>/)
  assert.match(RUN, /docs\(knowledge\): <slug> learned/)
  assert.match(RUN, /you decide its product calls/)
})

test('run skill: Learned stays optional, merge flags contradictory calls, the run-end pass reconciles', () => {
  assert.match(RUN, /may carry an optional `## Learned` section/)
  assert.match(RUN, /contradict each other across crews/)
  assert.match(RUN, /### Reconcile what the run learned/)
  assert.doesNotMatch(RUN, /### Adopt what the run learned/)
  assert.match(RUN, /the knowledge updates: per crew/)
})

test('run skill: memory holds only how the client works', () => {
  assert.match(RUN, /Memory is not the crew's knowledge/)
  assert.match(RUN, /never keep it in private memory|Never keep it in private memory/)
  assert.match(RUN, /no `memory:` frontmatter field/)
})

test('foreman: knowledge step before QC, optional and terse; product calls via the persona', () => {
  assert.match(FOREMAN, /\*\*Knowledge step\.\*\*/)
  assert.match(FOREMAN, /Knowledge: crew <slug>/)
  assert.match(FOREMAN, /skip it silently/)
  assert.match(FOREMAN, /editing or merging existing entries and not appending/)
  assert.match(FOREMAN, /\*\*Product calls\.\*\*/)
  assert.match(FOREMAN, /PO: DECIDE/)
  assert.match(FOREMAN, /decision-replies --crew <slug>/)
  assert.match(FOREMAN, /`Knowledge:` block/)
  assert.match(FOREMAN, /only `## Learned` may be left out/)
})

test('writer: Knowledge mode with the feature-map entry format', () => {
  assert.match(WRITER, /## Knowledge mode/)
  assert.match(WRITER, /Knowledge: crew <slug>/)
  assert.match(WRITER, /docs\/features\.md/)
  assert.match(WRITER, /entry points as repo paths/)
  assert.match(WRITER, /bloat/)
  assert.match(WRITER, /target/)
})

test('QC: Knowledge rubric paragraph, never fails for optional learning, first-line format kept', () => {
  assert.match(QC, /\*\*Knowledge\.\*\*/)
  assert.match(QC, /Missing optional learning is never a FAIL/)
  assert.match(QC, /VERDICT: PASS/)
})

test('checking engineer: contradictory product calls and plan review findings', () => {
  assert.match(CHECKING, /contradict each other across crews/)
  assert.match(CHECKING, /## Plan review findings/)
})

test('design and planning engineers use the feature map', () => {
  assert.match(DESIGN, /\*\*The feature map\*\*/)
  assert.match(DESIGN, /\*\*Feature map first\.\*\*/)
  assert.match(DESIGN, /PO: REVISE/)
  assert.match(PLANNER, /Read the feature map/)
  assert.match(PLANNER, /`learned` item/)
})

test('0.23.0 prose: plan result, judge host, trigger, scope and reachable knowledge', () => {
  const ADR = read('../docs/adr/0033-crew-knowledge-and-product-calls.md')
  assert.match(RUN, /`productOwner` is `\{skipped\}` or `\{judge, verdict: ACCEPT\|REVISE\|UNCLEAR, revised, open\}`/)
  assert.match(RUN, /`personaDrafts`/)
  assert.match(RUN, /persona-install --from <truss dir>\/personas --repo <root>/)
  assert.match(RUN, /never read as `ACCEPT`/)
  assert.match(RUN, /re-runs the checking engineer on the revised plan/)
  assert.match(DESIGN, /re-runs the checking engineer on the revised plan/)
  assert.match(ADR, /re-runs the checking engineer on the revised plan/)
  for (const t of [RUN, ADR]) {
    assert.match(t, /`truss:judge`/)
    assert.match(t, /never runs as `general-purpose`|never `general-purpose`/)
    assert.match(t, /Bash can still write/)
  }
  for (const t of [RUN, FOREMAN, WRITER, ADR]) {
    assert.match(t, /adds, renames or deletes non-test source files/)
    assert.doesNotMatch(t, /diff adds or moves user-facing functionality;/)
  }
  for (const t of [WRITER, ADR]) {
    assert.match(t, /a doc that no agent can find is as hidden as code/)
    assert.match(t, /`CLAUDE\.md` \/ `AGENTS\.md` index/)
    assert.match(t, /not a `\.md` file is skipped/)
  }
  for (const t of [RUN, ADR, QC]) assert.match(t, /only (this commit|the knowledge-step commit)[^.]* may touch files outside the crew's owns/i)
  assert.match(ADR, /counts learned items per crew and knowledge steps run versus skipped/)
})

test('0.23.0 round 2 prose: one reply checkpoint, SHA exemption, plan review, personas, judges', () => {
  const ADR = read('../docs/adr/0033-crew-knowledge-and-product-calls.md')
  const CL = read('../CHANGELOG.md')
  for (const t of [RUN, FOREMAN, ADR]) {
    assert.doesNotMatch(t, /before each member spawn/)
    assert.match(t, /decision-ack --crew <slug>/)
    assert.match(t, /decision-checkpoint --crew <slug>/)
    assert.match(t, /--note=<text>|--question=<q>/)
    assert.match(t, /\blate\b/)
  }
  assert.match(RUN, /one checkpoint only: after every member has integrated and green has passed, and before the knowledge step/)
  assert.match(RUN, /`crewPastCheckpoint: true`/)
  assert.match(RUN, /Stop the Monitor when `decisions --open` is empty and no crew is running/)
  assert.match(ADR, /races its integration/)
  assert.match(ADR, /loops? QC/)
  assert.match(ADR, /decision-replies --crew <slug>`[^.]*consumes nothing/)
  assert.match(RUN, /factory\.ts knowledge-commit --slug <slug> --sha <sha>/)
  for (const t of [RUN, FOREMAN, ADR]) assert.match(t, /Sonnet/)
  for (const t of [RUN, FOREMAN, ADR]) assert.match(t, /writer tasks skips? (the|it)/)
  for (const t of [ADR, QC, RUN]) assert.match(t, /never (on )?the (commit )?subject/)
  for (const t of [ADR, QC]) assert.match(t, /frontmatter[^.]*never exempt/)
  assert.match(ADR, /`unrecorded`/)
  assert.match(ADR, /`crew-learned`/)
  assert.match(FOREMAN, /names its SHA/)
  assert.match(RUN, /`recheck\.reviews`/)
  assert.match(ADR, /`recheck\.reviews`/)
  assert.match(RUN, /`plan-write` \(step 4\), not `plan\.js`, writes them/)
  assert.match(ADR, /`factory plan-write`, not `plan\.js`, writes/)
  assert.doesNotMatch(read('../CHANGELOG.md').split('## 0.22.0')[0], /`plan\.js` writes persona drafts/)
  assert.doesNotMatch(DESIGN, /the PM writes it to/)
  assert.match(DESIGN, /four-backtick/)
  assert.match(DESIGN, /`## Standards` heading/)
  assert.match(ADR, /four-backtick fence/)
  assert.match(RUN, /feature map path when the file exists/)
  for (const t of [RUN, ADR]) {
    assert.match(t, /only when it is read-only/)
    assert.match(t, /always runs as `truss:judge`/)
    assert.match(t, /read-only to kit's manifest/)
  }
  assert.match(RUN, /docs\(arch\): reconcile learned items/)
  assert.match(read('../README.md'), /docs\(arch\): reconcile learned items/)
  assert.match(read('../docs/adr/0005-growth-model.md'), /docs\(arch\): reconcile learned items/)
  assert.match(CL, /Review fixes:/)
})

test('init creates the feature map on day 0', () => {
  assert.match(INIT, /docs\/features\.md/)
})

test('ADR-0033 exists, follows the ADR format and names A-D', () => {
  const p = '../docs/adr/0033-crew-knowledge-and-product-calls.md'
  assert.ok(existsSync(new URL(p, import.meta.url)))
  const adr = read(p)
  for (const h of ['## Context', '## Decision Drivers', '## Considered Options', '## Decision', '## Consequences']) {
    assert.ok(adr.includes(h), h)
  }
  for (const h of ['### A.', '### B.', '### C.', '### D.']) assert.ok(adr.includes(h), h)
  assert.match(adr, /context bloat|bloat the context/)
  assert.match(adr, /separate goal after this one merges/)
  assert.match(JSON.parse(read('../.claude-plugin/plugin.json')).version, /^0\.24\.\d+$/)
})
