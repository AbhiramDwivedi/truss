// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss ADR-0012 Decision 3 and Decision 7: edge checks for retro/catalog.ts and the seed retro/catalog.json.
// Written from the ADR and docs/catalog.schema.json before retro/ exists. tests/retro-contract.check.ts holds the
// first-line cases (schema, six ids, clean lines, planted hits); this file adds the edges it lacks.
//
// Run with: node --test tests/retro/catalog.check.ts
// Self-contained on purpose: no shared helper, no import of another check file, and no import of retro/extract.ts.
// retro/catalog.ts is imported inside the test that needs it, so a missing file fails that test with
// "producer missing: retro/catalog.ts". Every id, anchor and token below is generated per run (random hex).

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const load = async (file: string) => {
  try {
    return await import(pathToFileURL(join(PLUGIN, 'retro', file)).href)
  } catch (e) {
    assert.fail(`producer missing: retro/${file} (${e?.code ?? e?.message})`)
  }
}
const catalogMod = () => load('catalog.ts')

const tmps: string[] = []
const mktmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'retro-catalog-'))
  tmps.push(d)
  return d
}
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true })
})

const hex = (n = 5) => randomBytes(n).toString('hex')

const entry = (id: string, anchor: string, patterns: string[], extra: any = {}) => ({
  id,
  kind: 'friction',
  title: `title ${id}`,
  anchor,
  patterns,
  fix: `fix for ${id}`,
  fixedBy: null,
  ...extra,
})
const writeCatalog = (dir: string, name: string, entries: any[]) => {
  const p = join(dir, name)
  writeFileSync(p, JSON.stringify({ v: 1, entries }))
  return p
}

// Realistic lines for the six seed ids, copied from tests/doctor-contract.check.ts (SAMPLES).
const SAMPLES: Record<string, string[]> = {
  'webkit-host-libs': [
    'error while loading shared libraries: libicudata.so.66: cannot open shared object file: No such file or directory',
    'Host system is missing dependencies to run browsers. Missing libraries: libicudata.so.74',
    '  libicudata.so.74 => not found',
    'browserType.launch: Target page, context or browser has been closed (libicudata.so.74)',
  ],
  'settings-local-not-in-worktrees': [
    "Error: ENOENT: no such file or directory, open '/repo/.claude/worktrees/truss-x/.claude/settings.local.json'",
    '.claude/settings.local.json is not in the worktree, so the allow rules did not apply',
    'Permission to use Bash has been denied: settings.local.json is untracked and missing in this worktree',
    'settings.local.json is not committed, so a worktree does not see it',
  ],
  'worktree-guard-shell-shape': [
    "This session is isolated in the worktree /repo/.claude/worktrees/x but this command cd's into /repo. Refusing to run it",
    'This session is isolated in the worktree /repo/.claude/worktrees/x but its working directory is /repo. Refusing to run it',
    'This session is isolated in the worktree /w but this command uses a heredoc it cannot show stays inside. Refusing to run it',
  ],
  'harness-only-claude-code': [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'claude-code' imported from /repo/tests/x.check.ts",
    "Cannot find package 'claude-code' imported from /repo/hooks/register.ts",
  ],
  'node-modules-missing': [
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from /repo/ui/server/index.ts",
    "Cannot find package 'zod' imported from /repo/ui/server/state.ts",
  ],
  'tracked-pyc': [
    '\ttests/__pycache__/retro.cpython-312.pyc',
    '?? tests/__pycache__/',
    ' M tests/__pycache__/retro.cpython-312.pyc',
    'Untracked files: tests/__pycache__/x.pyc',
  ],
}

const seedCatalog = async () => {
  const { loadCatalog, matchLine } = await catalogMod()
  const path = join(PLUGIN, 'retro', 'catalog.json')
  if (!existsSync(path)) assert.fail('producer missing: retro/catalog.json')
  return { catalog: loadCatalog(path), matchLine }
}

