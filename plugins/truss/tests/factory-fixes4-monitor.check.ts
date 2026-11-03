// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0025 items 38 and 39 (crew monitor-hold): the resource-monitor step rule holds when running crews
// exceed the current parallelism, and step 3 says what admit's answer means. Tolerant regexes pin meaning, not prose.
// The agent file is read relative to this test file, so a base-copy run reads the base text.
//
// Run with: node --test tests/factory-fixes4-monitor.check.ts

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const text = readFileSync(new URL('../agents/resource-monitor.md', import.meta.url), 'utf8')
const lines = text.split('\n')
const mt = (name, fn) => test(name, { timeout: 20000 }, fn)

const from = lines.findIndex((l) => /^3\./.test(l))
const to = lines.findIndex((l, i) => i > from && /^4\./.test(l))
const step3 = from >= 0 && to > from ? lines.slice(from, to).join('\n') : ''

mt('control 1: the down rule still names twice minFreeMB and load1 above cpus', () => {
  assert.match(text, /Go down one when[^\n]*twice[^\n]*minFreeMB[^\n]*load1[^\n]*above[^\n]*cpus/i)
})

mt('control 2: the up rule still names four times minFreeMB and half of cpus', () => {
  assert.match(text, /Go up one when[^\n]*four times[^\n]*minFreeMB[^\n]*half of[^\n]*cpus/i)
})

mt('control 3: step 3 still runs factory.ts admit', () => {
  assert.ok(step3.length > 0, 'step 3 paragraph not found')
  assert.match(step3, /factory\.ts admit/)
})

mt('i38 1: running crews above parallelism hold the value, no step down', () => {
  const hit = lines.some(
    (l) =>
      /running[^.\n]*(exceed|above|more than|over|greater)[^.\n]*parallelism/i.test(l) &&
      /(not|n't|never|no)[^.\n]*(go|step)[^.\n]*down|\bhold|\bkeep/i.test(l),
  )
  assert.ok(hit, 'no rule line ties running above parallelism to not going down / holding / keeping')
})

mt('i38 2: the up rule still applies in that hold, whatever the running count', () => {
  assert.match(
    text,
    /up rule[^\n]*(applies|still applies|unchanged)[^\n]*(whatever|regardless|any)[^\n]*running|(whatever|regardless of)[^\n]*running[^\n]*up rule|hold[^\n]*yields?[^\n]*up rule/i,
  )
})

mt('i39 1: step 3 says a running slug is checked on memory only, and the old exit-1 wording is gone', () => {
  assert.ok(step3.length > 0, 'step 3 paragraph not found')
  assert.match(step3, /running slug[^\n]*(memory only|only (the )?memory|checks? memory)|(memory only|only (the )?memory)[^\n]*running slug/i)
  assert.match(step3, /admitted/)
  assert.match(step3, /exit/i)
  assert.doesNotMatch(step3, /exits 1 when it holds a start/)
})

mt('i39 2: step 3 names minFreeMB, running and parallelism as the only fields, never admitted or the exit code', () => {
  assert.ok(step3.length > 0, 'step 3 paragraph not found')
  assert.match(step3, /minFreeMB/)
  assert.match(step3, /`running`/)
  assert.match(step3, /`parallelism`/)
  assert.match(step3, /never[^\n.]*(admitted|exit code)|(admitted|exit code)[^\n.]*never[^\n.]*(recommendation|recommend)/i)
})
