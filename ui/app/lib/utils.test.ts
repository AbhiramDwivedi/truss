// Spec test for cn() (floor-shell UX checklist 17). Written before ./utils.ts exists.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { cn } from './utils.ts'

test('cn keeps a custom text size and a text colour together', () => {
  assert.equal(cn('text-meta', 'text-fg'), 'text-meta text-fg')
})

test('cn keeps the colour when the size comes after it', () => {
  assert.equal(cn('text-fg', 'text-meta'), 'text-fg text-meta')
})

test('cn lets the later text size win', () => {
  assert.equal(cn('text-meta', 'text-ui'), 'text-ui')
})

test('cn lets the later radius win', () => {
  assert.equal(cn('rounded-chip', 'rounded-ctl'), 'rounded-ctl')
})

test('cn lets the later shadow win', () => {
  assert.equal(cn('shadow-e1', 'shadow-hero'), 'shadow-hero')
})

test('cn lets the later background win', () => {
  assert.equal(cn('bg-surface', 'bg-secondary'), 'bg-secondary')
})

test('cn knows all 8 sizes, 5 radii and 3 shadows', () => {
  for (const s of ['micro', 'meta', 'ui', 'body', 'lead', 'title', 'h1', 'ask']) assert.equal(cn('text-fg', `text-${s}`), `text-fg text-${s}`)
  for (const r of ['chip', 'ctl', 'card', 'panel', 'hero']) assert.equal(cn('rounded-full', `rounded-${r}`), `rounded-${r}`)
  for (const s of ['e1', 'e2', 'hero']) assert.equal(cn('shadow-sm', `shadow-${s}`), `shadow-${s}`)
})

test('utils.ts builds cn on extendTailwindMerge', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'utils.ts'), 'utf8')
  assert.match(src, /extendTailwindMerge/)
})