describe('retro/catalog.json seeds: every realistic line hits its own entry and no other (Decision 3)', () => {
  test('each SAMPLES line hits exactly its own seed, with and without a per-run token on the end', async () => {
    const { catalog, matchLine } = await seedCatalog()
    const ids = catalog.entries.map((e: any) => e.id)
    for (const id of Object.keys(SAMPLES)) assert.ok(ids.includes(id), `seed ${id} is in the catalog`)
    for (const [id, lines] of Object.entries(SAMPLES)) {
      const e = catalog.entries.find((x: any) => x.id === id)
      for (const line of lines) {
        assert.ok(line.includes(e.anchor), `sanity: the sample holds the anchor of ${id}`)
        assert.deepEqual(matchLine(line, catalog), [id], `${id}: ${JSON.stringify(line)}`)
        const tok = hex(4)
        assert.deepEqual(matchLine(`${line} ${tok}`, catalog), [id], `${id}: with a token after`)
        assert.deepEqual(matchLine(`${tok} ${line}`, catalog), [id], `${id}: with a token before`)
      }
    }
  })

  test('the anchor is literal and required: swapping a sample’s anchor for a per-run token removes the hit', async () => {
    const { catalog, matchLine } = await seedCatalog()
    for (const [id, lines] of Object.entries(SAMPLES)) {
      const e = catalog.entries.find((x: any) => x.id === id)
      for (const line of lines) {
        const tok = hex(5)
        const bare = line.replaceAll(e.anchor, tok)
        assert.ok(!bare.includes(e.anchor))
        assert.ok(!matchLine(bare, catalog).includes(id), `${id} hit a line with no anchor: ${JSON.stringify(bare)}`)
      }
    }
  })

  test("the claude-code line hits harness-only-claude-code and not node-modules-missing; any other package is the reverse", async () => {
    const { catalog, matchLine } = await seedCatalog()
    for (const line of SAMPLES['harness-only-claude-code']) {
      const got = matchLine(line, catalog)
      assert.ok(got.includes('harness-only-claude-code'))
      assert.ok(!got.includes('node-modules-missing'), `node-modules-missing must not match 'claude-code': ${JSON.stringify(line)}`)
    }
    const pkg = `pkg${hex(5)}`
    assert.deepEqual(matchLine(`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${pkg}' imported from /repo/${hex(3)}.ts`, catalog), ['node-modules-missing'])
    assert.deepEqual(matchLine(`Cannot find package '${pkg}'`, catalog), ['node-modules-missing'])
  })

  test('a line holding several seeds’ anchors returns their ids in catalog order, not call or alphabetical order', async () => {
    const { catalog, matchLine } = await seedCatalog()
    const ids = catalog.entries.map((e: any) => e.id)
    const first = SAMPLES[ids[0]]
    const last = SAMPLES[ids[ids.length - 1]]
    assert.ok(first && last, 'the first and last catalog entries are seeds')
    assert.deepEqual(matchLine(`${last[0]} || ${first[0]}`, catalog), [ids[0], ids[ids.length - 1]])
    // all six on one line, written in reverse catalog order
    const all = [...ids].reverse().map(id => SAMPLES[id][0])
    assert.deepEqual(matchLine(all.join(' || '), catalog), ids)
  })
})

