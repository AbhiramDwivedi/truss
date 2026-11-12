// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// Truss 0.25.0 wave 2, D1: the agent prose pins (contract-025 sections 3, 5, 7 and 8). Each case reads the agent
// files as text and looks for the rule inside the section (or the one paragraph) that has to carry it, so a
// keyword list pasted anywhere in the file does not pass.
//
// Run with: node --test tests/agent-prose-025.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

function agent(name) {
  return readFileSync(new URL(`../agents/${name}.md`, import.meta.url), 'utf8').replace(/\r/g, '')
}

// The body of a `## <heading>` section (heading matched by regex), up to the next `## ` heading outside a code fence.
function section(text, headRe) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^## /.test(l) && headRe.test(l.slice(3)))
  assert.ok(start >= 0, `no section whose heading matches ${headRe}`)
  const out = []
  let fenced = false
  for (const l of lines.slice(start + 1)) {
    if (/^```/.test(l)) fenced = !fenced
    if (!fenced && /^## /.test(l)) break
    out.push(l)
  }
  return out.join('\n')
}

// Paragraphs: blocks separated by a blank line, with list items kept in their block.
function paragraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim())
}

// The first paragraph of `text` that matches every regex; the failure message names what is missing.
function paragraphWith(text, res, what) {
  const hit = paragraphs(text).find((p) => res.every((re) => re.test(p)))
  assert.ok(hit, `no single paragraph ${what} (needs ${res.map(String).join(' and ')})`)
  return hit
}

// Contract-025 section 3, "The paragraph", byte for byte.
const LTC =
  'Long-term cost: when the change adds a cost the client carries after this run (a public interface or stored data shape that is costly to change, a new runtime dependency or service, a recurring money or operations cost, or a decision an ADR would record), write one line `LONG-TERM-COST: <what> | later: <the cost> | reversal: cheap|costly|irreversible`. Don\'t write one for code style, for "more code to maintain", or for a cost the approved scope already names. A LONG-TERM-COST line is never a FAIL; the merge waits for the client.'

test('agent prose 025: the long-term cost paragraph is word for word in design-engineer, checking-engineer and qc-engineer', () => {
  for (const name of ['design-engineer', 'checking-engineer', 'qc-engineer']) {
    const text = agent(name)
    // Byte for byte, and as a paragraph of its own: the whole line, not a quote inside other prose.
    const lines = text.split('\n')
    assert.ok(lines.includes(LTC), `${name}.md lacks the long-term cost paragraph as one line, word for word`)
    assert.equal(lines.filter((l) => l === LTC).length, 1, `${name}.md carries the paragraph more than once`)
  }
})

test('agent prose 025: checking-engineer carries the unattended eligibility list', () => {
  const text = agent('checking-engineer')
  // The list sits in one section with the answer format `ELIGIBLE: yes|no — <reason>`.
  const heads = text.split('\n').filter((l) => /^## /.test(l))
  const holder = heads.find((h) => {
    let body
    try {
      body = section(text, new RegExp('^' + h.slice(3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
    } catch {
      return false
    }
    return /ELIGIBLE: yes\|no/.test(body)
  })
  assert.ok(holder, 'no section carries the `ELIGIBLE: yes|no` answer')
  const body = section(text, new RegExp('^' + holder.slice(3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'))
  assert.match(body, /ELIGIBLE: yes\|no — <reason>/, 'the answer format is `ELIGIBLE: yes|no — <reason>`')
  const items = body.split('\n').filter((l) => /^\s*[-*] /.test(l))
  const want = [
    /outcome that can be checked/i,
    /fits one work ?type/i,
    /no stage-0 crew/i,
    /no external service and no stored data shape/i,
    /no production system/i,
  ]
  for (const re of want) assert.ok(items.some((l) => re.test(l)), `no list item matches ${re}`)
  assert.ok(items.length >= 5, 'the five eligibility conditions are a list')
})

test('agent prose 025: sizing-engineer never recommends below the work type minimum and reads the worktypes output from its brief', () => {
  const text = agent('sizing-engineer')
  // A rule in the Sizes section: never below the minimum of the item's work type.
  const sizes = section(text, /^Sizes$/)
  assert.match(sizes, /Don't recommend below the work type's minimum/, 'the Sizes section lacks "Don\'t recommend below the work type\'s minimum"')
  // And one paragraph that says the output of `factory worktypes` arrives in the brief (the agent has no Bash).
  paragraphWith(text, [/factory worktypes/, /\bbrief\b/, /\b(profiles|minProcess|minimum)\b/], 'tells the sizing engineer the `factory worktypes` output comes in its brief')
})

test('agent prose 025: design-engineer plan mode asks for workType and writes AWAITS lines', () => {
  const plan = section(agent('design-engineer'), /^plan mode$/)
  paragraphWith(plan, [/workType/, /\b(every|each) crew\b/i], 'asks for a workType on every crew in plan mode')
  // The AWAITS line format of contract-025 section 7 step 4, with the crews it holds.
  assert.match(plan, /AWAITS: R-<n> \| crews: <slugs>/, 'plan mode lacks the `AWAITS: R-<n> | crews: <slugs>` line format')
  paragraphWith(plan, [/AWAITS:/, /\bclient\b/i, /\b(hold|holds|held)\b/i], 'says an AWAITS line names a client answer that holds the listed crews')
})

test('agent prose 025: design-engineer turns an ADR that no longer holds into a PROPOSAL', () => {
  const text = agent('design-engineer')
  paragraphWith(text, [/\bADR\b[^.]*no longer holds/i, /\bPROPOSAL\b/, /\b(escalat|client)/i], 'turns an ADR that no longer holds into a PROPOSAL for the client')
  // It must not be an instruction to rewrite the ADR in place.
  const p = paragraphWith(text, [/no longer holds/i, /\bPROPOSAL\b/], 'handles an ADR that no longer holds')
  assert.doesNotMatch(p, /rewrite the ADR\b/i, 'the paragraph must not tell the engineer to rewrite the ADR itself')
})

test('agent prose 025: project manager turns a meaningful change outside owns into a scope-change PROPOSAL and drops drift', () => {
  const text = agent('project-manager')
  paragraphWith(text, [/\boutside\b[^.]*\bowns?\b|\bowned files\b/i, /\bmeaningful\b/i, /PROPOSAL/, /scope-change/], 'turns a meaningful change outside owns into a scope-change PROPOSAL')
  paragraphWith(text, [/\bdrift\b/i, /\b(dropped|drop|drops)\b/i, /(never|not) (build|built)|PROPOSAL|silently/i], 'says drift is dropped')
  // The scope-change rule and the drift rule belong to the same rule block (adjacent paragraphs or one section).
  const heads = text.split('\n').filter((l) => /^## /.test(l))
  const carrier = heads.find((h) => {
    const re = new RegExp('^' + h.slice(3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$')
    let b
    try {
      b = section(text, re)
    } catch {
      return false
    }
    return /scope-change/.test(b) && /\bdrift\b[^.]*\b(dropped|drop)/i.test(b)
  })
  assert.ok(carrier, 'no one section of project-manager.md holds both the scope-change rule and the drift-is-dropped rule')
})
