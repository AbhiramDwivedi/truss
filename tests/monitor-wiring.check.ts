// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0015 Decision 5: what the monitor agent and the PM step must carry, beyond the three cases in
// tests/monitor-contract.check.ts (tools line, model haiku, the skill names the monitor / parallelism / held).
// Written from the spec before any producer exists. Tolerant regexes: they pin meaning, not exact prose.
//
// Run with: node --test tests/monitor-wiring.check.ts
// Each producer is read from $TRUSS_CONTRACT_ROOT/<repo path>; with the variable unset the root is the repo root.
// With no producer it prints `producer missing: <label>` and the cases that need it fail.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const ROOT = (process.env.TRUSS_CONTRACT_ROOT || REPO).replace(/\\/g, '/')
const AGENT_PATH = `${ROOT}/agents/resource-monitor.md`
const SKILL_PATH = `${ROOT}/skills/run/SKILL.md`
const AGENT_MISSING = 'producer missing: agents/resource-monitor.md'
const SKILL_MISSING = 'producer missing: skills/run resources'
const mt = (name, fn) => test(name, { timeout: 20000 }, fn)

const agentText = existsSync(AGENT_PATH) ? readFileSync(AGENT_PATH, 'utf8') : null
const skillText = existsSync(SKILL_PATH) ? readFileSync(SKILL_PATH, 'utf8') : ''
const agentMissing = agentText === null
const skillMissing = !skillText.includes('truss:resource-monitor')
if (agentMissing) console.log(AGENT_MISSING)
if (skillMissing) console.log(SKILL_MISSING)

// the lines between the first two `---` fences
function frontmatter(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  if (lines[0].trim() !== '---') return []
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end < 0 ? [] : lines.slice(1, end)
}

// the text after the closing fence
function body(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r/g, '').split('\n')
  if (lines[0].trim() !== '---') return lines.join('\n')
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  return end < 0 ? '' : lines.slice(end + 1).join('\n')
}

// The PM step's region of the run skill: the text near a mention of the monitor or of the parallelism file, so a
// match elsewhere in the long skill (an unrelated `--resume answers`, say) does not count.
const WINDOW = 1500
function region(text) {
  const spans = []
  const re = /truss:resource-monitor|resource-monitor|parallelism\.json/g
  let m
  while ((m = re.exec(text))) spans.push([Math.max(0, m.index - WINDOW), Math.min(text.length, m.index + m[0].length + WINDOW)])
  return spans.map(([a, b]) => text.slice(a, b)).join('\n…\n')
}

function agentCase(name, fn) {
  mt(name, () => {
    if (agentMissing) assert.fail(AGENT_MISSING)
    fn(body(agentText), frontmatter(agentText))
  })
}
function skillCase(name, fn) {
  mt(name, () => {
    if (skillMissing) assert.fail(SKILL_MISSING)
    fn(region(skillText))
  })
}

// ---- the agent --------------------------------------------------------------------------------------------------

agentCase('agent frontmatter has name: resource-monitor', (_b, fm) => {
  assert.ok(fm.some((l) => /^name: *resource-monitor\s*$/.test(l)), `the frontmatter needs "name: resource-monitor":\n${fm.join('\n')}`)
})

agentCase('agent runs resources/index.ts with --worktrees', (b) => {
  assert.match(b, /resources\/index\.ts/, 'the agent body must name resources/index.ts')
  assert.match(b, /--worktrees/, 'the agent body must run it with --worktrees')
})

agentCase('agent reads parallelism.json and plan.json', (b) => {
  assert.match(b, /parallelism\.json/, 'the agent body must name parallelism.json')
  assert.match(b, /plan\.json/, 'the agent body must name plan.json')
})

