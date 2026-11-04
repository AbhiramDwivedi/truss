// parseAdr's fields (number, date, decidedBy, links, summary) through createFileReaders, for the ADR cards
// in the Decisions tab. Old-style ADRs (no template) must still parse, with the new fields null or empty.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileReaders } from '../../server/state/files.ts'

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-adr-'))
fs.mkdirSync(path.join(repo, 'adr'))
const put = (name: string, text: string): void => fs.writeFileSync(path.join(repo, 'adr', name), text)
after(() => fs.rmSync(repo, { recursive: true, force: true }))

put(
  '0030-new.md',
  [
    '# ADR-0030: a templated one',
    'Status: accepted, 2026-11-03',
    'Decided by: client',
    'Amends: ADR-0021, ADR-0022',
    'Supersedes: ADR-0005',
    '',
    '## Context',
    'Context text that must not be the summary.',
    '',
    '## Decision',
    'We **use** the [new thing](http://x) with `code`. It is short. Then a very long tail ' + 'word '.repeat(80),
    '',
    '## Consequences',
    'Nothing.',
    '',
  ].join('\n'),
)
put('0031-sup.md', '# ADR-0031: gone\nStatus: superseded by ADR-0030, 2026-11-04\n\n## Context\n- one\n- two\n')
put('0007-old.md', '# Old style, no number in title\n\nStatus: proposed, 2026-10-31. Written by a crew.\n\nFirst paragraph\nof prose.\n\nSecond.\n')
put('notes.md', 'just words\n')

const adrs = createFileReaders(repo).adrs('adr')
const by = (f: string) => adrs.find((a) => a.file === f)!

test('templated ADR: number, date, decidedBy, links and a Decision summary', () => {
  const a = by('0030-new.md')
  assert.equal(a.number, 30)
  assert.equal(a.date, '2026-11-03')
  assert.equal(a.decidedBy, 'client')
  assert.deepEqual(a.links, [
    { kind: 'amends', n: 21 },
    { kind: 'amends', n: 22 },
    { kind: 'supersedes', n: 5 },
  ])
  assert.ok(a.summary!.startsWith('We use the new thing with code. It is short.'))
  assert.ok(a.summary!.length <= 221)
})

test('superseded-by comes from the Status line and the summary falls back to Context as plain text', () => {
  const a = by('0031-sup.md')
  assert.equal(a.status, 'superseded by ADR-0030, 2026-11-04')
  assert.deepEqual(a.links, [{ kind: 'superseded-by', n: 30 }])
  assert.equal(a.summary, 'one two')
})

test('old-style ADR: number from the file name, date from the status, no decidedBy or links, first paragraph', () => {
  const a = by('0007-old.md')
  assert.equal(a.number, 7)
  assert.equal(a.date, '2026-10-31')
  assert.equal(a.decidedBy, null)
  assert.deepEqual(a.links, [])
  assert.equal(a.summary, 'First paragraph of prose.')
})

test('a file with no header or status gets null fields, status stays as before', () => {
  const a = by('notes.md')
  assert.equal(a.title, 'notes.md')
  assert.equal(a.status, null)
  assert.equal(a.number, null)
  assert.equal(a.date, null)
  assert.equal(a.summary, 'just words')
})
