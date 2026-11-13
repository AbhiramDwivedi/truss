// Opt-in end-to-end check: runs the real `claude plugin marketplace add AbhiramDwivedi/truss` and
// `claude plugin install truss@truss` against a local smart-HTTP copy of this repo (ADR-0013, "Scope of the proof").
// The default suite (`npm test`, glob checks/*.check.ts) does not pick this file up; the same install contents are
// proved there without the CLI, by checks/repo-home.check.ts "repo-home install".
//
// Run it with:  npm run test:real-cli   (or: node --test checks/real-cli-install.e2e.ts)
// Needs: node, git and the claude CLI on PATH, and a local port. A missing claude fails the run with a message; it never skips.
// It writes only under a mkdtemp dir: its own CLAUDE_CONFIG_DIR and its own git config (GIT_CONFIG_GLOBAL, no system config),
// so the developer's git and Claude settings play no part. It installs only truss, never claude-ops: whether truss's
// claude-ops dependencies resolve is not this repo's to prove.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = process.env.REPO_HOME_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))
const rd = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'))

// The git config every git call here uses. maintenance.auto and gc.auto are off because a commit in a fresh repo
// otherwise starts a detached auto-maintenance that repacks and deletes loose objects while the next step
// (`git clone --bare`, or git http-backend serving the bare repo) reads them: the clone fails with
// "failed to copy file" or "hardlink different from source", and the served fetch with "bad tree object".
function gitConfig(t: string, port?: number): string {
  const f = join(t, port ? 'gitconfig-served' : 'gitconfig')
  let s = '[user]\n\tname = real-cli\n\temail = real-cli@invalid\n[maintenance]\n\tauto = false\n[gc]\n\tauto = 0\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n'
  if (port) {
    s += `[url "http://127.0.0.1:${port}/truss.git"]\n`
    for (const u of ['https://github.com/AbhiramDwivedi/truss.git', 'https://github.com/AbhiramDwivedi/truss', 'git@github.com:AbhiramDwivedi/truss.git', 'git@github.com:AbhiramDwivedi/truss', 'ssh://git@github.com/AbhiramDwivedi/truss.git']) s += `\tinsteadOf = ${u}\n`
  }
  writeFileSync(f, s)
  return f
}
const gitEnv = (gc: string) => ({ ...process.env, GIT_CONFIG_GLOBAL: gc, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' })

// Copy the tracked and unignored files of ROOT (under `sub`, if given) into a fresh repo on `branch`.
function snapshot(env: NodeJS.ProcessEnv, sub: string, to: string, branch: string) {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-co', '--exclude-standard', '-z', '--', sub || '.'], { encoding: 'utf8' }).split('\0').filter(Boolean)
  mkdirSync(to, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', branch, to], { env })
  for (const f of files) {
    const src = join(ROOT, f)
    if (!existsSync(src) || statSync(src).isDirectory()) continue
    const dst = join(to, sub ? f.slice(sub.length + 1) : f)
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
  }
  execFileSync('git', ['-C', to, 'add', '-A'], { env })
  execFileSync('git', ['-C', to, 'commit', '-qm', branch], { env })
}

function serve(project: string, env: NodeJS.ProcessEnv): http.Server {
  return http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    const p = spawn('git', ['http-backend'], { env: { ...env, GIT_PROJECT_ROOT: project, GIT_HTTP_EXPORT_ALL: '1',
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
        if (/^status$/i.test(l.slice(0, k))) status = parseInt(l.slice(k + 1).trim())
        else res.setHeader(l.slice(0, k), l.slice(k + 1).trim())
      }
      res.writeHead(status)
      res.write(buf.subarray(i + 4))
    })
    p.stdout.on('end', () => res.end())
  })
}

describe('real claude CLI install of truss@truss', () => {
  let cfg = ''
  let cache = ''
  let vs: string[] = []
  let server: http.Server | undefined
  let t = ''
  before(async () => {
    try {
      await run('claude', ['--version'])
    } catch (e) {
      throw new Error(`real-cli-install.e2e.ts needs the claude CLI on PATH, and \`claude --version\` failed (${(e as Error).message.split('\n')[0]}). Install Claude Code, or run only the default suite (npm test), which proves the install contents without the CLI.`)
    }
    t = mkdtempSync(join(tmpdir(), 'real-cli-install-'))
    const env = gitEnv(gitConfig(t))
    snapshot(env, '', join(t, 'main'), 'main')
    snapshot(env, 'marketplace', join(t, 'mk'), 'marketplace')
    const bare = join(t, 'srv', 'truss.git')
    execFileSync('git', ['clone', '-q', '--bare', join(t, 'main'), bare], { env })
    execFileSync('git', ['-C', bare, 'fetch', '-q', join(t, 'mk'), 'marketplace:marketplace'], { env })
    execFileSync('git', ['-C', bare, 'symbolic-ref', 'HEAD', 'refs/heads/marketplace'], { env })
    server = serve(join(t, 'srv'), env)
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    cfg = join(t, 'config')
    mkdirSync(cfg)
    const cli = { ...gitEnv(gitConfig(t, (server.address() as AddressInfo).port)), CLAUDE_CONFIG_DIR: cfg }
    await run('claude', ['plugin', 'marketplace', 'add', 'AbhiramDwivedi/truss'], { env: cli })
    await run('claude', ['plugin', 'install', 'truss@truss'], { env: cli })
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
  it('plugin cache has no ui/, checks/, plugins/ or package.json', () => {
    for (const n of ['ui', 'checks', 'plugins', 'package.json']) assert.ok(!existsSync(join(cache, n)), `plugin cache holds ${n}`)
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