agentCase('agent says it writes nothing', (b) => {
  assert.match(b, /\b(writes? nothing|do(es)? not write|never writes?|must not write|don'?t write|no writes?|read-only)\b/i, 'the agent body must say it writes nothing')
})

agentCase('agent ends with a RECOMMEND parallelism <n> line', (b) => {
  assert.match(b, /RECOMMEND parallelism <?n>?/, 'the agent body must give the line "RECOMMEND parallelism <n>"')
  assert.match(b, /\b(last|final)\b[^\n]{0,80}RECOMMEND parallelism|RECOMMEND parallelism[^\n]{0,120}\b(last|final)\b/i, 'the RECOMMEND line must be named as the last line')
})

agentCase('agent bounds n from 1 to maxParallelCrews', (b) => {
  assert.match(b, /maxParallelCrews/, 'the agent body must name maxParallelCrews')
  assert.match(b, /\b1\b[^\n]{0,40}\b(to|through|\.\.|-|–|and)\b[^\n]{0,20}maxParallelCrews|between 1 and maxParallelCrews/i, 'n must be bounded from 1 to maxParallelCrews')
})

agentCase('agent states the down rule: below twice minFreeMB, or load1 above cpus', (b) => {
  assert.match(b, /\b(twice|2 ?[x×*]|two times)\b[^\n]{0,40}minFreeMB|minFreeMB[^\n]{0,20}(\*|×|x) ?2\b/i, 'the down rule must name twice minFreeMB')
  assert.match(b, /load1[^\n]{0,60}\b(above|over|exceeds?|greater than|>)\b[^\n]{0,20}cpus|cpus[^\n]{0,60}load1/i, 'the down rule must compare load1 against cpus')
  assert.match(b, /\b(down|lower|reduce|fewer|decrease|minus)\b/i, 'the rule must say when to go down')
})

agentCase('agent states the up rule: above four times minFreeMB, load1 below half of cpus', (b) => {
  assert.match(b, /\b(four times|4 ?[x×*]|four)\b[^\n]{0,40}minFreeMB|minFreeMB[^\n]{0,20}(\*|×|x) ?4\b/i, 'the up rule must name four times minFreeMB')
  assert.match(b, /\b(half|0\.5|1\/2|\/ ?2)\b[^\n]{0,20}cpus|cpus[^\n]{0,20}(\/ ?2|\* ?0\.5)/i, 'the up rule must compare load1 against half of cpus')
  assert.match(b, /\b(up|raise|increase|more|plus)\b/i, 'the rule must say when to go up')
})

agentCase('agent input carries minFreeMB: a source line outside the rule names where the threshold comes from', (b) => {
  // The rule bullets use minFreeMB; a line that is not a rule bullet must say the sampler prints it or the env var sets it.
  const lines = b.split('\n').filter((l) => /minFreeMB|TRUSS_MIN_FREE_MB/.test(l) && !/^\s*[-*]\s*(Go|Keep|Otherwise)\b/i.test(l))
  const source = lines.filter((l) => /\b(prints?|reports?|reading|sampler|outputs?|returns?|reads?|from|TRUSS_MIN_FREE_MB)\b/i.test(l))
  assert.ok(source.length > 0, `some line outside the rule must say where minFreeMB comes from (the sampler's reading or TRUSS_MIN_FREE_MB); lines naming it: ${JSON.stringify(lines)}`)
  assert.ok(source.some((l) => /freeMB/.test(l) || /TRUSS_MIN_FREE_MB/.test(l)), 'the input line must sit with freeMB in the reading, or name TRUSS_MIN_FREE_MB')
})

// ---- the PM step ------------------------------------------------------------------------------------------------

skillCase('run skill starts truss:resource-monitor as an Agent call with model haiku', (r) => {
  assert.match(r, /\bAgent\b/, 'the PM step must make an Agent call')
  assert.match(r, /\bhaiku\b/i, 'the Agent call must use model haiku')
})

skillCase('run skill says the monitor is never a Workflow role', (r) => {
  assert.match(r, /(never|not|isn'?t|no)\b[^\n]{0,60}\bWorkflow role\b|\bWorkflow role\b[^\n]{0,60}\b(never|not)\b/i, 'the PM step must say the monitor is never a Workflow role')
})

skillCase('run skill starts the monitor at each stage start', (r) => {
  assert.match(r, /\b(each|every|at the start of (each|every)) stage( start)?\b|\bstage start\b/i, 'the PM step must start the monitor at each stage start')
})

skillCase('run skill starts the monitor on held and on "held by admission:"', (r) => {
  assert.match(r, /\bheld\b/, 'the PM step must name held (start\'s held list)')
  assert.match(r, /held by admission:/, 'the PM step must name the finish stopped why "held by admission:"')
})

skillCase('run skill says never on a loop', (r) => {
  assert.match(r, /\b(never|not|no)\b[^\n]{0,60}\b(loop|polling|poll|tight loop)\b/i, 'the PM step must say the monitor is never started on a loop')
})

skillCase('run skill writes resources/parallelism.json with a value from 1 to maxParallelCrews, never above', (r) => {
  assert.match(r, /resources\/parallelism\.json/, 'the PM step must write resources/parallelism.json')
  assert.match(r, /\bWrite\b/, 'the PM step must write it with Write')
  assert.match(r, /maxParallelCrews/, 'the PM step must name maxParallelCrews')
  assert.match(r, /\b1\b[^\n]{0,40}\b(to|through|\.\.|-|–|and)\b[^\n]{0,20}maxParallelCrews|between 1 and maxParallelCrews/i, 'the value must be from 1 to maxParallelCrews')
  assert.match(r, /(never|not|nothing)\b[^\n]{0,60}\b(above|over|more than|exceed)/i, 'the PM step must say it never goes above maxParallelCrews')
})

skillCase('run skill logs a decision line', (r) => {
  assert.match(r, /decision line|decisions\.md|log (a|the) decision/i, 'the PM step must log a decision line')
})

skillCase('run skill resumes a held crew with --resume answers', (r) => {
  assert.match(r, /--resume answers/, 'the PM step must resume with start --slug <s> --resume answers')
})
