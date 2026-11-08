// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0031 Decision 3 and 5 (R-49..R-54): the plan.schema.json crew fields `process`
// (solo|lean|full), `qc` and `red`, valid at plan version 4 only. Pinned by validating whole plans against
// the schema with a small in-file evaluator of the keywords the schema uses. No validator, no dependency,
// no network, no shell, no agent.
//
// The schema is read from process.env.TRUSS_PLAN_SCHEMA, else from the repo copy.
// Run with: node --test tests/sizing-schema.check.ts
// Not a *.test.ts file on purpose: `claude plugin test` gives tests no fs (see contract.check.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const SCHEMA_PATH =
  process.env.TRUSS_PLAN_SCHEMA ||
  join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'plan.schema.json')
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))

const typeOf = (v: any): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v
const typeMatches = (v: any, t: string): boolean =>
  t === 'number' ? typeof v === 'number' : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t
const same = (a: any, b: any): boolean => JSON.stringify(a) === JSON.stringify(b)

// Returns a list of error strings; empty means valid. Formats are not checked.
const check = (node: any, v: any, at: string): string[] => {
  if (node === true || node === undefined) return []
  if (node === false) return [`${at}: forbidden`]
  if (typeof node.$ref === 'string') {
    const target = node.$ref
      .slice(2)
      .split('/')
      .reduce((n: any, k: string) => n?.[k], schema)
    return check(target, v, at)
  }
  const errs: string[] = []
  if (node.type !== undefined) {
    const ts = Array.isArray(node.type) ? node.type : [node.type]
    if (!ts.some((t: string) => typeMatches(v, t))) errs.push(`${at}: type`)
  }
  if ('const' in node && !same(node.const, v)) errs.push(`${at}: const`)
  if (Array.isArray(node.enum) && !node.enum.some((e: any) => same(e, v))) errs.push(`${at}: enum`)
  if (typeof v === 'number') {
    if (node.minimum !== undefined && v < node.minimum) errs.push(`${at}: minimum`)
    if (node.maximum !== undefined && v > node.maximum) errs.push(`${at}: maximum`)
  }
  if (typeof v === 'string') {
    if (node.minLength !== undefined && v.length < node.minLength) errs.push(`${at}: minLength`)
    if (node.maxLength !== undefined && v.length > node.maxLength) errs.push(`${at}: maxLength`)
    if (node.pattern !== undefined && !new RegExp(node.pattern).test(v)) errs.push(`${at}: pattern`)
  }
  if (Array.isArray(v)) {
    if (node.minItems !== undefined && v.length < node.minItems) errs.push(`${at}: minItems`)
    if (node.uniqueItems && new Set(v.map((x) => JSON.stringify(x))).size !== v.length)
      errs.push(`${at}: uniqueItems`)
    if (node.items) v.forEach((x, i) => errs.push(...check(node.items, x, `${at}/${i}`)))
    if (node.contains && !v.some((x) => check(node.contains, x, at).length === 0))
      errs.push(`${at}: contains`)
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of node.required ?? []) if (!(r in v)) errs.push(`${at}: required ${r}`)
    const props = node.properties ?? {}
    for (const k of Object.keys(v)) {
      if (k in props) errs.push(...check(props[k], v[k], `${at}/${k}`))
      else if (node.additionalProperties === false) errs.push(`${at}/${k}: additionalProperties`)
      else if (node.additionalProperties && typeof node.additionalProperties === 'object')
        errs.push(...check(node.additionalProperties, v[k], `${at}/${k}`))
    }
  }
  for (const s of node.allOf ?? []) errs.push(...check(s, v, at))
  if (node.anyOf && !node.anyOf.some((s: any) => check(s, v, at).length === 0)) errs.push(`${at}: anyOf`)
  if (node.oneOf && node.oneOf.filter((s: any) => check(s, v, at).length === 0).length !== 1)
    errs.push(`${at}: oneOf`)
  if (node.not && check(node.not, v, at).length === 0) errs.push(`${at}: not`)
  if (node.if) {
    if (check(node.if, v, at).length === 0) errs.push(...check(node.then, v, at))
    else if (node.else) errs.push(...check(node.else, v, at))
  }
  return errs
}

const crew = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  stage: 1,
  verdict: 'extend',
  modules: ['m'],
  owns: [`src/${slug}/**`],
  acceptanceTest: 'node --test',
  acceptanceTestProved: true,
  estAgents: 1,
  status: 'planned',
  ...extra,
})

const plan = (version: number, crews: any[]) => ({
  version,
  goal: 'g',
  architecture: 'docs/architecture.md',
  approval: 'auto',
  approvedAt: '2026-11-08T10:00:00Z',
  maxParallelCrews: 4,
  reworkAllowance: 2,
  crews,
})

const errorsOf = (p: any): string[] => check(schema, p, '')

test('sizing schema: accepts process solo, lean and full on a version 4 plan', () => {
  const p = plan(4, [
    crew('alpha', { process: 'solo' }),
    crew('beta', { process: 'lean', qc: true, red: false, estAgents: 3 }),
    crew('gamma', { process: 'lean', qc: false, red: true, estAgents: 2 }),
    crew('delta', { process: 'full', estAgents: 4 }),
    crew('epsilon'),
  ])
  assert.deepEqual(errorsOf(p), [])
})

test('sizing schema: rejects an unknown process', () => {
  assert.deepEqual(errorsOf(plan(3, [crew('alpha')])), [], 'control: a plain version 3 plan is valid')
  for (const bad of ['tiny', 'Solo', 'standard', '', null, 1, true]) {
    assert.notDeepEqual(
      errorsOf(plan(4, [crew('alpha', { process: bad })])),
      [],
      `process ${JSON.stringify(bad)} must be refused`,
    )
  }
  assert.notDeepEqual(
    errorsOf(plan(4, [crew('alpha', { process: 'lean', qc: true, red: true }), crew('beta', { process: 'huge' })])),
    [],
  )
})

test('sizing schema: rejects qc or red on a crew whose process is not lean', () => {
  assert.deepEqual(errorsOf(plan(3, [crew('alpha')])), [], 'control: a plain version 3 plan is valid')
  for (const process of ['solo', 'full', undefined]) {
    const base = process === undefined ? {} : { process }
    for (const extra of [{ qc: true }, { qc: false }, { red: true }, { red: false }, { qc: true, red: true }]) {
      assert.notDeepEqual(
        errorsOf(plan(4, [crew('alpha', { ...base, ...extra })])),
        [],
        `process ${process} with ${JSON.stringify(extra)} must be refused`,
      )
    }
  }
})

test('sizing schema: rejects process on a version 2 or 3 plan', () => {
  for (const v of [2, 3]) {
    assert.deepEqual(errorsOf(plan(v, [crew('alpha')])), [], `control: a plain version ${v} plan is valid`)
    for (const extra of [
      { process: 'solo' },
      { process: 'full' },
      { process: 'lean', qc: true, red: true },
    ]) {
      assert.notDeepEqual(
        errorsOf(plan(v, [crew('alpha', extra)])),
        [],
        `version ${v} with ${JSON.stringify(extra)} must be refused`,
      )
    }
  }
})
