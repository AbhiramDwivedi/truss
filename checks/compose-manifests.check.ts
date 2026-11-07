// Root contract for truss's plugin dependencies (ADR-0021, compose-ops). Node built-ins only.
// Root: COMPOSE_ROOT, else git rev-parse --show-toplevel. CLAUDE_OPS_ROOT names the local claude-ops checkout (read only, no network).
// The install cases serve the truss repo through a local git http server, as repo-home.check.ts does; a gitconfig with insteadOf
// replaces GIT_CONFIG_GLOBAL=/dev/null for them. Each case gets its own CLAUDE_CONFIG_DIR under a mkdtemp dir.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const run = promisify(execFile)
const ROOT = process.env.COMPOSE_ROOT ?? execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const OPS = process.env.CLAUDE_OPS_ROOT ?? join(homedir(), 'Projects', 'claude-ops')
const txt = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const rd = (p: string) => JSON.parse(txt(p))
const ID = ['-c', 'user.name=compose', '-c', 'user.email=compose@invalid']
const READMES = ['README.md', 'plugins/truss/README.md', 'marketplace/README.md']
const CATALOG = 'marketplace/.claude-plugin/marketplace.json'
const PLUGIN = 'plugins/truss/.claude-plugin/plugin.json'
const SHORTHAND = /url("?: ?"| `| )AbhiramDwivedi\/truss/
const DEPS = { kit: '^0.3.1', worktrees: '^0.8.4', 'subagent-limits': '^0.3.2' }

function depList(): { name: string; marketplace?: string; version?: string }[] {
  const d = rd(PLUGIN).dependencies
  assert.ok(Array.isArray(d), 'plugin.json has no dependencies list')
  return d.map((e: unknown) => (typeof e === 'string' ? { name: e } : (e as { name: string })))
}

function snapshot(from: string, sub: string, to: string, branch: string, mutate?: (dir: string) => void) {
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
  mutate?.(to)
  execFileSync('git', ['-C', to, 'add', '-A'])
  execFileSync('git', ['-C', to, ...ID, 'commit', '-qm', branch])
}

// Install truss into a fresh config dir with the claude-ops checkout added first. Returns the installed plugin ids.
// A failing `plugin install truss@truss` is returned as `error`, not thrown: a missing dependency may refuse the install.
async function install(withAllowlist: boolean): Promise<{ ids: string[]; error: string }> {
  const t = mkdtempSync(join(tmpdir(), 'compose-manifests-'))
  let server: http.Server | undefined
  try {
    snapshot(ROOT, '', join(t, 'main'), 'main')
    snapshot(ROOT, 'marketplace', join(t, 'mk'), 'marketplace', (d) => {
      if (withAllowlist) return
      const f = join(d, '.claude-plugin', 'marketplace.json')
      const m = JSON.parse(readFileSync(f, 'utf8'))
      delete m.allowCrossMarketplaceDependenciesOn
      writeFileSync(f, JSON.stringify(m, null, 2))
    })
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
    const cfg = join(t, 'config')
    mkdirSync(cfg)
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, GIT_CONFIG_GLOBAL: gc, GIT_TERMINAL_PROMPT: '0' }
    // claude is looked up on PATH; a missing claude or a failing marketplace add rejects, so the case fails.
    await run('claude', ['plugin', 'marketplace', 'add', OPS], { env })
    await run('claude', ['plugin', 'marketplace', 'add', 'AbhiramDwivedi/truss'], { env })
    let error = ''
    try {
      await run('claude', ['plugin', 'install', 'truss@truss'], { env })
    } catch (e) {
      error = String((e as { stderr?: string; stdout?: string }).stderr || (e as { stdout?: string }).stdout || e)
    }
    const f = join(cfg, 'plugins', 'installed_plugins.json')
    const ids = existsSync(f) ? Object.keys(JSON.parse(readFileSync(f, 'utf8')).plugins ?? {}).sort() : []
    return { ids, error }
  } finally {
    server?.close()
    rmSync(t, { recursive: true, force: true })
  }
}

describe('compose manifests', () => {
  it('cm 1: plugin.json depends on kit, worktrees and subagent-limits from claude-ops, at 0.19.0', () => {
    const pj = rd(PLUGIN)
    assert.equal(pj.version, '0.19.0', 'plugin.json version is not 0.19.0')
    const got = Object.fromEntries(depList().map((d) => [d.name, `${d.marketplace}:${d.version}`]))
    assert.deepEqual(got, Object.fromEntries(Object.entries(DEPS).map(([n, v]) => [n, `claude-ops:${v}`])), 'plugin.json dependencies differ')
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
  it('cm 7: with both marketplaces added, the install enables all four plugins', async () => {
    const { ids, error } = await install(true)
    assert.deepEqual(ids, ['kit@claude-ops', 'subagent-limits@claude-ops', 'truss@truss', 'worktrees@claude-ops'], `installed ${JSON.stringify(ids)}${error ? `; install said: ${error.slice(0, 300)}` : ''}`)
  })
  it('cm 8: without the allowlist the dependencies are missing (and plugin.json declares them)', async () => {
    assert.equal(depList().length, 3, 'plugin.json declares no dependencies, so none could be missing')
    const { ids } = await install(false)
    for (const d of ['kit@claude-ops', 'worktrees@claude-ops', 'subagent-limits@claude-ops']) assert.ok(!ids.includes(d), `${d} installed without the allowlist: ${JSON.stringify(ids)}`)
  })
})

describe('compose manifests controls', () => {
  it('control: no README names truss@claude-ops', () => {
    for (const f of READMES) assert.ok(!txt(f).includes('truss@claude-ops'), `${f} names truss@claude-ops`)
  })
  it('control: the catalog has one truss entry with an https git-subdir url on main', () => {
    const m = rd(CATALOG)
    assert.equal(m.name, 'truss')
    assert.equal(m.plugins.length, 1)
    assert.deepEqual(m.plugins[0].source, { source: 'git-subdir', url: 'https://github.com/AbhiramDwivedi/truss.git', path: 'plugins/truss', ref: 'main' })
  })
  it('control: every README keeps the truss install lines and plugin.json is named truss', () => {
    assert.equal(rd(PLUGIN).name, 'truss')
    for (const f of READMES) {
      const s = txt(f)
      assert.ok(s.includes('marketplace add AbhiramDwivedi/truss'), `${f} lacks the truss marketplace add`)
      assert.ok(s.includes('truss@truss'), `${f} lacks truss@truss`)
    }
  })
  it('control: the claude CLI runs and the local claude-ops checkout is a marketplace', async () => {
    const r = await run('claude', ['--version'])
    assert.match(r.stdout, /\d+\.\d+\.\d+/)
    assert.equal(JSON.parse(readFileSync(join(OPS, '.claude-plugin', 'marketplace.json'), 'utf8')).name, 'claude-ops')
  })
})
