// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Truss 0.25.0 wave 2, D2: the product prose pins (contract-025 sections 2, 3, 4, 7 and 8, "D2 acceptance"). Each case reads
// a skill, the architecture doc or the release metadata as text and looks for the rule inside the section that has to
// carry it, so a keyword list pasted anywhere in the file does not pass. The two scans (agent count against budget terms,
// plain-text asks while unattended) are functions, and a planted counter-example proves each one catches what it claims.
//
// Run with: node --test tests/autonomy-prose.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r/g, '')
const RUN = read('../skills/run/SKILL.md')
const RETRO = read('../skills/retro/SKILL.md')
const INIT = read('../skills/init/SKILL.md')
const ARCH = read('../docs/architecture.md')
const SKILLS = { run: RUN, retro: RETRO, init: INIT }

// The body of the first heading (any level) that matches headRe, up to the next heading of the same or a higher level,
// outside code fences. Returns null when there is no such heading.
function sectionOf(text, headRe) {
  const lines = text.split('\n')
  let fenced = false
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    if (/^```/.test(lines[i])) fenced = !fenced
    const m = !fenced && /^(#{1,6}) (.*)$/.exec(lines[i])
    if (m && headRe.test(m[2])) {
      start = i
      level = m[1].length
      break
    }
  }
  if (start < 0) return null
  const out = []
  fenced = false
  for (const l of lines.slice(start + 1)) {
    if (/^```/.test(l)) fenced = !fenced
    const m = !fenced && /^(#{1,6}) /.exec(l)
    if (m && m[1].length <= level) break
    out.push(l)
  }
  return out.join('\n')
}

