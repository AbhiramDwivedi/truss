// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0027 (retro-fixes2), crew catalog-narrow: pins the narrowing of two catalog entries,
// trailers-format-unquoted and webkit-host-missing-dependencies. Assertions go through matchLine on the entry ids,
// never on pattern strings.
//
// Run with: node --test tests/retro-fixes2-catalog.check.ts

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

const TRAILERS = 'trailers-format-unquoted'
const WEBKIT = 'webkit-host-missing-dependencies'

const hits = async (line: string): Promise<string[]> => {
  const mod = await import(pathToFileURL(join(PLUGIN, 'retro', 'catalog.ts')).href)
  const catalog = mod.loadCatalog(join(PLUGIN, 'retro', 'catalog.json'))
  return mod.matchLine(line, catalog)
}

// The matcher sees a transcript line as JSON text: a quote inside the command is the two characters backslash, quote.
const BS = '\\'
const jsonLine = (cmd: string) => `{"type":"tool_use","input":{"command":"${cmd}"}}`

// --- P1 1: the quoted trailers format is not a hit ---------------------------------------------------------------

test('P1 1: the JSON-escaped double-quoted --format=%(trailers form is not a trailers-format-unquoted hit', async () => {
  const line = jsonLine(`git log -1 ${BS}"--format=%(trailers:key=Truss-Crew)${BS}"`)
  assert.ok(line.includes(`${BS}"--format=%(trailers`), 'the input holds backslash, quote, --format=%(trailers')
  assert.ok(!(await hits(line)).includes(TRAILERS))
})

test('P1 1: the JSON-escaped double-quoted --format=%H%n%(trailers variant is not a hit', async () => {
  const line = jsonLine(`git log -1 ${BS}"--format=%H%n%(trailers:key=Truss-Role,valueonly)${BS}"`)
  assert.ok(line.includes(`${BS}"--format=%H%n%(trailers`))
  assert.ok(!(await hits(line)).includes(TRAILERS))
})

test('P1 1: the single-quoted --format=%(trailers form is not a hit', async () => {
  const line = jsonLine(`git log -1 '--format=%(trailers:key=Truss-Crew)'`)
  assert.ok(!(await hits(line)).includes(TRAILERS))
})

test('P1 1: the single-quoted --format=%H%n%(trailers variant is not a hit', async () => {
  const line = jsonLine(`git log -1 '--format=%H%n%(trailers)'`)
  assert.ok(!(await hits(line)).includes(TRAILERS))
})

// --- P1 2: the factory fixture text is not a webkit hit ----------------------------------------------------------

test('P1 2: the factory fixture const ENV_LINE text is not a webkit-host-missing-dependencies hit', async () => {
  const line = `const ENV_LINE = 'Error: browserType.launch: Host system is missing dependencies to run browsers.'`
  assert.ok(!(await hits(line)).includes(WEBKIT))
})

// --- controls: the real incident text still hits -----------------------------------------------------------------

test('control 1: P1 webkit, F-17 quote still hits webkit-host-missing-dependencies', async () => {
  const line =
    'Host system is missing dependencies to run browsers. ... sudo apt-get install libicu74 libxml2 libflite1'
  assert.ok((await hits(line)).includes(WEBKIT))
})

test('control 2: P1 trailers, unquoted --format=%(trailers:key=...,valueonly) command still hits', async () => {
  const line = jsonLine('git log -1 --format=%(trailers:key=Truss-Crew,valueonly)')
  assert.ok((await hits(line)).includes(TRAILERS))
})

test('control 3: P1 trailers, unquoted --format=%H%n%(trailers) command still hits', async () => {
  const line = jsonLine('git log -1 --format=%H%n%(trailers)')
  assert.ok((await hits(line)).includes(TRAILERS))
})

test('control 4: P1 trailers, backtick-wrapped prose form still hits', async () => {
  const line = 'I ran `git log -1 --format=%(trailers)` and the guard refused it'
  assert.ok((await hits(line)).includes(TRAILERS))
})
