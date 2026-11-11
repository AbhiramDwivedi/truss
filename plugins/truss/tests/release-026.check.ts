// @ts-nocheck
// Truss 0.26.0, docs-release: the release metadata, the item 13 closures, the doc and prose fixes of items 16 to 19.
// Each case asserts the fact the prose must state, not a whole sentence, so the writer can phrase it.
//
// Run with: node --test tests/release-026.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(PLUGIN, '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '')
const plugin = (p) => read(`plugins/truss/${p}`)

// The section of a markdown doc under the heading line that matches `head`, up to the next heading of the same depth or higher.
function section(md, head) {
  const lines = md.split('\n')
  const i = lines.findIndex((l) => head.test(l))
  if (i < 0) return ''
  const depth = lines[i].match(/^#+/)?.[0].length ?? 1
  let j = i + 1
  while (j < lines.length && !(/^#+ /.test(lines[j]) && lines[j].match(/^#+/)[0].length <= depth)) j++
  return lines.slice(i, j).join('\n')
}

const changelogEntry = (version) => section(plugin('CHANGELOG.md'), new RegExp(`^## ${version.replace(/\./g, '\\.')}\\b`))

test('release-026: plugin.json is at 0.26.0', () => {
  assert.equal(JSON.parse(plugin('.claude-plugin/plugin.json')).version, '0.26.0')
})

test('release-026: the first CHANGELOG entry is 0.26.0', () => {
  const log = plugin('CHANGELOG.md')
  assert.match(log.split('\n').find((l) => /^## /.test(l)), /^## 0\.26\.0\b/)
  assert.equal(log.match(/^## 0\.26\.0\b/gm)?.length, 1, 'exactly one 0.26.0 entry')
})

test('release-026: the 0.26.0 entry carries the item 13 closures and the heavy-slot starvation bound', () => {
  const entry = changelogEntry('0.26.0')
  assert.ok(entry, 'no 0.26.0 entry')
  // Closures: each lettered gap is named with its letter and the word for how it closed, in the same paragraph.
  const closure = (letter, re, what) => {
    const at = entry.search(new RegExp(`\\(${letter}\\)`))
    assert.ok(at >= 0, `the entry does not name gap (${letter})`)
    assert.match(entry.slice(at, at + 300), re, `gap (${letter}) is not closed as: ${what}`)
  }
  closure('a', /obsolete/i, 'obsolete')
  closure('b', /contract/i, 'accepted by the contract')
  assert.match(entry, /review (item )?5\b/i, 'the entry does not name review 5')
  assert.match(entry.slice(entry.search(/review (item )?5\b/i)), /accepted|contract/i, 'review 5 is not accepted by the contract')
  closure('c', /takeover/i, 'covered by the takeover cases in gates')
  closure('f', /fixed/i, 'fixed')
  // The starvation bound is the one the stage.js comment states; read it at test time.
  const code = plugin('workflows/stage.js')
  const c = code.match(/\/\/ Starvation bound \(gates item 8\):[\s\S]*?(?=\n\n|\n[^/\n])/)
  assert.ok(c, 'the Starvation bound comment is gone from stage.js')
  const text = c[0].replace(/\n\/\/ ?/g, ' ')
  const wait = text.match(/HEAVY_WAIT_MS \((\d+) s/)
  const rounds = text.match(/HEAVY_WAIT_ROUNDS = (\d+)/)
  const minutes = text.match(/about (\d+) minutes/)
  assert.ok(wait && rounds && minutes, 'the comment no longer states the wait, the rounds and the total')
  assert.match(entry, new RegExp(`\\b${wait[1]}\\s*(s\\b|seconds)`), `the entry does not state the ${wait[1]} s wait`)
  assert.match(entry, new RegExp(`\\b(${rounds[1]}|three) (rounds|times)\\b`, 'i'), `the entry does not state ${rounds[1]} rounds`)
  assert.match(entry, new RegExp(`\\b${minutes[1]}\\s*minutes`), `the entry does not state about ${minutes[1]} minutes`)
  assert.match(entry, /not FIFO|non-FIFO|no FIFO/i, 'the entry does not say the slot is not FIFO')
})

test('release-026: the version-pin tests follow plugin.json on a bumped copy', () => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'release-026-')))
  try {
    cpSync(path.join(ROOT, 'plugins', 'truss'), path.join(tmp, 'plugins', 'truss'), { recursive: true, filter: (s) => !/[\\/](node_modules|\.git)([\\/]|$)/.test(s) })
    cpSync(path.join(ROOT, 'checks'), path.join(tmp, 'checks'), { recursive: true })
    cpSync(path.join(ROOT, 'marketplace'), path.join(tmp, 'marketplace'), { recursive: true })
    for (const f of ['package.json', 'README.md']) cpSync(path.join(ROOT, f), path.join(tmp, f))
    const pjPath = path.join(tmp, 'plugins', 'truss', '.claude-plugin', 'plugin.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    pj.version = '9.9.9'
    writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n')
    // A real release puts the new entry first; the pin tests then follow plugin.json for the CHANGELOG too.
    const logPath = path.join(tmp, 'plugins', 'truss', 'CHANGELOG.md')
    const log = readFileSync(logPath, 'utf8').replace(/\r/g, '')
    const at = log.search(/^## /m)
    writeFileSync(logPath, `${log.slice(0, at)}## 9.9.9 - bumped copy\n\n- test\n\n${log.slice(at)}`)
    const env = { ...process.env, COMPOSE_ROOT: tmp }
    delete env.NODE_TEST_CONTEXT
    const runs = [
      [path.join(tmp, 'plugins', 'truss', 'tests', 'autonomy-prose.check.ts'), 'plugin json'],
      [path.join(tmp, 'plugins', 'truss', 'tests', 'personas-prose.check.ts'), 'ADR-0032 exists'],
      [path.join(tmp, 'checks', 'compose-manifests.check.ts'), 'cm 1:'],
      [path.join(tmp, 'plugins', 'truss', 'tests', 'crew-knowledge-prose.check.ts'), 'ADR-0033 exists'],
    ]
    for (const [file, pattern] of runs) {
      const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file], { cwd: tmp, env, encoding: 'utf8', windowsHide: true })
      const out = `${r.stdout}${r.stderr}`
      assert.equal(r.status, 0, `${path.basename(file)} fails on a plugin.json at 9.9.9:\n${out.slice(-1500)}`)
      assert.match(r.stdout, /^ *ok \d+ - /m, `${path.basename(file)} ran no case matching ${pattern}`)
      assert.doesNotMatch(r.stdout, /^ *not ok /m)
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('release-026: ADR-0039 no longer carries the two wrong sentences', () => {
  const adr = plugin('docs/adr/0039-unattended-start.md')
  const start = adr.split('\n').find((l) => /^0\. \*\*Start\.\*\*/.test(l))
  assert.ok(start, 'no step 0 Start line in the --next flow')
  // Wrong 1 and 2: a stale release is not `claimed`-only. With trust (0.26.0) queue-next also releases a `running` item whose
  // owner session is idle, so "a running item whose session is gone ... stays running" is false.
  assert.doesNotMatch(start, /only while it is `claimed`/, 'the ADR still says a stale release happens only while claimed')
  assert.doesNotMatch(start, /not released as stale/, 'the ADR still says a running item is never released as stale')
  assert.doesNotMatch(start, /stays `running` until someone/, 'the ADR still says a running item stays running until someone moves it')
  // Wrong 3: the held result ends the run without clearing the flag; the run skill clears it on every way out.
  const held = start.split(/(?<=\.) /).find((s) => /`held`/.test(s))
  assert.ok(held, 'the held result is no longer described')
  assert.match(start.slice(start.indexOf('`held`'), start.indexOf('`held`') + 300), /unattended --off/, 'the held result does not clear the unattended flag')
  assert.match(plugin('skills/run/SKILL.md'), /A `held` result[^\n]*\n?[^\n]*unattended --off/, 'the run skill itself lost the held clear-flag step')
})

// ---- line citations -------------------------------------------------------------------------------------------------
const BASES = ['', 'plugins/truss', 'plugins/truss/bin', 'plugins/truss/hooks', 'plugins/truss/workflows', 'plugins/truss/resources', 'plugins/truss/skills', 'plugins/truss/ui/server', 'plugins/worktrees', 'plugins/worktrees/hooks', 'ui/server', 'checks']
const CITE_RE = /(?:`)?((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|js|md|json)):(\d+)(?:-(\d+))?|`:(\d+)(?:-(\d+))?`/g
const GENERIC = new Set(['null', 'true', 'false', 'none', 'then', 'that', 'with', 'from', 'this', 'when', 'only', 'file', 'line', 'path'])
const resolveFile = (p) => {
  for (const b of BASES) {
    const f = path.join(ROOT, b, p)
    if (existsSync(f)) return f
  }
  return null
}
// Names a citation is about: the identifiers in the backtick spans of its clause (the text since the last sentence end), else of its line.
const tokensOf = (text) => {
  const out = new Set()
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    if (/^:?\d+(-\d+)?$/.test(m[1]) || /\.(ts|js|md|json):\d+/.test(m[1])) continue
    for (const w of m[1].match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []) if (!GENERIC.has(w) && !/^(ts|json|node)$/.test(w)) out.add(w)
  }
  return [...out]
}
// A citation whose clause and line name no code symbol is pinned here, path:line -> a token the cited lines hold.
const ABOUT = {
  'skills/run/SKILL.md:8': 'only one who talks to the client',
  'bin/factory.ts:3102': 'is not a local branch',
  'ui/server/main.ts:80': "join(uiDir, 'web')",
  'worktypes.ts:1': 'The built-in profiles',
}

// Failures of every `path:line` citation in one doc: the file or line is missing, or the cited lines hold none of the names the citation is about.
function citationFailures(docName, doc, about = ABOUT) {
  const fails = []
  doc.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(CITE_RE)) {
      if (m[4] !== undefined) continue // a bare `:N-M` after another citation names a file only by context; not checked
      const rel = m[1]
      const from = Number(m[2])
      const to = Number(m[3] ?? from)
      const where = `${docName}:${i + 1} cites ${rel}:${from}${to !== from ? `-${to}` : ''}`
      if (rel.startsWith('plugins/worktrees/')) continue // another plugin's repo; not in this checkout
      const file = resolveFile(rel)
      if (!file) { fails.push(`${where}: file not found`); continue }
      const lines = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')
      if (from < 1 || to < from || to > lines.length) { fails.push(`${where}: the file has ${lines.length} lines`); continue }
      const held = lines.slice(from - 1, to).join('\n')
      const upto = line.slice(0, m.index)
      const clause = upto.slice(upto.lastIndexOf('. ') + 1)
      const key = `${rel}:${m[2] ?? m[4]}`
      const tokens = about[key] ? [about[key]] : [...new Set([...tokensOf(clause), ...tokensOf(line)])]
      if (tokens.length === 0) continue // names no symbol: only the file and the line range are checked; pin one in ABOUT to check more
      if (!tokens.some((t) => held.includes(t))) fails.push(`${where}: the cited lines hold none of ${tokens.slice(0, 6).join(', ')}`)
    }
  })
  return fails
}

test('release-026: every line citation in architecture.md and the knowledge files resolves', () => {
  // Seeded: a citation to an existing but wrong line must fail, and the right line must pass.
  const store = readFileSync(path.join(PLUGIN, 'bin', 'store.ts'), 'utf8').split('\n')
  const real = store.findIndex((l) => /^const OWNERLESS_MS\b/.test(l)) + 1
  assert.ok(real > 0, 'OWNERLESS_MS is gone from store.ts')
  const wrong = real === 1 ? 2 : 1
  assert.deepEqual(citationFailures('seed', `A lock with no owner counts as stale after 3 s (\`OWNERLESS_MS\`, \`bin/store.ts:${real}\`).`), [])
  const bad = citationFailures('seed', `A lock with no owner counts as stale after 3 s (\`OWNERLESS_MS\`, \`bin/store.ts:${wrong}\`).`)
  assert.equal(bad.length, 1, 'a citation to an existing but wrong line must fail')
  assert.match(bad[0], /hold none of OWNERLESS_MS/)
  assert.equal(citationFailures('seed', 'See `store.ts:99999`.').length, 1, 'a line past the end of the file must fail')

  const docs = ['plugins/truss/docs/architecture.md', ...['product-decisions.md', 'store.md'].map((f) => `docs/knowledge/${f}`)]
  const fails = docs.flatMap((d) => citationFailures(d, read(d)))
  assert.deepEqual(fails, [], `${fails.length} citation(s) do not resolve:\n${fails.join('\n')}`)
})

test('release-026: the architecture doc states the stale-lock rule', () => {
  const store = plugin('bin/store.ts')
  const ownerless = Number(store.match(/^const OWNERLESS_MS = ([\d_]+)/m)?.[1].replace(/_/g, ''))
  const age = Number(store.match(/^const STALE_AGE_MS = ([\d_]+)/m)?.[1].replace(/_/g, ''))
  assert.ok(ownerless > 0 && age > 0, 'store.ts no longer holds OWNERLESS_MS or STALE_AGE_MS')
  const waitMs = Number(store.match(/waitMs\s*=\s*([\d_]+)/)?.[1].replace(/_/g, '') ?? 5000)
  const lockPara = plugin('docs/architecture.md').split('\n').find((l) => /OWNERLESS_MS/.test(l) && /STALE_AGE_MS/.test(l))
  assert.ok(lockPara, 'no paragraph names both stale-lock rules (OWNERLESS_MS and STALE_AGE_MS)')
  assert.match(lockPara, /owner pid is dead|pid is dead|dead (owner|pid)/i, 'the dead-owner rule is missing')
  assert.match(lockPara, new RegExp(`\\b${age / 1000}\\s*s\\b`), `the ${age / 1000} s age rule is missing`)
  assert.match(lockPara, new RegExp(`\\b${ownerless / 1000}\\s*s\\b`), `the ${ownerless / 1000} s ownerless rule is missing`)
  assert.ok(ownerless < waitMs, 'OWNERLESS_MS must stay under the default withLock wait')
  assert.match(lockPara, new RegExp(`(under|below|less than|shorter than|inside|within)[^.]{0,60}(default )?(${waitMs / 1000} s|wait)`, 'i'), `the doc does not say the ${ownerless / 1000} s ownerless rule is under the ${waitMs / 1000} s default wait`)
})

test('release-026: product decisions carry the 21:23 lines and no running sweep', () => {
  const pd = read('docs/knowledge/product-decisions.md')
  assert.match(pd, /21:23/, 'the 21:23 PO ruling is not dated')
  assert.match(pd, /usage\.jsonl/)
  assert.match(pd, /usage-cursor\.json/)
  const at = pd.search(/usage-cursor\.json/)
  assert.match(pd.slice(Math.max(0, at - 400), at + 600), /session (dir|folder)|\bD\b/, 'usage.jsonl and usage-cursor.json are not placed in the session dir')
  assert.match(pd.slice(Math.max(0, at - 400), at + 600), /not (in )?`?shared|not (in )?`?S\b|shared\/`? (is not|not)/i, 'the doc does not say they are not in shared/')
  assert.match(pd, /distinct terms/i, 'agent count and cost budget are not called distinct terms')
  assert.match(pd, /agent count/i)
  assert.match(pd, /cost budget/i)
  assert.match(pd, /phrase-scoped/i, 'the retro and init pins are not called phrase-scoped')
  assert.match(pd, /retro/i)
  assert.match(pd, /init/i)
  assert.doesNotMatch(pd, /usage sweep still running/i, 'the doc still says the usage sweep is still running')
  assert.doesNotMatch(pd, /sweep (is )?still running|still sweeping/i)
})

test('release-026: step 0 of next names escalateError', () => {
  const run = plugin('skills/run/SKILL.md')
  const sec = section(run, /^## Run one queued item unattended/)
  assert.ok(sec, 'the --next section is gone')
  const lines = sec.split('\n')
  const i = lines.findIndex((l) => /^0\. \*\*Start\.\*\*/.test(l))
  assert.ok(i >= 0, 'no step 0')
  let j = i + 1
  while (j < lines.length && !/^1\. /.test(lines[j])) j++
  const step0 = lines.slice(i, j).join('\n')
  assert.match(step0, /escalateError/, 'step 0 does not name escalateError')
  assert.match(step0, /held/, 'escalateError is not tied to the held result')
})

test('release-026: the worktypes header no longer calls it a stub', () => {
  const head = plugin('bin/worktypes.ts').split('\n').slice(0, 3).join('\n')
  assert.doesNotMatch(head, /\bstub\b/i, 'the header still calls worktypes.ts a stub')
  assert.doesNotMatch(head, /b-cost replaces it/i)
  assert.match(plugin('bin/worktypes.ts').split('\n')[0], /^\/\/ Work types/, 'line 1 is no longer the Work types header')
})

test('release-026: the brief large path runs factory unattended off', () => {
  const brief = plugin('skills/brief/SKILL.md')
  const sec = section(brief, /^## Unattended brief/)
  assert.ok(sec, 'no Unattended brief section')
  const bullet = sec.split('\n').find((l) => /^- `large`/.test(l))
  assert.ok(bullet, 'no large bullet')
  assert.match(bullet, /intake-triage/, 'the large bullet no longer escalates intake-triage')
  assert.match(bullet, /unattended --off/, 'the large bullet does not run factory unattended --off')
  assert.ok(bullet.indexOf('unattended --off') < bullet.search(/end the run|ends?\.?$/i) || /unattended --off[^.]*\bend/.test(bullet), 'unattended --off must run before the run ends')
})