// Every section whose heading matches headRe, in order.
function sectionsOf(text, headRe) {
  const out = []
  let rest = text
  const seen = new Set()
  const heads = text.split('\n').filter((l) => /^#{1,6} /.test(l) && headRe.test(l.replace(/^#+ /, '')))
  for (const h of heads) {
    if (seen.has(h)) continue
    seen.add(h)
    const s = sectionOf(text, new RegExp(h.replace(/^#+ /, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    if (s !== null) out.push(s)
  }
  return out
}

const plain = (s) => s.replace(/\*\*/g, '').replace(/`/g, '')
// Sentences of a text: one per line, split again after . ! ? or ; so a label like "**Budget:** ..." stays whole.
const sentences = (text) => text.split('\n').flatMap((l) => plain(l).split(/(?<=[.!?;])\s+/)).map((s) => s.trim()).filter(Boolean)

const BUDGET = /budget|usd|spend/i
const AGENT_COUNT = /estAgents|agent count|number of agents|agent total|total agents|agents in total/i
// A budget term and an agent-count term in one sentence or label. `knowledgeBudgets` (line counts) is not a budget term.
function agentCountBudgetLines(text) {
  return sentences(text).filter((s) => BUDGET.test(s.replace(/knowledgeBudgets/g, '')) && AGENT_COUNT.test(s))
}

const ASK = /\bask(s|ing)?\b[^.]*\b(client|person|human|user)\b|AskUserQuestion|\bquestion the client\b/i
const FORBIDS = /\b(never|don't|do not|doesn't|does not|not|no)\b/i
// An instruction to ask the client or person, or to call AskUserQuestion, that no negation in its sentence forbids.
function plainTextAsks(text) {
  return sentences(text).filter((s) => ASK.test(s) && !FORBIDS.test(s))
}

const NEXT = sectionOf(RUN, /--next/)
const nextSection = () => {
  assert.ok(NEXT, 'skills/run/SKILL.md has no section whose heading names `--next`')
  return plain(NEXT)
}

test('autonomy prose: the run skill has the next section as the contract writes it', () => {
  const s = nextSection()
  for (const re of [
    /factory unattended --on/,
    /factory intake/,
    /factory queue-next/,
    /queue empty/,
    /\bheld\b/,
    /factory inbox --unapplied/,
    /mark-applied/,
    /start --resume/,
    /\breject\b/,
    /sizing engineer/,
    /factory worktypes/,
    /ELIGIBLE: yes\|no/,
    /intake-triage/,
    /--ref queue:<id>/,
    /queue-set --state triage/,
    /AWAITS: R-<n> \| crews: <slugs>/,
    /escalate --kind client-question --ref brief:<sid>:<branch> --crew <slug> --blocking/,
    /approve --by auto/,
    /client-trigger/,
    /long-term-cost/,
    /push-pr/,
    /queue-set/,
    /unattended --off/,
    /\/loop <interval> \/truss:run --next/,
    /Cloud Routines/,
  ]) assert.match(s, re, `the --next section lacks ${re}`)
  // the eligibility list, the five questions the checking engineer answers
  for (const re of [/outcome that can be checked/, /fits one workType/, /no stage-0 crew/, /no external service and no stored data shape/, /no production system/]) {
    assert.match(s, re, `the --next section's eligibility list lacks ${re}`)
  }
  assert.match(s, /always writes a plan/i)
  assert.match(s, /never run/i)
  assert.match(s, /prod-deploy/)
})

test('autonomy prose: direct crews call admit and set description slug-role', () => {
  const paras = plain(RUN).split(/\n\s*\n/)
  assert.ok(
    paras.some((p) => /direct/i.test(p) && /\badmit\b/.test(p)),
    'no paragraph of the run skill tells a direct crew to call admit',
  )
  assert.ok(
    paras.some((p) => /direct/i.test(p) && /description: <slug>-<role>/.test(p)),
    'no paragraph of the run skill tells a direct crew to set `description: <slug>-<role>`',
  )
})

test('autonomy prose: no line in run, retro or init uses a budget term for agent count, and a planted counter-example is caught', () => {
  assert.ok(agentCountBudgetLines("**Budget:** each crew's estAgents").length > 0, 'the scan misses the planted budget label')
  assert.ok(agentCountBudgetLines('Show the spend as the number of agents.').length > 0, 'the scan misses a planted spend line')
  assert.equal(agentCountBudgetLines('`knowledgeBudgets`: line counts for each file, never an agent count.').length, 0, 'the scan flags knowledgeBudgets')
  for (const [name, text] of Object.entries(SKILLS)) {
    assert.deepEqual(agentCountBudgetLines(text), [], `skills/${name}/SKILL.md uses a budget term for agent count`)
  }
  const five = sectionOf(RUN, /^5\. /)
  assert.ok(five, 'the run skill has no section 5')
  assert.match(plain(five), /agent count/i, 'section 5 does not say "agent count"')
  assert.match(plain(five), /cost budget/i, 'section 5 does not say "cost budget"')
})

test('autonomy prose: budgets exclude planning spend', () => {
  const hit = sentences(RUN).filter((s) => /planning/i.test(s) && /spend/i.test(s) && /not budgeted|excluded|never counts?|not counted|outside/i.test(s))
  assert.ok(hit.length > 0, 'the run skill never says planning spend is excluded from the budgets')
})

test('autonomy prose: no unattended section of run, retro or init tells the PM to ask in plain text or call AskUserQuestion, and a planted counter-example is caught', () => {
  assert.deepEqual(plainTextAsks('Ask the client which branch to take.'), ['Ask the client which branch to take.'], 'the scan misses the planted ask')
  assert.ok(plainTextAsks('Call AskUserQuestion for the branch.').length > 0, 'the scan misses a planted AskUserQuestion call')
  assert.equal(plainTextAsks('Never call AskUserQuestion; escalate instead.').length, 0, 'the scan flags a sentence that forbids the ask')
  assert.match(nextSection(), /never asks? in plain text/i, 'the --next section does not say the PM never asks in plain text')
  for (const [name, text] of Object.entries(SKILLS)) {
    const secs = name === 'run' ? [NEXT, ...sectionsOf(text, /unattended/i)] : sectionsOf(text, /unattended|--next/i)
    for (const sec of secs) assert.deepEqual(plainTextAsks(sec), [], `an unattended section of skills/${name}/SKILL.md tells the PM to ask`)
  }
})

test('autonomy prose: the client rule of 2026-11-09 is in the run skill', () => {
  const s = nextSection()
  const at = s.search(/Client rule of 2026-11-09/i)
  assert.ok(at >= 0, 'the --next section lacks "Client rule of 2026-11-09"')
  const rule = s.slice(at)
  assert.match(rule, /drift is dropped/i)
  assert.match(rule, /outside the crew's owned files/i)
  assert.match(rule, /scope-change/)
  assert.match(rule, /never built and never dropped silently/i)
  assert.match(rule, /ADR no longer holds[\s\S]{0,120}PROPOSAL/i)
})

test('autonomy prose: the retro reports cost per merged crew as not recorded when null, never 0', () => {
  const s = sentences(RETRO)
  assert.ok(s.some((x) => /cost per merged crew/i.test(x)), 'the retro never reports the cost per merged crew')
  assert.ok(
    s.some((x) => /not recorded/i.test(x) && /null/i.test(x) && /never (shown as |reported as |counted as )?(0|zero)\b/i.test(x)),
    'no retro sentence says a null cost shows as "not recorded", never 0',
  )
})

test('autonomy prose: the retro reports the ltc approve rate and the all-session quote audit', () => {
  const s = sentences(RETRO)
  assert.ok(s.some((x) => /approve rate/i.test(x) && /(ltc|long-term cost)/i.test(x)), 'the retro does not report the ltc approve rate')
  assert.ok(s.some((x) => /90%/.test(x) && /10 or more/.test(x) && /tighten/i.test(x)), 'the retro lacks the flood check: above 90% over 10 or more items, tighten the paragraph')
  assert.ok(
    s.some((x) => /quote/i.test(x) && /(all|every)[^.]{0,40}sessions/i.test(x) && /human-typed|typed prompts?/i.test(x)),
    'the retro does not check each resolve quote against the human-typed prompts of all the project sessions',
  )
})

test('autonomy prose: init proposes budget only after pricing is filled and never writes a price', () => {
  const s = sentences(INIT)
  assert.ok(s.some((x) => /budget.{0,80}only after.{0,40}pricing/i.test(x)), 'init does not say it proposes budget only after pricing is filled')
  assert.ok(s.some((x) => /never writes? (a |any )?price/i.test(x)), 'init does not say it never writes a price')
  const priced = INIT.split('\n').filter((l) => /pricing/i.test(l))
  assert.ok(priced.length > 0, 'init never mentions pricing')
  for (const l of priced) assert.ok(!/\$\s?\d|\d\s?(USD|per MTok)/i.test(l), `init writes a price: ${l.slice(0, 80)}`)
})

const ON_DISK = () => {
  const s = sectionOf(ARCH, /^On disk$/)
  assert.ok(s, 'architecture.md has no "## On disk" section')
  return plain(s)
}

test('autonomy prose: the architecture doc has the shared layout', () => {
  const s = ON_DISK()
  assert.match(s, /truss\/shared\//)
  for (const re of [/inbox\.jsonl/, /ledger\.jsonl/, /queue\/items/, /locks\//, /usage\.jsonl/, /unattended\.json/]) assert.match(s, re, `On disk lacks ${re}`)
})

test('autonomy prose: the architecture doc rewrites the one folder per session line for the shared layout', () => {
  const s = ON_DISK()
  assert.doesNotMatch(s, /everything for a session lives under one folder/i, 'On disk still says everything lives under one session folder')
  assert.match(s, /<git common dir>\/truss\/<session id>\//)
  assert.match(s, /<git common dir>\/truss\/shared\//)
  assert.ok(sentences(s).some((x) => /unattended\.json/.test(x) && /per session/i.test(x)), 'On disk does not say unattended.json stays per session')
})

test('autonomy prose: plugin json version has one CHANGELOG entry and it is the first', () => {
  const pj = JSON.parse(read('../.claude-plugin/plugin.json'))
  const v = pj.version.replace(/\./g, '\\.')
  assert.match(pj.version, /^\d+\.\d+\.\d+$/)
  const log = read('../CHANGELOG.md')
  assert.equal(log.match(new RegExp(`^## ${v}\\b`, 'gm'))?.length, 1, `CHANGELOG needs exactly one ${pj.version} entry`)
  assert.match(log.split('\n').find((l) => /^## /.test(l)), new RegExp(`^## ${v}\\b`), `the ${pj.version} entry is not the first`)
})
