// @ts-nocheck
// 0.32.0 hotfix: the knowledge step writes rule changes, `sources` and `verified` included, only to the crew's fragment under
// `<rulesDir>.d/`, never to a file under `<rulesDir>/` (outside every crew's owns, so the owns gate stopped the crew). When the
// knowledge commit still changes such a file, the step sends it back once to restore it; a second miss stops the crew BLOCKED at
// knowledge, before the owns gate can raise the wrong question. Single-step test (ADR-0050): knowledge.js loads alone through
// loadStageStep with stubbed runner-side calls. Node built-ins only.

import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

const STEP = path.join(import.meta.dirname, '../workflows-src/stage/knowledge.js')

class Stop {
  constructor(tag, text, at) {
    this.tag = tag
    this.text = text
    this.at = at
  }
}

const SHARED = '.claude/rules/plugin-tests.md'

// diffs: what `factory knowledge-commit --base --head` reports as files, one entry per knowledge run
async function load(diffs) {
  const { loadStageStep } = await import('../bin/build-stage.ts')
  const prompts = []
  const commits = []
  let n = 0
  const stubs = {
    args: {},
    agent: async () => assert.fail('no direct agent call expected'),
    log: () => {},
    Stop,
    PLATFORM: 'linux',
    F: { repo: '/r', rules: [{ path: SHARED }] },
    flatPath: (p) => String(p).replace(/\\/g, '/'),
    plainGlob: (p) => p,
    isPlainObject: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    taskPersona: () => null,
    PERSONAS: {},
    PRODUCT_DECISIONS: 'docs/product-decisions.md',
    AGENTS_INDEX: 'AGENTS.md',
    FEATURE_MAP: 'docs/features.md',
    RULES_DIR: '.claude/rules',
    KNOWLEDGE_DIR: 'docs/knowledge',
    ADR_DIR: 'docs/adr',
    BUDGETS: { agentsIndex: 1, persona: 1, personaStandards: 1, rule: 1, doc: 1, featureEntry: 1 },
    fragmentLine: () => 'FRAGMENT LINE',
    lintData: () => [],
    resumeLines: () => [],
    firstStep: () => 'start',
    memberPrompt: (crew, role, o) => o.body.join('\n'),
    sh: (v) => String(v),
    clip: (s) => s,
    pendingCall: async () => null,
    runMember: async (crew, role, make) => {
      n++
      prompts.push(make(null))
      return { proof: `p${n}`, branch: `b${n}`, commit: `${String(n).repeat(7)}` }
    },
    integrate: async () => `head${n}`,
    runFactory: async (crew, command) => {
      commits.push(command)
      const m = /--sha (\S+)/.exec(command)
      return { met: true, parsed: { slug: 's', sha: m[1], files: diffs[commits.length - 1] ?? [] } }
    },
  }
  const m = await loadStageStep(STEP, stubs)
  return { m: m.scope, prompts, commits }
}

const crewOf = () => ({ slug: 's', e: { base: 'base0', tasks: [{ role: 'builder' }] }, head: 'head0', learned: [{ kind: 'persona', text: 'a rule', source: 'bin/x.ts', target: SHARED, member: 'b', task: 't1' }], unrecorded: [], sourceChanges: [], proofs: [] })

test('knowledge rules: the brief sends every rule change, sources and verified included, to the crew fragment, never the rule file', async () => {
  const { m, prompts } = await load([['docs/features.md', '.claude/rules.d/plugin-tests/s.md']])
  assert.equal(await m.knowledge(crewOf()), true)
  assert.equal(prompts.length, 1, 'a clean diff needs no send-back')
  const p = prompts[0]
  assert.match(p, /\.claude\/rules\.d\/<rule name>\/s\.md/)
  assert.match(p, /including `sources` and `verified`/)
  assert.match(p, /never create or edit a file under `\.claude\/rules\/`/i)
  assert.doesNotMatch(p, /\| `\.claude\/rules\/<area>\.md`/, 'the routing table no longer sends area rules to the rules dir')
  assert.doesNotMatch(p, /frontmatter of every rule or knowledge doc/, 'verified on a rule goes to its fragment')
})

test('knowledge rules: a knowledge commit that edits a shared rule file is sent back once, to restore it', async () => {
  const { m, prompts, commits } = await load([['docs/features.md', SHARED], ['docs/features.md', '.claude/rules.d/plugin-tests/s.md']])
  const crew = crewOf()
  assert.equal(await m.knowledge(crew), true)
  assert.equal(prompts.length, 2)
  assert.match(prompts[1], new RegExp(`Why this run: your knowledge commit changed ${SHARED.replace(/\./g, '\\.')}`))
  assert.match(prompts[1], /git checkout head0 -- \.claude\/rules\/plugin-tests\.md/)
  assert.match(prompts[1], /Diff range: head0\.\.\./)
  // both runs' commits are recorded, and the second is checked against the whole knowledge diff from the head before the step
  assert.equal(commits.length, 2)
  assert.match(commits[1], /--sha 2222222 --base=head0 --head=head2/)
  assert.equal(crew.knowledgeSha, '2222222')
})

test('knowledge rules: a second knowledge commit that still leaves the shared rule edit stops the crew BLOCKED at knowledge', async () => {
  const { m, prompts } = await load([[SHARED], [SHARED]])
  await assert.rejects(m.knowledge(crewOf()), (err) => {
    assert.ok(err instanceof Stop, String(err))
    assert.equal(err.tag, 'BLOCKED')
    assert.equal(err.at, 'knowledge')
    assert.match(err.text, /\.claude\/rules\/plugin-tests\.md/)
    return true
  })
  assert.equal(prompts.length, 2, 'one send-back, no more')
})
