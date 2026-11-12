// @ts-nocheck
// Truss 0.27.0: the old crew-lead name is gone from the code and docs, with no alias and no exemption.
// Walks every tracked file in the repo, except the recorded or recording-derived files in EXCLUDED, and lists every
// line that still holds the old name.
// The pattern is built from two pieces so that this file never holds the old name itself and passes its own walk.
// No CHANGELOG exemption is needed: the changelog rewrote its older entries in 0.27.0.
//
// Run with: node --test tests/rename-027-tree.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const OLD_NAME = new RegExp('fore' + '(man|men)', 'i')
const FX = 'ui/contract/fixtures/'
const EXCLUDED = [FX + 'sdk-stream.jsonl', FX + 'rework/sdk-flow.jsonl', FX + 'rework/real-12/state.json', FX + 'rework/real-data/state.json']
const EXCLUDED_DIRS = [FX + 'real-data/truss/']
const excluded = (f) => EXCLUDED.includes(f) || EXCLUDED_DIRS.some((d) => f.startsWith(d))
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|mp4|mov)$/i

function tracked(...specs) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '-z', '--', ...specs], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  assert.equal(r.status, 0, `git ls-files failed: ${r.stderr}`)
  return r.stdout.split('\0').filter(Boolean)
}

test('rename-027-tree: no tracked file outside the recorded fixtures names the old crew lead', () => {
  const files = tracked('.').filter((f) => !excluded(f))
  assert.ok(files.length > 100, `only ${files.length} files walked`)
  const hits = []
  for (const f of files) {
    if (BINARY.test(f)) continue
    let text
    try { text = readFileSync(path.join(ROOT, f), 'utf8') } catch { continue }
    if (text.includes('\0')) continue
    text.split(/\r?\n/).forEach((line, i) => {
      if (OLD_NAME.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
    })
  }
  assert.equal(hits.length, 0, `${hits.length} line(s) still name the old crew lead:\n${hits.join('\n')}`)
})
