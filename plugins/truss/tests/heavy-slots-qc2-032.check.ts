// @ts-nocheck
// Truss 0.32.0 heavy-slots second QC round: the heavy-slots architecture fragment may not replace a section another crew owns, and
// bashRun's win32 branch (the `platform` parameter) is run, not only read.
//
// Run with: node --test plugins/truss/tests/heavy-slots-qc2-032.check.ts

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bashRun } from '../bin/factory/check.ts'
import { fragmentSections, splitFront } from '../bin/fragments.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.resolve(here, '..')

test('heavy-slots QC 2: the architecture fragment replaces no section of architecture.md, so another crew\'s edit to it survives a stitch', () => {
  const frag = readFileSync(path.join(plugin, 'docs', 'architecture.d', 'heavy-slots.md'), 'utf8')
  const doc = readFileSync(path.join(plugin, 'docs', 'architecture.md'), 'utf8')
  const docHeads = splitFront(doc).body.map((l) => /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l)).filter(Boolean).map((m) => `${m[1].length} ${m[2]}`)
  const { sections } = fragmentSections(splitFront(frag).body)
  assert.ok(sections.length > 0, 'the fragment has sections')
  const clash = sections.filter((s) => docHeads.includes(`${s.depth} ${s.title}`)).map((s) => s.title)
  assert.deepEqual(clash, [], `the fragment replaces these sections of architecture.md on stitch: ${clash.join('; ')}`)
})

// A member that outlives the suite keeps its group record (bashRun, non-win32), which makes the record visible to a test.
function run(platform: string): { exit: number; groups: string[]; dir: string } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'heavy-slots-qc2-')))
  const r = bashRun(dir, 'sleep 30 & echo suite-ran', { dir, label: 'x-check', slug: 'x' }, platform)
  assert.match(r.text, /suite-ran/)
  const gdir = path.join(dir, 'resources', 'groups')
  const groups = existsSync(gdir) ? readdirSync(gdir) : []
  for (const f of groups) {
    const pgid = JSON.parse(readFileSync(path.join(gdir, f), 'utf8')).pgid
    try {
      process.kill(-pgid, 'SIGKILL')
    } catch {}
  }
  return { exit: r.exit, groups, dir }
}

test('heavy-slots QC 2: bashRun on win32 runs the suite and records no process group', () => {
  const w = run('win32')
  assert.equal(w.exit, 0)
  assert.deepEqual(w.groups, [], 'win32 has no process groups to record')
})

test('heavy-slots QC 2: bashRun off win32 records the suite group (control for the win32 case)', () => {
  const l = run('linux')
  assert.equal(l.exit, 0)
  assert.equal(l.groups.length, 1, 'a surviving member keeps its record')
})
