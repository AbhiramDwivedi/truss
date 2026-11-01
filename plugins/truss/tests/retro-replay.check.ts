// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 / R-33: the retro is proved by replaying this session's real transcripts.
// Written from the ADR before retro/ exists.
//
// Run with: TRUSS_REPLAY_TRANSCRIPTS=<session transcript dir> node --test tests/retro-replay.check.ts
//   <session transcript dir> is ~/.claude/projects/<project>/<session id> (its parent holds <session id>.jsonl).
//   TRUSS_REPLAY_DIR (optional) is the session's truss dir; it is read-only here: the test checks nothing in it changes.
// Skipped only while TRUSS_REPLAY_TRANSCRIPTS is unset. Never writes into the truss dir: the extract goes to a temp dir.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_DIR = process.env.TRUSS_REPLAY_TRANSCRIPTS
const TRUSS_DIR = process.env.TRUSS_REPLAY_DIR

const load = async (file: string) => {
  try {
    return await import(pathToFileURL(join(PLUGIN, 'retro', file)).href)
  } catch (e) {
    assert.fail(`producer missing: retro/${file} (${e?.code ?? e?.message})`)
  }
}

// the four problems this session met, with the literal anchor each hit line must hold (R-33)
const EXPECT: Record<string, string> = {
  'webkit-host-libs': 'libicudata',
  'settings-local-not-in-worktrees': 'settings.local.json',
  'worktree-guard-shell-shape': 'Refusing to run it',
  'tracked-pyc': '__pycache__',
}

const tmps: string[] = []
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

// every directory entry and its size and mtime, so "read-only" is checked, not assumed
function snapshot(dir: string): string {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      const s = statSync(p)
      out.push(`${p}|${s.size}|${s.mtimeMs}`)
      if (e.isDirectory()) walk(p)
    }
  }
  walk(dir)
  return out.sort().join('\n')
}

// the text lines of one transcript record that the extractor matches: tool_result text and journal result text
function textLines(rec: any): string[] {
  const texts: string[] = []
  const content = rec?.message?.content
  if (Array.isArray(content)) {
    for (const b of content) {
      if (b?.type !== 'tool_result') continue
      if (typeof b.content === 'string') texts.push(b.content)
      else if (Array.isArray(b.content)) for (const c of b.content) if (typeof c?.text === 'string') texts.push(c.text)
    }
  }
  if (rec?.type === 'result') {
    const walk = (v: any) => {
      if (typeof v === 'string') texts.push(v)
      else if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(rec.result)
  }
  return texts.flatMap(t => t.split('\n'))
}

test('R-33: the extractor finds this session\'s four known problems, and each cited file:line holds the entry\'s anchor and re-matches its pattern', { skip: SESSION_DIR === undefined || SESSION_DIR === '' ? 'TRUSS_REPLAY_TRANSCRIPTS is unset' : false }, async () => {
  assert.ok(SESSION_DIR && existsSync(SESSION_DIR), `TRUSS_REPLAY_TRANSCRIPTS must name an existing session transcript dir: ${SESSION_DIR}`)
  const { loadCatalog } = await load('catalog.ts')
  const { extractSession, writeExtract } = await load('extract.ts')
  const catPath = join(PLUGIN, 'retro', 'catalog.json')
  if (!existsSync(catPath)) assert.fail('producer missing: retro/catalog.json')
  const catalog = loadCatalog(catPath)

  const before = TRUSS_DIR ? snapshot(TRUSS_DIR) : null
  const out = mkdtempSync(join(tmpdir(), 'retro-replay-'))
  tmps.push(out)
  const x = extractSession(SESSION_DIR, catalog)
  const written = writeExtract(out, x)

  // never into the truss dir, and never into the transcripts
  assert.ok(written.startsWith(out + sep), `the extract went to the temp dir, not ${written}`)
  assert.ok(existsSync(written))
  if (TRUSS_DIR) assert.equal(snapshot(TRUSS_DIR), before, 'the replay changed the truss dir')

  assert.equal(x.session, basename(SESSION_DIR))
  assert.ok(x.files.some((f: any) => f.path === `${basename(SESSION_DIR)}.jsonl`), 'the main transcript was read')
  assert.ok(x.files.length > 10, `read ${x.files.length} files; this session has dozens of agent transcripts`)

  const projDir = dirname(SESSION_DIR)
  const cache = new Map<string, string[]>()
  const linesOf = (file: string): string[] => {
    if (!cache.has(file)) cache.set(file, readFileSync(join(projDir, file), 'utf8').split('\n'))
    return cache.get(file)!
  }

  for (const [id, anchor] of Object.entries(EXPECT)) {
    const entry = catalog.entries.find((e: any) => e.id === id)
    assert.ok(entry, `catalog has ${id}`)
    assert.equal(entry.anchor, anchor, `${id}'s anchor`)
    const hits = x.catalogHits.filter((h: any) => h.id === id)
    assert.ok(hits.length > 0, `no catalog hit for ${id} in this session's transcripts`)
    for (const h of hits) {
      const raw = linesOf(h.file)[h.line - 1]
      assert.ok(raw, `${id}: ${h.file}:${h.line} does not exist`)
      let rec: any
      try {
        rec = JSON.parse(raw)
      } catch {
        assert.fail(`${id}: ${h.file}:${h.line} is not a JSON record`)
      }
      const candidates = textLines(rec).filter(l => l.includes(anchor))
      assert.ok(candidates.length > 0, `${id}: ${h.file}:${h.line} holds no text line with the anchor "${anchor}"`)
      const matching = candidates.filter(l => entry.patterns.some((p: string) => new RegExp(p).test(l)))
      assert.ok(matching.length > 0, `${id}: no line at ${h.file}:${h.line} re-matches the entry's patterns`)
      assert.ok(
        matching.some(l => l.trim().slice(0, 200) === h.quote),
        `${id}: the quote at ${h.file}:${h.line} is not the first 200 characters of a matching line (${JSON.stringify(h.quote)})`,
      )
    }
  }
})
