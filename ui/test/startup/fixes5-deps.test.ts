// fixes5 item 55 (crew ui-fixes5): ui/scripts/check-deps.mjs [uiDir] reports missing installs, and pretest runs it
// before the build. Erasable TypeScript, node:test, built-ins only. Temp dirs come from mkdtemp; no ports.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const script = resolve(here, '../../scripts/check-deps.mjs')
const realPkg = resolve(here, '../../package.json')

const tmpRoot = mkdtempSync(join(tmpdir(), 'truss-fixes5-deps-'))
after(() => { rmSync(tmpRoot, { recursive: true, force: true }) })
let n = 0

// A fake ui dir: package.json with dependency `left-pad` and devDependency `typescript`.
function fakeUi(installed: string[] | null) {
  const d = join(tmpRoot, `ui-${++n}`)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'fake-ui', private: true, dependencies: { 'left-pad': '1.0.0' }, devDependencies: { typescript: '5.0.0' },
  }))
  if (installed !== null) {
    mkdirSync(join(d, 'node_modules'), { recursive: true })
    for (const name of installed) {
      mkdirSync(join(d, 'node_modules', name), { recursive: true })
      writeFileSync(join(d, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
    }
  }
  return d
}
const run = (d: string) => spawnSync(process.execPath, [script, d], { encoding: 'utf8' })

test('i55 1: a fake ui dir with no node_modules exits 1, naming a missing package and npm --prefix ui ci', () => {
  const r = run(fakeUi(null))
  assert.equal(r.status, 1, `stderr: ${r.stderr}`)
  assert.match(r.stderr, /typescript/)
  assert.match(r.stderr, /left-pad/)
  assert.ok(r.stderr.includes('npm --prefix ui ci'), r.stderr)
})

test('i55 2: node_modules exists but typescript is missing: exit 1 and the line names typescript', () => {
  const r = run(fakeUi(['left-pad']))
  assert.equal(r.status, 1, `stderr: ${r.stderr}`)
  assert.match(r.stderr, /typescript/)
  assert.ok(!r.stderr.includes('left-pad'), 'the installed package is not named')
  assert.ok(r.stderr.includes('npm --prefix ui ci'), r.stderr)
})

test('i55 3: ui/package.json pretest runs check-deps before the build', () => {
  const pretest: string = JSON.parse(readFileSync(realPkg, 'utf8')).scripts?.pretest ?? ''
  const at = pretest.indexOf('check-deps')
  const build = pretest.indexOf('npm run build')
  assert.ok(at >= 0, `pretest is "${pretest}"`)
  assert.ok(build >= 0, `pretest is "${pretest}"`)
  assert.ok(at < build, `check-deps must come before the build: "${pretest}"`)
})

test('i55 4: a complete fake node_modules exits 0 and prints nothing', () => {
  const r = run(fakeUi(['left-pad', 'typescript']))
  assert.equal(r.status, 0, `stderr: ${r.stderr}`)
  assert.equal(r.stdout, '')
  assert.equal(r.stderr, '')
})