describe('retro/catalog.ts matchLine: order, anchor and pattern rules on a planted catalog', () => {
  test('catalog order is file order: a later-sorting id listed first is reported first', async () => {
    const { loadCatalog, matchLine } = await catalogMod()
    const dir = mktmp()
    const za = `z-${hex(4)}`
    const aa = `a-${hex(4)}`
    const ma = `m-${hex(4)}`
    const anc = { [za]: `an${hex(4)}`, [aa]: `bn${hex(4)}`, [ma]: `cn${hex(4)}` }
    const cat = loadCatalog(writeCatalog(dir, 'order.json', [entry(za, anc[za], ['.']), entry(aa, anc[aa], ['.']), entry(ma, anc[ma], ['.'])]))
    assert.deepEqual(matchLine(`${anc[ma]} ${anc[aa]} ${anc[za]}`, cat), [za, aa, ma])
    assert.deepEqual(matchLine(`${anc[aa]} ${anc[ma]}`, cat), [aa, ma])
    assert.deepEqual(matchLine(`${anc[ma]}`, cat), [ma])
  })

  test('two matching patterns give one id; a second-pattern-only match hits; the pattern alone without the anchor does not', async () => {
    const { loadCatalog, matchLine } = await catalogMod()
    const dir = mktmp()
    const id = `e-${hex(4)}`
    const anc = `an${hex(5)}`
    const p1 = `p1${hex(4)}`
    const p2 = `p2${hex(4)}`
    const cat = loadCatalog(writeCatalog(dir, 'multi.json', [entry(id, anc, [p1, p2])]))
    assert.deepEqual(matchLine(`${anc} ${p1} ${p2}`, cat), [id], 'both patterns match: one id')
    assert.deepEqual(matchLine(`${anc} only ${p2}`, cat), [id], 'only the second pattern matches')
    assert.deepEqual(matchLine(`${p1} ${p2}`, cat), [], 'both patterns match but the anchor is missing')
    assert.deepEqual(matchLine(`${anc} and nothing else`, cat), [], 'the anchor alone is no hit')
    assert.deepEqual(matchLine('', cat), [])
  })

  test('the anchor is a literal substring, not a regex, and patterns are case-sensitive with no flags', async () => {
    const { loadCatalog, matchLine } = await catalogMod()
    const dir = mktmp()
    const id = `e-${hex(4)}`
    const h = hex(4)
    const anchor = `a.b+(${h})`
    const cat = loadCatalog(writeCatalog(dir, 'literal.json', [entry(id, anchor, ['.'])]))
    assert.deepEqual(matchLine(`x ${anchor} y`, cat), [id], 'the literal anchor hits')
    assert.deepEqual(matchLine(`x aXb${h} y`, cat), [], 'as a regex the anchor would match this; as a literal it does not')
    assert.deepEqual(matchLine(`x a.bb${h} y`, cat), [])
    const id2 = `e-${hex(4)}`
    const low = `lo${hex(4)}`
    const cat2 = loadCatalog(writeCatalog(dir, 'case.json', [entry(id2, low, [`${low}: BAD`])]))
    assert.deepEqual(matchLine(`${low}: BAD`, cat2), [id2])
    assert.deepEqual(matchLine(`${low}: bad`, cat2), [], 'no i flag')
    assert.deepEqual(matchLine(`${low.toUpperCase()}: BAD`, cat2), [], 'the anchor is case-sensitive too')
  })

  test('fixedBy does not change matching: a fixed entry still hits by matchLine; an empty catalog hits nothing', async () => {
    const { loadCatalog, matchLine } = await catalogMod()
    const dir = mktmp()
    const id = `e-${hex(4)}`
    const anc = `an${hex(5)}`
    const cat = loadCatalog(writeCatalog(dir, 'fixed.json', [entry(id, anc, ['.'], { fixedBy: { finding: `s-${hex(3)}/F-2`, date: '2026-10-05' } })]))
    assert.deepEqual(matchLine(`line ${anc}`, cat), [id])
    const none = loadCatalog(writeCatalog(dir, 'empty.json', []))
    assert.deepEqual(none.entries, [])
    assert.deepEqual(matchLine(`line ${anc}`, none), [])
  })
})

