// Root contract for the standalone truss repo home (ADR 0013). Node built-ins only.
// Root: REPO_HOME_ROOT, else git rev-parse --show-toplevel. The install suite redirects GitHub URLs with git insteadOf.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const run = promisify(execFile)
const ROOT = process.env.REPO_HOME_ROOT ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const txt = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const rd = (p: string) => JSON.parse(txt(p))
const git = (...a: string[]) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' })
const ID = ['-c', 'user.name=repo-home', '-c', 'user.email=repo-home@invalid']
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
    for (const l of ['__pycache__/', '*.pyc', 'node_modules/', '.claude/worktrees/', '.claude/settings.local.json', '**/.claude-plugin/types/']) {
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
    assert.equal(typeof p.scripts?.test, 'string')
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
    assert.deepEqual(m.plugins[0].source, { source: 'git-subdir', url: 'AbhiramDwivedi/truss', path: 'plugins/truss', ref: 'main' }, 'marketplace entry source differs')
  })
  it('marketplace/ tracks exactly two files', () => {
    assert.deepEqual(git('ls-files', 'marketplace').trim().split('\n').sort(), ['marketplace/.claude-plugin/marketplace.json', 'marketplace/README.md'])
  })
})

// Copy the tracked and unignored files of `from` (under `sub`, if given) into a fresh repo on `branch`.
function snapshot(from: string, sub: string, to: string, branch: string) {
  const files = execFileSync('git', ['-C', from, 'ls-files', '-co', '--exclude-standard', '-z', '--', sub || '.'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  mkdirSync(to, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', branch, to])
  for (const f of files) {
    const src = join(from, f)
    if (!existsSync(src) || statSync(src).isDirectory()) continue
    const dst = join(to, sub ? f.slice(sub.length + 1) : f)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
  }
  execFileSync('git', ['-C', to, 'add', '-A'])
  execFileSync('git', ['-C', to, ...ID, 'commit', '-qm', branch])
}

describe('repo-home install', () => {
  let cfg = ''
  let cache = ''
  let vs: string[] = []
  let server: http.Server | undefined
  let t = ''
  before(async () => {
    t = mkdtempSync(join(tmpdir(), 'repo-home-'))
    snapshot(ROOT, '', join(t, 'main'), 'main')
    snapshot(ROOT, 'marketplace', join(t, 'mk'), 'marketplace')
    const bare = join(t, 'srv', 'truss.git')
    execFileSync('git', ['clone', '-q', '--bare', join(t, 'main'), bare])
    execFileSync('git', ['-C', bare, 'fetch', '-q', join(t, 'mk'), 'marketplace:marketplace'])
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/marketplace'])
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x')
      const p = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: join(t, 'srv'), GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(u.pathname), QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '', GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''), REMOTE_ADDR: '127.0.0.1' } })
      req.pipe(p.stdin)
      let buf = Buffer.alloc(0)
      let head = false
      p.stdout.on('data', (d: Buffer) => {
        if (head) { res.write(d); return }
        buf = Buffer.concat([buf, d])
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) return
        head = true
        let status = 200
        for (const l of buf.subarray(0, i).toString().split('\r\n')) {
          const k = l.indexOf(':')
          const n = l.slice(0, k)
          const v = l.slice(k + 1).trim()
          if (/^status$/i.test(n)) status = parseInt(v)
          else res.setHeader(n, v)
        }
        res.writeHead(status)
        res.write(buf.subarray(i + 4))
      })
      p.stdout.on('end', () => res.end())
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    const gc = join(t, 'gitconfig')
    writeFileSync(gc, `[url "http://127.0.0.1:${port}/truss.git"]\n\tinsteadOf = https://github.com/AbhiramDwivedi/truss.git\n\tinsteadOf = https://github.com/AbhiramDwivedi/truss\n\tinsteadOf = git@github.com:AbhiramDwivedi/truss.git\n\tinsteadOf = git@github.com:AbhiramDwivedi/truss\n\tinsteadOf = ssh://git@github.com/AbhiramDwivedi/truss.git\n`)
    cfg = join(t, 'config')
    mkdirSync(cfg)
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: gc, GIT_TERMINAL_PROMPT: '0' }
    // claude is looked up on PATH; a missing claude or a failing command rejects here, so every it fails.
    await run('claude', ['plugin', 'marketplace', 'add', 'AbhiramDwivedi/truss'], { env })
    await run('claude', ['plugin', 'install', 'truss@truss'], { env })
    vs = readdirSync(join(cfg, 'plugins', 'cache', 'truss', 'truss'))
    cache = join(cfg, 'plugins', 'cache', 'truss', 'truss', vs[0] ?? 'none')
  })
  after(() => {
    server?.close()
    if (t) rmSync(t, { recursive: true, force: true })
  })
  it('cache holds one version equal to plugins/truss', () => {
    assert.equal(vs.length, 1, `plugin cache holds ${vs.length} version dirs`)
    assert.equal(JSON.parse(readFileSync(join(cache, '.claude-plugin/plugin.json'), 'utf8')).version, rd('plugins/truss/.claude-plugin/plugin.json').version, 'cache version differs from plugins/truss')
  })
  it('plugin cache has agents/', () => assert.ok(existsSync(join(cache, 'agents')), 'plugin cache lacks agents/'))
  it('plugin cache has no ui/', () => assert.ok(!existsSync(join(cache, 'ui')), 'plugin cache holds ui/'))
  it('plugin cache has no checks/, plugins/ or package.json', () => {
    for (const n of ['checks', 'plugins', 'package.json']) assert.ok(!existsSync(join(cache, n)), `plugin cache holds ${n}`)
  })
  it('marketplace clone has the catalog and no ui/', () => {
    const m = join(cfg, 'plugins', 'marketplaces', 'truss')
    assert.ok(existsSync(join(m, '.claude-plugin', 'marketplace.json')), 'no marketplace clone')
    assert.ok(!existsSync(join(m, 'ui')), 'marketplace clone holds ui/')
  })
  it('no ui dir anywhere under the config', () => {
    const hits: string[] = []
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const p = join(d, e.name)
        if (e.name === 'ui') hits.push(p)
        else walk(p)
      }
    }
    walk(cfg)
    assert.deepEqual(hits, [], 'config holds ui/')
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
      for (const l of ['marketplace add AbhiramDwivedi/claude-ops', 'truss@claude-ops']) assert.ok(!s.includes(l), `${f} has ${l}`)
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
