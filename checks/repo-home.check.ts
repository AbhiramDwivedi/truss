// Root contract for the standalone truss repo home (ADR 0013). Node built-ins only.
// Root: REPO_HOME_ROOT, else the directory above this file.
// The install suite does not run the claude CLI. It computes what an install holds from the rules the files encode:
// the catalog entry's git-subdir path on its ref (main), and the marketplace branch, which is main:marketplace (ADR-0013).
// A real `claude plugin install` run is opt-in: checks/real-cli-install.e2e.ts.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.REPO_HOME_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))
const txt = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const rd = (p: string) => JSON.parse(txt(p))
const git = (...a: string[]) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' })
const INSTALL = ['claude plugin marketplace add AbhiramDwivedi/truss', 'truss@truss']

describe('repo-home hygiene', () => {
  it('LICENSE is MIT text naming Abhiram Dwivedi', () => {
    const l = txt('LICENSE')
    assert.match(l, /^MIT License/)
    assert.match(l, /Permission is hereby granted, free of charge/)
    assert.match(l, /Abhiram Dwivedi/)
  })
  it('LICENSE matches plugin.json license', () => {
    const pj = existsSync(join(ROOT, '.claude-plugin/plugin.json')) ? rd('.claude-plugin/plugin.json') : rd('plugins/truss/.claude-plugin/plugin.json')
    assert.equal(typeof pj.license, 'string', 'plugin.json has no license field')
    assert.equal(pj.license, 'MIT')
    assert.match(txt('LICENSE'), /^MIT License/)
  })
  it('.gitignore lists the hygiene lines in order', () => {
    const lines = txt('.gitignore').split('\n').map((s) => s.trim())
    let at = -1
    // 'node_modules' has no trailing slash so it also ignores the ui/node_modules symlink in worktrees
    for (const l of ['__pycache__/', '*.pyc', 'node_modules', '.claude/worktrees/', '.claude/settings.local.json', '**/.claude-plugin/types/']) {
      const i = lines.indexOf(l)
      assert.ok(i >= 0, `.gitignore lacks ${l}`)
      assert.ok(i > at, `.gitignore lacks ${l} after the previous line`)
      at = i
    }
  })
})

describe('repo-home layout', () => {
  it('plugins/truss holds plugin.json', () => assert.ok(existsSync(join(ROOT, 'plugins/truss/.claude-plugin/plugin.json'))))
  it('no plugin path remains at the root', () => {
    for (const p of ['agents', 'skills', 'hooks', 'workflows', 'bin', 'brief', 'scripts', 'types', 'tests', 'evals', 'retro', '.claude-plugin'])
      assert.equal(git('ls-files', '-co', '--exclude-standard', '--', p).trim(), '', `root still holds ${p}`)
  })
  it('plugins/truss/LICENSE equals LICENSE', () => assert.ok(readFileSync(join(ROOT, 'plugins/truss/LICENSE')).equals(readFileSync(join(ROOT, 'LICENSE')))))
  it('no tracked .pyc', () => assert.equal(git('ls-files', '*.pyc').trim(), ''))
  it('root package.json has no dependencies and a test script', () => {
    const p = rd('package.json')
    assert.equal(p.dependencies, undefined)
    assert.equal(p.devDependencies, undefined)
    assert.equal(p.scripts?.test, 'node --test plugins/truss/tests/*.check.ts plugins/truss/tests/*/*.check.ts && node --test checks/*.check.ts')
  })
  it('.claude/truss.json names plugins/truss docs', () => {
    const t = rd('.claude/truss.json')
    assert.equal(t.architecture, 'plugins/truss/docs/architecture.md')
    assert.equal(t.adr, 'plugins/truss/docs/adr')
  })
})

describe('repo-home marketplace', () => {
  it('catalog is named truss with an owner and one truss entry without version', () => {
    const m = rd('marketplace/.claude-plugin/marketplace.json')
    assert.equal(m.name, 'truss')
    assert.ok(m.owner?.name)
    assert.equal(m.plugins.length, 1)
    assert.equal(m.plugins[0].name, 'truss')
    assert.equal(m.plugins[0].version, undefined)
  })
  it('entry source is git-subdir main:plugins/truss', () => {
    const m = rd('marketplace/.claude-plugin/marketplace.json')
    assert.deepEqual(m.plugins[0].source, { source: 'git-subdir', url: 'https://github.com/AbhiramDwivedi/truss.git', path: 'plugins/truss', ref: 'main' }, 'marketplace entry source differs')
  })
  it('marketplace/ tracks exactly two files', () => {
    assert.deepEqual(git('ls-files', 'marketplace').trim().split('\n').sort(), ['marketplace/.claude-plugin/marketplace.json', 'marketplace/README.md'])
  })
})

