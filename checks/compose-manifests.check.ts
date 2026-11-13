// Root contract for truss's plugin dependencies (ADR-0021, compose-ops). Node built-ins only.
// Root: COMPOSE_ROOT, else the directory above this file. It reads only truss's own files: plugin.json, the catalog,
// the READMEs and the architecture doc. It never reads, builds or installs claude-ops, and never runs the claude CLI.
// Whether the claude CLI really resolves these dependencies is claude-ops's and Claude Code's concern, not this suite's.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.COMPOSE_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))
const txt = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const rd = (p: string) => JSON.parse(txt(p))
const READMES = ['README.md', 'plugins/truss/README.md', 'marketplace/README.md']
const CATALOG = 'marketplace/.claude-plugin/marketplace.json'
const PLUGIN = 'plugins/truss/.claude-plugin/plugin.json'
const SHORTHAND = /url("?: ?"| `| )AbhiramDwivedi\/truss/
const DEPS = { kit: '^0.4.0', worktrees: '>=0.8.4 <0.11.0', 'subagent-limits': '^0.3.2' }
// One comparator of a semver range as Claude Code's plugin dependencies accept it: ^x.y.z, ~x.y.z, >=, >, <=, <, = or a bare version.
const COMPARATOR = /^(\^|~|>=|<=|>|<|=)?\d+\.\d+\.\d+$/

function depList(): { name: string; marketplace?: string; version?: string }[] {
  const d = rd(PLUGIN).dependencies
  assert.ok(Array.isArray(d), 'plugin.json has no dependencies list')
  return d.map((e: unknown) => (typeof e === 'string' ? { name: e } : (e as { name: string })))
}

describe('compose manifests', () => {
  it('cm 1: plugin.json depends on kit, worktrees and subagent-limits from claude-ops, at the plugin.json version', () => {
    const pj = rd(PLUGIN)
    assert.match(pj.version, /^\d+\.\d+\.\d+$/, 'plugin.json version is not a version')
    const got = Object.fromEntries(depList().map((d) => [d.name, `${d.marketplace}:${d.version}`]))
    assert.deepEqual(got, Object.fromEntries(Object.entries(DEPS).map(([n, v]) => [n, `claude-ops:${v}`])), 'plugin.json dependencies differ')
  })
  it('cm 1b: the READMEs and architecture doc state the plugin.json dependency ranges, not stale ones', () => {
    for (const f of [...READMES, 'plugins/truss/docs/architecture.md']) {
      const t = txt(f)
      for (const v of Object.values(DEPS)) assert.ok(t.includes(v), `${f} does not state ${v}`)
      for (const stale of ['^0.8.4', '^0.3.1']) assert.ok(!t.includes(stale), `${f} still states ${stale}`)
    }
  })
  it('cm 2: the truss catalog allows claude-ops dependencies', () => {
    assert.deepEqual(rd(CATALOG).allowCrossMarketplaceDependenciesOn, ['claude-ops'], 'catalog lacks allowCrossMarketplaceDependenciesOn: ["claude-ops"]')
  })
  it('cm 3: no shorthand git-subdir url in the catalog or the READMEs', () => {
    assert.ok(!SHORTHAND.test(txt(CATALOG)), 'catalog has the shorthand url')
    for (const f of READMES) assert.ok(!SHORTHAND.test(txt(f)), `${f} shows the shorthand git-subdir url`)
  })
  for (const [n, f] of READMES.entries()) {
    it(`cm ${4 + n}: ${f} adds the claude-ops marketplace on a line before the truss marketplace`, () => {
      const lines = txt(f).split('\n')
      const ops = lines.findIndex((l) => l.includes('marketplace add AbhiramDwivedi/claude-ops'))
      const tr = lines.findIndex((l) => l.includes('marketplace add AbhiramDwivedi/truss'))
      assert.ok(tr >= 0, `${f} lost the truss marketplace add line`)
      assert.ok(ops >= 0, `${f} has no 'marketplace add AbhiramDwivedi/claude-ops' line`)
      assert.ok(ops < tr, `${f} adds claude-ops (line ${ops + 1}) after truss (line ${tr + 1})`)
    })
  }
  it('cm 7: every plugin.json dependency is an object with a name, a marketplace and a valid version range, named once', () => {
    const d = rd(PLUGIN).dependencies as unknown[]
    assert.ok(Array.isArray(d) && d.length > 0, 'plugin.json has no dependencies')
    const names = new Set<string>()
    for (const e of d) {
      assert.equal(typeof e, 'object', `dependency ${JSON.stringify(e)} is not an object`)
      const { name, marketplace, version } = e as Record<string, unknown>
      assert.ok(typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name), `dependency ${JSON.stringify(e)} has no valid name`)
      assert.ok(typeof marketplace === 'string' && marketplace.length > 0, `dependency ${name} names no marketplace`)
      assert.ok(typeof version === 'string', `dependency ${name} has no version range`)
      const parts = version.trim().split(/\s+/)
      for (const p of parts) assert.match(p, COMPARATOR, `dependency ${name} has a malformed range ${JSON.stringify(version)}`)
      assert.ok(!names.has(name), `dependency ${name} is listed twice`)
      names.add(name)
    }
  })
  it('cm 8: every marketplace a dependency names is the truss catalog or on its allowlist, and the allowlist names no unused marketplace', () => {
    const m = rd(CATALOG)
    const allow: string[] = m.allowCrossMarketplaceDependenciesOn ?? []
    const used = new Set(depList().map((d) => d.marketplace ?? m.name))
    for (const mk of used) assert.ok(mk === m.name || allow.includes(mk), `plugin.json depends on marketplace ${mk}, which the catalog does not allow`)
    for (const mk of allow) assert.ok(used.has(mk), `the catalog allows ${mk}, but no dependency uses it`)
  })
  it('cm 9: every README adds each dependency marketplace that the catalog allows', () => {
    for (const mk of rd(CATALOG).allowCrossMarketplaceDependenciesOn ?? []) {
      for (const f of READMES) assert.ok(txt(f).includes(`marketplace add AbhiramDwivedi/${mk}`), `${f} does not add the ${mk} marketplace`)
    }
  })
})

describe('compose manifests catalog and READMEs', () => {
  it('no README names truss@claude-ops', () => {
    for (const f of READMES) assert.ok(!txt(f).includes('truss@claude-ops'), `${f} names truss@claude-ops`)
  })
  it('the catalog has one truss entry with an https git-subdir url on main', () => {
    const m = rd(CATALOG)
    assert.equal(m.name, 'truss')
    assert.equal(m.plugins.length, 1)
    assert.deepEqual(m.plugins[0].source, { source: 'git-subdir', url: 'https://github.com/AbhiramDwivedi/truss.git', path: 'plugins/truss', ref: 'main' })
  })
  it('every README keeps the truss install lines and plugin.json is named truss', () => {
    assert.equal(rd(PLUGIN).name, 'truss')
    for (const f of READMES) {
      const s = txt(f)
      assert.ok(s.includes('marketplace add AbhiramDwivedi/truss'), `${f} lacks the truss marketplace add`)
      assert.ok(s.includes('truss@truss'), `${f} lacks truss@truss`)
    }
  })
})