describe('retro/catalog.ts loadCatalog: refusals beyond the contract’s', () => {
  test('refuses a duplicate id, empty patterns, an empty pattern, a missing fix, an empty anchor and a missing title', async () => {
    const { loadCatalog } = await catalogMod()
    const dir = mktmp()
    const id = `e-${hex(4)}`
    const anc = `an${hex(5)}`
    const good = entry(id, anc, [anc])
    assert.doesNotThrow(() => loadCatalog(writeCatalog(dir, 'good.json', [good])))
    const other = entry(`e-${hex(4)}`, `bn${hex(5)}`, ['.'])
    assert.doesNotThrow(() => loadCatalog(writeCatalog(dir, 'two.json', [good, other])), 'two distinct entries load')
    assert.throws(() => loadCatalog(writeCatalog(dir, 'dup.json', [good, { ...other, id }])), 'a duplicate id')
    assert.throws(() => loadCatalog(writeCatalog(dir, 'nopat.json', [{ ...good, patterns: [] }])), 'empty patterns')
    assert.throws(() => loadCatalog(writeCatalog(dir, 'emptypat.json', [{ ...good, patterns: [''] }])), 'an empty pattern')
    const { fix: _fix, ...nofix } = good
    assert.throws(() => loadCatalog(writeCatalog(dir, 'nofix.json', [nofix])), 'a missing fix')
    assert.throws(() => loadCatalog(writeCatalog(dir, 'emptyfix.json', [{ ...good, fix: '' }])), 'an empty fix')
    assert.throws(() => loadCatalog(writeCatalog(dir, 'emptyanchor.json', [{ ...good, anchor: '' }])), 'an empty anchor')
    const { title: _title, ...notitle } = good
    assert.throws(() => loadCatalog(writeCatalog(dir, 'notitle.json', [notitle])), 'a missing title')
  })

  test('refuses a bad kind, a fixedBy that is not null or {finding, date}, a bad probe, an extra property and a bad top level', async () => {
    const { loadCatalog } = await catalogMod()
    const dir = mktmp()
    const good = entry(`e-${hex(4)}`, `an${hex(5)}`, ['.'])
    const bad = (name: string, e: any) => writeCatalog(dir, name, [e])
    assert.throws(() => loadCatalog(bad('kind.json', { ...good, kind: 'cosmetic' })))
    assert.throws(() => loadCatalog(bad('fixedby-str.json', { ...good, fixedBy: 'F-1' })))
    assert.throws(() => loadCatalog(bad('fixedby-nodate.json', { ...good, fixedBy: { finding: 's/F-1' } })))
    assert.throws(() => loadCatalog(bad('fixedby-date.json', { ...good, fixedBy: { finding: 's/F-1', date: 'yesterday' } })))
    assert.throws(() => loadCatalog(bad('fixedby-missing.json', (({ fixedBy, ...r }) => r)(good))))
    assert.throws(() => loadCatalog(bad('probe-kind.json', { ...good, probe: { kind: 'magic', run: 'true' } })))
    assert.throws(() => loadCatalog(bad('probe-norun.json', { ...good, probe: { kind: 'command' } })))
    assert.throws(() => loadCatalog(bad('extra.json', { ...good, [`x${hex(3)}`]: 1 })))
    assert.doesNotThrow(() => loadCatalog(bad('probe-ok.json', { ...good, probe: { kind: 'file', path: `p-${hex(3)}` } })))
    assert.doesNotThrow(() => loadCatalog(bad('probe-cmd.json', { ...good, probe: { kind: 'command', run: 'true' } })))
    const top = (name: string, obj: any) => {
      const p = join(dir, name)
      writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj))
      return p
    }
    assert.throws(() => loadCatalog(top('notjson.json', `{"v":1,"entries":[${hex(3)}`)), 'a truncated file')
    assert.throws(() => loadCatalog(top('empty-file.json', '')), 'an empty file')
    assert.throws(() => loadCatalog(top('entries-obj.json', { v: 1, entries: {} })), 'entries is not an array')
    assert.throws(() => loadCatalog(top('no-entries.json', { v: 1 })), 'no entries key')
    assert.throws(() => loadCatalog(top('no-v.json', { entries: [good] })), 'no v')
    assert.throws(() => loadCatalog(top('extra-top.json', { v: 1, entries: [good], [`y${hex(3)}`]: true })), 'an extra top-level key')
  })
})

