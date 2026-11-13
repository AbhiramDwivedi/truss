// One-off script that builds the retro-generic fixture from the real wave-4 run dir. Run by hand:
//   node plugins/truss/tests/fixtures/retro-generic/scrub-wave4.ts <wave-4 run dir> <repo>
// It only reads the run dir and the repo. It writes wave4-run.json (a bundle { files: { <path>: <text> } } of what the
// counting step reads) and wave4-git.json (the repo's commits in the run's time window), both next to this file.
// Every home path, session id (uuid) and msgId is replaced with a neutral or stable fake value; line counts, timestamps,
// crew slugs, agent ids, models and token numbers stay as they are. Erasable TypeScript, Node built-ins only.
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const dirArg = process.argv[2]
const repoArg = process.argv[3]
if (!dirArg || !repoArg) {
  process.stderr.write('usage: node scrub-wave4.ts <wave-4 run dir> <repo>\n')
  process.exit(2)
}
const runDir: string = dirArg
const repo: string = repoArg

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const MSG = /msg_[A-Za-z0-9]+/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z][A-Za-z0-9-]*/g
const HOME_POSIX = /\/(?:home|Users)\/[^/\s"'\\]+/g
const HOME_WIN = /[A-Za-z]:(?:\\\\?|\/)Users(?:\\\\?|\/)[^\\/\s"']+/g
const HOME_ENC = /-(?:home|Users)-[A-Za-z0-9_.]+/g

const runSid = (dirArg.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '').toLowerCase()
const sids = new Map<string, string>()
const msgs = new Map<string, string>()
const pad = (n: number, w: number): string => String(n).padStart(w, '0')

const fakeSid = (u: string): string => {
  const k = u.toLowerCase()
  let v = sids.get(k)
  if (v === undefined) {
    v = k === runSid ? 'sid-wave4' : `sid-${pad(sids.size + 1, 4)}`
    sids.set(k, v)
  }
  return v
}
const fakeMsg = (m: string): string => {
  let v = msgs.get(m)
  if (v === undefined) {
    v = `msg_${pad(msgs.size + 1, 8)}`
    msgs.set(m, v)
  }
  return v
}

const git = (...args: string[]): string => {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', repo, ...args], { windowsHide: true, maxBuffer: 1 << 30, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

// person names to remove: the git user name and TRUSS_SCRUB_NAMES, each word of 4+ characters, plus every user name
// found in a home path
const names = new Set<string>()
const addNames = (s: string): void => {
  for (const w of s.split(/[\s,]+/)) if (w.length >= 4) names.add(w)
}
addNames(spawnSync('git', ['config', 'user.name'], { windowsHide: true, encoding: 'utf8' }).stdout ?? '')
addNames(process.env.TRUSS_SCRUB_NAMES ?? '')
const users = new Set<string>()

const cleanText = (s: string): string => {
  let t = s
  for (const m of t.matchAll(HOME_POSIX)) users.add(m[0].split('/')[2]!)
  for (const m of t.matchAll(HOME_ENC)) users.add(m[0].replace(/^-(?:home|Users)-/, ''))
  t = t.replace(HOME_WIN, '/work').replace(HOME_POSIX, '/work').replace(HOME_ENC, '-work')
  t = t.replace(UUID, fakeSid).replace(MSG, fakeMsg)
  t = t.replace(EMAIL, 'user@example.invalid')
  for (const u of users) t = t.replace(new RegExp(`(?<![A-Za-z0-9])${u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'g'), 'user')
  for (const n of names) t = t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'person')
  return t
}

const files: Record<string, string> = {}
const add = (rel: string, text: string): void => {
  files[rel] = text
}
const readText = (rel: string): string => readFileSync(join(runDir, rel), 'utf8')
const listFiles = (rel: string): string[] => {
  const out: string[] = []
  for (const e of readdirSync(join(runDir, rel)).sort()) {
    const sub = `${rel}/${e}`
    if (statSync(join(runDir, sub)).isDirectory()) out.push(...listFiles(sub))
    else out.push(sub)
  }
  return out
}

// users first: a pre-pass over every source so a user name found late is still removed from early files
const sources: [string, boolean][] = []
for (const f of ['events.jsonl', 'usage.jsonl', 'decisions.md', 'plan.json']) sources.push([f, false])
for (const e of readdirSync(runDir).sort()) if (/^stage-result-.*\.json$/.test(e)) sources.push([e, false])
for (const f of listFiles('checks')) if (f.endsWith('.json')) sources.push([f, false])
for (const f of listFiles('crews')) sources.push([f, false])
for (const crew of readdirSync(join(runDir, 'reports')).sort()) {
  for (const e of readdirSync(join(runDir, 'reports', crew)).sort()) if (/-qc(-\d+)?\.md$/.test(e)) sources.push([`reports/${crew}/${e}`, true])
}
const firstLine = (s: string): string => {
  for (const line of s.split('\n')) if (line.trim() !== '') return `${line}\n`
  return ''
}
const raw = new Map<string, string>()
for (const [rel, cut] of sources) {
  const text = readText(rel)
  raw.set(rel, cut ? firstLine(text) : text)
  cleanText(raw.get(rel)!)
}
for (const [rel, text] of raw) add(rel, cleanText(text))

// the run's time window: first to last timestamp over events and usage
let lo = ''
let hi = ''
for (const f of ['events.jsonl', 'usage.jsonl']) {
  for (const line of readText(f).split('\n')) {
    const m = /"ts":"([^"]+)"/.exec(line)
    if (!m) continue
    if (lo === '' || m[1]! < lo) lo = m[1]!
    if (hi === '' || m[1]! > hi) hi = m[1]!
  }
}

const out = git('log', '--all', '--reverse', '--topo-order', '--no-renames', `--since=${lo}`, `--until=${hi}`, '--numstat', '--format=%x1e%H%x1f%cI%x1f%s%x1f%(trailers:only,unfold)%x1f')
type Commit = { subject: string; ts: string; trailers: string[]; files: { path: string; added: number; deleted: number }[] }
const commits: Commit[] = []
let lastSha = ''
const seen = new Set<string>()
for (const rec of out.split('\x1e')) {
  if (rec.trim() === '') continue
  const parts = rec.split('\x1f')
  const sha = parts[0]!.trim()
  if (seen.has(sha)) continue
  seen.add(sha)
  lastSha = sha
  const trailers = (parts[3] ?? '')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x !== '' && !/^(co-authored-by|signed-off-by|claude-session):/i.test(x))
    .map(cleanText)
  const fs: Commit['files'] = []
  for (const line of (parts[4] ?? '').split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (m) fs.push({ path: m[3]!, added: m[1] === '-' ? 0 : Number(m[1]), deleted: m[2] === '-' ? 0 : Number(m[2]) })
  }
  commits.push({ subject: cleanText(parts[2] ?? ''), ts: parts[1]!.trim(), trailers, files: fs })
}

const sizes: Record<string, number> = {}
for (const c of commits) {
  for (const f of c.files) {
    if (f.path in sizes) continue
    const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', repo, 'show', `${lastSha}:${f.path}`], { windowsHide: true, maxBuffer: 1 << 30 })
    if (r.status !== 0) continue // not in the tree at window end: deleted in the window
    const buf = r.stdout
    if (buf.includes(0)) continue // binary
    let n = 0
    for (const b of buf) if (b === 10) n++
    sizes[f.path] = n
  }
}

const bundleKeys = Object.keys(files).sort()
const bundle = `{"files":{\n${bundleKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(files[k])}`).join(',\n')}\n}}\n`
writeFileSync(join(HERE, 'wave4-run.json'), bundle)
writeFileSync(join(HERE, 'wave4-git.json'), `${JSON.stringify({ commits, sizes }, null, 1)}\n`)
process.stdout.write(`${JSON.stringify({ ok: true, files: bundleKeys.length, bytes: bundle.length, commits: commits.length, window: [lo, hi], sids: sids.size, msgs: msgs.size })}\n`)