// The files main holds under `prefix` (tracked plus unignored), relative to it: what a fetch of main:<prefix> gets.
function filesUnder(prefix: string): string[] {
  const out = git('ls-files', '-co', '--exclude-standard', '-z', '--', prefix || '.').split('\0').filter(Boolean)
  return out.filter((f) => existsSync(join(ROOT, f))).map((f) => (prefix ? f.slice(prefix.length + 1) : f)).sort()
}
const tops = (files: string[]) => [...new Set(files.map((f) => f.split('/')[0]))].sort()
const dirsNamed = (files: string[], name: string) => files.filter((f) => f.split('/').slice(0, -1).includes(name))

// The install as Claude Code builds it: the plugin cache is the catalog entry's git-subdir path on its ref (main),
// and the marketplace clone is the default branch, which the release makes with `git subtree split --prefix=marketplace main`.
function computedInstall(entry = rd('marketplace/.claude-plugin/marketplace.json').plugins[0]) {
  assert.equal(entry.source.source, 'git-subdir', 'the truss entry is not a git-subdir source')
  assert.equal(entry.source.ref, 'main', 'the truss entry does not fetch main')
  return { cache: filesUnder(entry.source.path), clone: filesUnder('marketplace') }
}

describe('repo-home install', () => {
  const { cache, clone } = computedInstall()
  it('cache holds plugin.json at the plugins/truss version', () => {
    assert.ok(cache.includes('.claude-plugin/plugin.json'), 'plugin cache lacks .claude-plugin/plugin.json')
    assert.match(rd('plugins/truss/.claude-plugin/plugin.json').version, /^\d+\.\d+\.\d+$/)
  })
  it('plugin cache has agents/', () => assert.ok(tops(cache).includes('agents'), 'plugin cache lacks agents/'))
  it('plugin cache has no ui/', () => assert.ok(!tops(cache).includes('ui'), 'plugin cache holds ui/'))
  it('plugin cache has no checks/, plugins/ or package.json', () => {
    for (const n of ['checks', 'plugins', 'package.json']) assert.ok(!tops(cache).includes(n), `plugin cache holds ${n}`)
  })
  it('marketplace clone has the catalog and no ui/', () => {
    assert.ok(clone.includes('.claude-plugin/marketplace.json'), 'no catalog in the marketplace clone')
    assert.ok(!tops(clone).includes('ui'), 'marketplace clone holds ui/')
  })
  it('no ui dir anywhere in the cache or the clone', () => {
    assert.deepEqual([...dirsNamed(cache, 'ui'), ...dirsNamed(clone, 'ui')], [], 'install holds ui/')
  })
  it('control: an entry with path "" would install ui/ and checks/, so the cases above can fail', () => {
    const wide = computedInstall({ source: { source: 'git-subdir', path: '', ref: 'main' } }).cache
    assert.ok(dirsNamed(wide, 'ui').length > 0 && tops(wide).includes('checks'), `a whole-repo install lacks ui/ or checks/: ${tops(wide).join(', ')}`)
  })
})

describe('repo-home docs', () => {
  for (const f of ['README.md', 'plugins/truss/README.md', 'marketplace/README.md']) {
    it(`${f} has the install lines`, () => {
      const s = txt(f)
      for (const l of INSTALL) assert.ok(s.includes(l), `${f} lacks ${l}`)
    })
    it(`${f} has no claude-ops install`, () => {
      const s = txt(f)
      for (const l of ['truss@claude-ops']) assert.ok(!s.includes(l), `${f} has ${l}`)
    })
  }
  it('newest CHANGELOG entry names truss@truss', () => {
    const s = txt('plugins/truss/CHANGELOG.md')
    const i = s.search(/^## \d+\.\d+\.\d+/m)
    assert.ok(i >= 0, 'no version heading')
    const rest = s.slice(i + 3)
    const j = rest.search(/^## /m)
    assert.ok((j < 0 ? rest : rest.slice(0, j)).includes('truss@truss'), 'newest CHANGELOG entry lacks truss@truss')
  })
})