describe('retro/catalog.ts recurrences(x, catalog): fixed entries that were hit (Decision 7)', () => {
  const fixedBy = (sid: string, n: number) => ({ finding: `${sid}/F-${n}`, date: '2026-10-0' + String(n) })
  const extractWith = (sid: string, hits: any[]) => ({
    v: 1,
    session: sid,
    files: [{ path: `${sid}.jsonl`, lines: 40 }],
    items: [],
    catalogHits: hits,
    skipped: { json: 0, type: {} },
  })
  const hit = (id: string, sid: string, line: number) => ({ id, file: `${sid}.jsonl`, line, quote: `${id} quote ${hex(3)}` })

  test('a fixed entry that was hit is reported; a fixed entry with no hit and an unfixed entry that was hit are not', async () => {
    const { loadCatalog, recurrences } = await catalogMod()
    const dir = mktmp()
    const sid = `s-${hex(6)}`
    const hitFixed = `hf-${hex(4)}`
    const quietFixed = `qf-${hex(4)}`
    const hitOpen = `ho-${hex(4)}`
    const twiceFixed = `tf-${hex(4)}`
    const cat = loadCatalog(
      writeCatalog(dir, 'rec.json', [
        entry(hitFixed, `a1${hex(4)}`, ['.'], { fixedBy: fixedBy(`old-${hex(3)}`, 1) }),
        entry(quietFixed, `a2${hex(4)}`, ['.'], { fixedBy: fixedBy(`old-${hex(3)}`, 2) }),
        entry(hitOpen, `a3${hex(4)}`, ['.']),
        entry(twiceFixed, `a4${hex(4)}`, ['.'], { fixedBy: fixedBy(`old-${hex(3)}`, 3) }),
      ]),
    )
    const x = extractWith(sid, [hit(hitFixed, sid, 7), hit(hitOpen, sid, 9), hit(twiceFixed, sid, 11), hit(twiceFixed, sid, 21)])
    const out = recurrences(x, cat)
    assert.ok(Array.isArray(out), 'an array')
    const s = JSON.stringify(out)
    assert.ok(s.includes(hitFixed), 'the fixed entry that was hit')
    assert.ok(s.includes(twiceFixed), 'the fixed entry hit twice')
    assert.ok(!s.includes(quietFixed), 'a fixed entry with no hit')
    assert.ok(!s.includes(hitOpen), 'an unfixed entry that was hit')
  })

  test('no hits, only unfixed hits, and a hit on an id the catalog does not hold all give an empty array and no throw', async () => {
    const { loadCatalog, recurrences } = await catalogMod()
    const dir = mktmp()
    const sid = `s-${hex(6)}`
    const fixed = `f-${hex(4)}`
    const open = `o-${hex(4)}`
    const cat = loadCatalog(writeCatalog(dir, 'rec2.json', [entry(fixed, `a1${hex(4)}`, ['.'], { fixedBy: fixedBy('old', 4) }), entry(open, `a2${hex(4)}`, ['.'])]))
    assert.deepEqual(recurrences(extractWith(sid, []), cat), [])
    assert.deepEqual(recurrences(extractWith(sid, [hit(open, sid, 3)]), cat), [])
    const ghost = `g-${hex(4)}`
    let out: any
    assert.doesNotThrow(() => {
      out = recurrences(extractWith(sid, [hit(ghost, sid, 3)]), cat)
    })
    assert.deepEqual(out, [])
  })

  test('which fixed entries are named follows the hits, run to run: the same catalog with other hits names other ids', async () => {
    const { loadCatalog, recurrences } = await catalogMod()
    const dir = mktmp()
    const sid = `s-${hex(6)}`
    const a = `fa-${hex(4)}`
    const b = `fb-${hex(4)}`
    const cat = loadCatalog(writeCatalog(dir, 'rec3.json', [entry(a, `a1${hex(4)}`, ['.'], { fixedBy: fixedBy('old', 5) }), entry(b, `a2${hex(4)}`, ['.'], { fixedBy: fixedBy('old', 6) })]))
    const onlyA = JSON.stringify(recurrences(extractWith(sid, [hit(a, sid, 2)]), cat))
    const onlyB = JSON.stringify(recurrences(extractWith(sid, [hit(b, sid, 2)]), cat))
    const both = JSON.stringify(recurrences(extractWith(sid, [hit(b, sid, 2), hit(a, sid, 5)]), cat))
    assert.ok(onlyA.includes(a) && !onlyA.includes(b))
    assert.ok(onlyB.includes(b) && !onlyB.includes(a))
    assert.ok(both.includes(a) && both.includes(b))
  })
})
