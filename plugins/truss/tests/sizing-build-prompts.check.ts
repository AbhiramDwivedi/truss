// @ts-nocheck
// ADR-0031 prompt tokens: skills/run/SKILL.md and the agent files. Pins only tokens the ADR fixes, not prose.
// Plain node --test: reads files only; no agents, no model calls.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { REAL_PLUGIN } from './fixtures/workflow-run/harness.ts'

const P = 'sizing build prompts: '
const read = (...parts: string[]): string => {
  const f = path.join(REAL_PLUGIN, ...parts)
  assert.ok(existsSync(f), `${f} is missing`)
  return readFileSync(f, 'utf8')
}
const frontmatter = (text: string): Record<string, string> => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  assert.ok(m, 'a frontmatter block')
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return fm
}
/** The text of the `## <heading>` section, up to the next `## ` heading. */
const section = (text: string, heading: string): string => {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase())
  assert.ok(start >= 0, `a "## ${heading}" section`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^## /.test(lines[i])) { end = i; break }
  return lines.slice(start, end).join('\n')
}
const words = (text: string, list: string[]) => {
  for (const w of list) assert.match(text, new RegExp(`\\b${w}\\b`), `names ${w}`)
}

test(P + 'run-skill names solo, lean and full', () => {
  words(read('skills', 'run', 'SKILL.md'), ['solo', 'lean', 'full'])
})

test(P + 'run-skill says an all-solo goal skips plan.js', () => {
  const t = read('skills', 'run', 'SKILL.md')
  assert.match(t, /all-solo/i)
  assert.match(t, /plan\.js/)
  assert.ok(t.split(/\r?\n/).some((l) => /all-solo/i.test(l) && /skip/i.test(l) && /plan\.js/.test(l)) || /all-solo[^]{0,300}?skip[^]{0,200}?plan\.js/i.test(t), 'a line or passage saying an all-solo goal skips plan.js')
})

test(P + 'run-skill names factory.ts land', () => {
  assert.match(read('skills', 'run', 'SKILL.md'), /factory\.ts land/)
})

test(P + 'run-skill carries the size decide line', () => {
  const t = read('skills', 'run', 'SKILL.md')
  assert.match(t, /size <task> <process>/)
  assert.match(t, /sizing-engineer <solo\|lean\|full\|none>/)
})

test(P + 'run-skill names sizing-engineer', () => {
  assert.match(read('skills', 'run', 'SKILL.md'), /sizing-engineer/)
})

test(P + 'run-skill contains no project-managerless', () => {
  assert.doesNotMatch(read('skills', 'run', 'SKILL.md'), /project[- ]?managerless/i)
})

test(P + 'agent-file sizing-engineer frontmatter tools is exactly Read, Grep, Glob', () => {
  const fm = frontmatter(read('agents', 'sizing-engineer.md'))
  assert.equal(fm.name, 'sizing-engineer')
  assert.deepEqual((fm.tools ?? '').split(',').map((s) => s.trim()), ['Read', 'Grep', 'Glob'])
})

test(P + 'agent-file sizing-engineer body carries the TASK line shape', () => {
  const text = read('agents', 'sizing-engineer.md')
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '')
  assert.ok(body.includes('TASK: <name> | solo|lean|full |'), 'the TASK: <name> | solo|lean|full | line shape')
})

test(P + 'agent-file design-engineer plan mode names process, solo, lean, full, qc and red', () => {
  const sec = section(read('agents', 'design-engineer.md'), 'plan mode')
  words(sec, ['process', 'solo', 'lean', 'full', 'qc', 'red'])
})

test(P + 'agent-file project-manager names process and full', () => {
  words(read('agents', 'project-manager.md'), ['process', 'full'])
})
