// Notice-copy tests for crew ui-notices (ADR-0014 seam 5): the `no-config` and `no-truss-dir`
// notices read as status, not error. The `Status:` tag is added by ui/web, so the server text
// carries no tag. Written from the spec; goes through createStore and snapshot().state.notices.
// Self-contained: helpers copied from ui/test/state/store.test.ts, nothing imported from a test.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(path.dirname(here))
const root = path.dirname(uiDir)
const producer: any = await import(pathToFileURL(path.join(uiDir, 'server/state/index.ts')).href)

const fixtureDir = path.join(root, 'tests/fixtures/retro-040')
const planExample = path.join(root, 'docs/plan.example.json')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-state-notices-'))
let counter = 0

interface World { base: string; repo: string; truss: string }

function makeWorld(config: Record<string, unknown> | null = { architecture: 'docs/architecture.md', adr: 'docs/adr', merge: 'sequential', target: 'main' }): World {
  const base = path.join(tmpRoot, `w${++counter}`)
  const repo = path.join(base, 'repo')
  const truss = path.join(base, 'truss')
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'docs/adr'), { recursive: true })
  if (config !== null) fs.writeFileSync(path.join(repo, '.claude/truss.json'), JSON.stringify(config))
  fs.writeFileSync(path.join(repo, 'docs/architecture.md'), '# Architecture\n\nA line.\n')
  fs.writeFileSync(path.join(repo, 'docs/adr/0001-first.md'), '# ADR-0001: first choice\n\nStatus: accepted, 2026-01-02\n')
  fs.cpSync(fixtureDir, truss, { recursive: true })
  fs.copyFileSync(planExample, path.join(truss, 'plan.json'))
  return { base, repo, truss }
}

async function until(store: any, pred: (s: any) => boolean, ms: number, what: string): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const s = store.snapshot().state
    let ok = false
    try { ok = pred(s) } catch { ok = false }
    if (ok) return Date.now() - t0
    if (Date.now() - t0 > ms) assert.fail(`not shown within ${ms} ms: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const stores: any[] = []
after(() => {
  for (const s of stores) { try { s.close() } catch { /* ignore */ } }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

async function ready(opts: Record<string, unknown>): Promise<any> {
  const store = producer.createStore({ pollMs: 50, ...opts })
  stores.push(store)
  await store.ready
  return store
}

const notices = (store: any): any[] => store.snapshot().state.notices
const byId = (store: any, id: string): any[] => notices(store).filter((n: any) => n.id === id)

const OLD_CONFIG_COPY = 'is missing, or has no "architecture" or no "adr" key'

function assertConfigStatus(store: any): void {
  const hits = byId(store, 'no-config')
  assert.equal(hits.length, 1, `expected exactly one no-config notice, got ${JSON.stringify(notices(store))}`)
  const text: string = hits[0].text
  assert.ok(!text.includes(OLD_CONFIG_COPY), `old error copy still present: ${text}`)
  assert.ok(!/\bmissing\b/i.test(text), `error word "missing" in: ${text}`)
  assert.ok(!/\bempty\b/i.test(text), `error word "empty" in: ${text}`)
  assert.ok(text.includes('.claude/truss.json'), `does not name .claude/truss.json: ${text}`)
  assert.ok(text.includes('architecture'), `does not name the architecture key: ${text}`)
  assert.ok(text.includes('adr'), `does not name the adr key: ${text}`)
}

test('ADR-0014 seam 5: no .claude/truss.json gives one no-config notice worded as status', async () => {
  const w = makeWorld(null)
  assertConfigStatus(await ready({ repo: w.repo, trussDir: w.truss }))
})

test('ADR-0014 seam 5: a config without the adr key gives one no-config notice worded as status', async () => {
  const w = makeWorld({ architecture: 'docs/architecture.md' })
  assertConfigStatus(await ready({ repo: w.repo, trussDir: w.truss }))
})

test('ADR-0014 seam 5: a config without the architecture key gives one no-config notice worded as status', async () => {
  const w = makeWorld({ adr: 'docs/adr' })
  assertConfigStatus(await ready({ repo: w.repo, trussDir: w.truss }))
})

test('ADR-0014 seam 5: a complete config gives no no-config notice', async () => {
  const w = makeWorld()
  const store = await ready({ repo: w.repo, trussDir: w.truss })
  assert.equal(byId(store, 'no-config').length, 0, JSON.stringify(notices(store)))
})

test('ADR-0014 seam 5: a truss dir path not on disk gives one no-truss-dir notice naming it, gone once the dir appears', async () => {
  const w = makeWorld()
  const absent = path.join(w.base, 'later-truss')
  const store = await ready({ repo: w.repo, trussDir: absent })
  const hits = byId(store, 'no-truss-dir')
  assert.equal(hits.length, 1, JSON.stringify(notices(store)))
  const text: string = hits[0].text
  assert.ok(text.includes(absent), `does not name the path ${absent}: ${text}`)
  assert.ok(!text.includes('not on disk yet'), `old error copy: ${text}`)
  assert.ok(!text.includes('not known yet'), `old error copy: ${text}`)
  fs.cpSync(w.truss, absent, { recursive: true })
  await until(store, (s) => s.notices.every((n: any) => n.id !== 'no-truss-dir'), 3000, 'no-truss-dir notice gone after the dir is copied in')
})

test('ADR-0014 seam 5: with no trussDir option the no-truss-dir notice does not say "not known yet"', async () => {
  const w = makeWorld()
  const store = await ready({ repo: w.repo })
  const hits = byId(store, 'no-truss-dir')
  if (hits.length === 0) return // a default truss dir was found; nothing to word
  assert.equal(hits.length, 1)
  assert.ok(!hits[0].text.includes('not known yet'), `old error copy: ${hits[0].text}`)
})

test('ADR-0014 seam 5: every notice text is a non-empty string with no Status: or Notice: tag', async () => {
  const w1 = makeWorld(null)
  const absent = path.join(w1.base, 'nowhere')
  const s1 = await ready({ repo: w1.repo, trussDir: absent })
  const s2 = await ready({ repo: makeWorld({ adr: 'docs/adr' }).repo })
  const all = [...notices(s1), ...notices(s2)]
  assert.ok(all.some((n: any) => n.id === 'no-config') && all.some((n: any) => n.id === 'no-truss-dir'), 'both notices should appear')
  for (const n of all) {
    assert.equal(typeof n.text, 'string')
    assert.ok(n.text.trim().length > 0, `empty text for ${n.id}`)
    assert.ok(!/^\s*(Status|Notice):/i.test(n.text), `tag in server text for ${n.id}: ${n.text}`)
  }
})
