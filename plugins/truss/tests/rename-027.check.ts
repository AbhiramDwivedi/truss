// @ts-nocheck
// Truss 0.27.0, rename-docs: the crew lead becomes the project manager and the main session the program manager, with no alias.
// The prose crew owns the docs, the ADR, the changelog and the plugin version; these cases pin what those files must say.
//
// Run with: node --test tests/rename-027.check.ts

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(PLUGIN, '..', '..')
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '')
const plugin = (p) => read(`plugins/truss/${p}`)

// The old crew-lead name is built from pieces so that this file does not contain it and stays inside the walk it runs.
const OLD_NAME = new RegExp('fore' + '(man|men)', 'i')

// This crew's Owns list (the goal file), as paths relative to the repo root. A directory is expanded with `git ls-files`.
function ownedFiles() {
  const adrDir = 'plugins/truss/docs/adr'
  const adrs = readdirSync(path.join(ROOT, adrDir)).filter((f) => /^00\d\d-.*\.md$/.test(f)).map((f) => `${adrDir}/${f}`)
  const files = [
    'plugins/truss/docs/architecture.md',
    'docs/features.md',
    'plugins/truss/CHANGELOG.md',
    'plugins/truss/.claude-plugin/plugin.json',
    'plugins/truss/docs/requirements.md',
    'plugins/truss/tests/release-026.check.ts',
    'plugins/truss/tests/rename-027.check.ts',
    ...adrs,
  ]
  const ls = spawnSync('git', ['-c', 'core.quotepath=off', 'ls-files', '--', `${adrDir}/claude-ops`], { cwd: ROOT, encoding: 'utf8', windowsHide: true })
  assert.equal(ls.status, 0, 'git ls-files failed')
  files.push(...ls.stdout.split('\n').filter(Boolean))
  return [...new Set(files)].filter((f) => existsSync(path.join(ROOT, f)))
}

const OWNED_MD = () => ownedFiles().filter((f) => f.endsWith('.md'))

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

test('rename-027: no owned file names the old crew lead', () => {
  const hits = []
  for (const f of ownedFiles()) {
    read(f).split('\n').forEach((line, i) => {
      if (OLD_NAME.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 160)}`)
    })
  }
  assert.equal(hits.length, 0, `${hits.length} line(s) still name the old crew lead:\n${hits.join('\n')}`)
})

test('rename-027: each owned prose file that keeps PM defines it', () => {
  const bad = []
  for (const f of OWNED_MD()) {
    const text = read(f)
    if (!/\bPM\b/.test(text)) continue
    if (!/program manager \(PM\)/.test(text)) bad.push(f)
  }
  assert.deepEqual(bad, [], `these files use PM without defining it as "program manager (PM)":\n${bad.join('\n')}`)
})

test('rename-027: ADR-0042 is accepted, decided by the client, and names the new values', () => {
  const rel = 'plugins/truss/docs/adr/0042-project-manager-rename.md'
  assert.ok(existsSync(path.join(ROOT, rel)), `${rel} does not exist`)
  const adr = read(rel)
  assert.match(adr, /^Status: accepted/m, 'no "Status: accepted" line')
  assert.match(adr, /Decided by: client/, 'no "Decided by: client"')
  for (const v of ['truss:project-manager', 'projectManagers', 'idle-project-manager', 'stalls.idleProjectManager', '[truss] idle project manager:', 'PROJECT_MANAGER_TYPE', 'isLeadType', 'stopperIsLead', 'leadStartName', 'IDLE_LEAD_KIND']) {
    assert.ok(adr.includes(v), `ADR-0042 does not name ${v}`)
  }
  assert.match(adr, /no alias/i, 'ADR-0042 does not say there is no alias')
  const arch = plugin('docs/architecture.md')
  const sec = section(arch, /^## Role names \(ADR-0042\)/)
  assert.ok(sec, 'architecture.md has no "## Role names (ADR-0042)" heading')
  assert.match(sec, /0042-project-manager-rename\.md/, 'the Role names section does not link ADR-0042')
})

// 0.28.0 shipped after the rename: these pin that the rename's release stays in place, not that it is the newest
test('rename-027: plugin.json is at 0.27.0 or later', () => {
  const [maj, min] = JSON.parse(plugin('.claude-plugin/plugin.json')).version.split('.').map(Number)
  assert.ok(maj > 0 || min >= 27, 'plugin.json is below 0.27.0')
})

test('rename-027: the CHANGELOG has exactly one 0.27.0 entry', () => {
  const log = plugin('CHANGELOG.md')
  assert.equal(log.match(/^## 0\.27\.0\b/gm)?.length, 1, 'exactly one 0.27.0 entry')
})

test('rename-027: the 0.27.0 entry says no alias and names the old promptOverrides key and idle-stall events as no longer read', () => {
  const entry = section(plugin('CHANGELOG.md'), /^## 0\.27\.0\b/)
  assert.ok(entry, 'no 0.27.0 entry')
  assert.match(entry, /no alias/i, 'the entry does not say no alias')
  assert.match(entry, /promptOverrides/, 'the entry does not name promptOverrides')
  assert.match(entry, /idle[- ]stall/i, 'the entry does not name the idle-stall events')
  assert.match(entry, /no longer read|not read|never read/i, 'the entry does not say the old names are no longer read')
})
