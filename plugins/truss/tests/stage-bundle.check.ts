// @ts-nocheck
// truss 0.31.0, speed goal item 5: workflows/stage.js is generated from the modules in workflows/stage/ by bin/build-stage.ts
// (`npm run build:stage`). A Workflow script must be one file (ADR-0009; factory start copies it byte for byte), so the bundle is
// committed. These cases fail when a module is edited without a rebuild, or the build stops being deterministic.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { GENERATED_HEADER, STAGE_MODULES, WORKFLOWS_DIR, buildStage } from '../bin/build-stage.ts'

const BUILD = path.join(import.meta.dirname, '..', 'bin', 'build-stage.ts')
const STAGE_JS = path.join(WORKFLOWS_DIR, 'stage.js')
const tmp = (p) => mkdtempSync(path.join(tmpdir(), p))
const copyModules = () => {
  const d = tmp('stage-bundle-')
  cpSync(path.join(WORKFLOWS_DIR, 'stage'), path.join(d, 'stage'), { recursive: true })
  return d
}

test('stage bundle: a rebuild into a temp dir is byte-identical to the committed stage.js', () => {
  const out = path.join(tmp('stage-bundle-out-'), 'stage.js')
  const r = spawnSync(process.execPath, [BUILD, '--out', out], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.ok(readFileSync(out).equals(readFileSync(STAGE_JS)), 'stage.js is out of date with workflows/stage/*.js: run npm run build:stage')
  assert.equal(buildStage(), readFileSync(STAGE_JS, 'utf8'))
})

test('stage bundle: stage.js starts with the generated header, then the meta block', () => {
  const text = readFileSync(STAGE_JS, 'utf8')
  assert.ok(text.startsWith(GENERATED_HEADER))
  assert.ok(text.slice(GENERATED_HEADER.length).startsWith('export const meta = {'))
  assert.ok(!text.includes('\r'), 'LF line ends only')
})

test('stage bundle: every module is listed once and starts with its module comment', () => {
  assert.equal(new Set(STAGE_MODULES).size, STAGE_MODULES.length)
  const found = readdirSync(path.join(WORKFLOWS_DIR, 'stage')).filter((f) => f.endsWith('.js')).sort()
  assert.deepEqual(found, STAGE_MODULES.map((m) => `${m}.js`).sort())
  for (const m of STAGE_MODULES) assert.match(readFileSync(path.join(WORKFLOWS_DIR, 'stage', `${m}.js`), 'utf8'), /^\/\/ stage\.js module: /, m)
})

test('stage bundle: an edited module changes the bundle, and CRLF modules build the same bytes', () => {
  const d = copyModules()
  const f = path.join(d, 'stage', 'ruling.js')
  const orig = readFileSync(f, 'utf8')
  writeFileSync(f, orig.replace(/\n/g, '\r\n'))
  assert.equal(buildStage(d), buildStage())
  writeFileSync(f, `${orig}// edited\n`)
  assert.notEqual(buildStage(d), buildStage())
})

test('stage bundle: a module not in STAGE_MODULES, a missing one or one without its comment is refused', () => {
  const extra = copyModules()
  writeFileSync(path.join(extra, 'stage', 'stray.js'), '// stage.js module: stray.\n')
  assert.throws(() => buildStage(extra), /not in STAGE_MODULES.*stray\.js/)
  const head = copyModules()
  const f = path.join(head, 'stage', 'qc.js')
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^[^\n]*\n/, ''))
  assert.throws(() => buildStage(head), /qc\.js: the first line/)
  const missing = tmp('stage-bundle-empty-')
  cpSync(path.join(WORKFLOWS_DIR, 'stage', 'args.js'), path.join(missing, 'stage', 'args.js'))
  assert.throws(() => buildStage(missing), /missing from/)
})
