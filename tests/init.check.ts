// @ts-nocheck
// (no type check: the plugin tsconfig carries the hook types, not Node's, and this file runs under node)
// truss 0.4.1: init never sets kit up itself (truss ADR-0002, amendment of 2026-10-27)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const init = readFileSync(new URL('../skills/init/SKILL.md', import.meta.url), 'utf8')
const NO_MANIFEST = 'no kit manifest; truss init carries on without one (run /kit:init on its own to set kit up)'

test('init prints the no-manifest line and does not run kit:init without a manifest', () => {
  assert.ok(init.includes(NO_MANIFEST))
  assert.ok(init.includes("**Missing, and `kit:init` is among the session's skills:** don't run `kit:init`"))
  assert.ok(!init.includes('kit sets the project up'))
})

test('init still runs kit:init with the declare args when a manifest lacks the declarations', () => {
  assert.ok(init.includes("**Readable without the declarations, and `kit:init` is among the session's skills:** run it"))
})

// the allowlist proposal: narrow rules in the committed settings.json, written by the client only
const allowBlock = (): string[] => {
  const m = init.match(/```json\n([\s\S]*?)```/)
  assert.ok(m, 'init shows a JSON allowlist')
  return JSON.parse(m[1].replace(/^ {2}/gm, '')).permissions.allow
}

test('init proposes a narrow permissions allowlist for .claude/settings.json', () => {
  const allow = allowBlock()
  for (const r of ['Bash(node --test:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(node <plugin>/bin/factory.ts:*)']) {
    assert.ok(allow.includes(r), r)
  }
  // no rule is a wildcard over a program that runs code it is handed
  for (const r of allow) {
    assert.doesNotMatch(r, /^Bash\((\*|node|python3?|bash|sh|npx|env|xargs|git|npm):\*\)$/, r)
    assert.match(r, /^Bash\(\S+ \S/, `${r}: a program and its subcommand or script`)
  }
})

test('init never writes the settings file and says why the local file and the guard are out of reach', () => {
  const flat = init.replace(/\s+/g, ' ')
  assert.ok(flat.includes('The client writes the approved rules into `.claude/settings.json` themselves: truss never writes a settings file'))
  assert.ok(flat.includes('`.claude/settings.local.json` is not checked in, so it never reaches the agents\' worktrees'))
  assert.ok(flat.includes("No allow rule reaches Claude Code's worktree guard"))
  assert.ok(flat.includes('"no verdict" refusals on Write and Edit come from the classifier service'))
  for (const w of ['`Bash(*)`', '`Bash(node:*)`', '`Bash(python3:*)`', '`Bash(npx:*)`', '`Bash(git:*)`']) assert.ok(flat.includes(w), w)
})

test('the README and ADR-0002 carry the same no-manifest line', () => {
  for (const f of ['../README.md', '../docs/adr/0002-kit-manifest-and-config.md']) {
    assert.ok(readFileSync(new URL(f, import.meta.url), 'utf8').includes(NO_MANIFEST), f)
  }
})
