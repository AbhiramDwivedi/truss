// Static spec test for the floor-shell source under ui/app: token discipline, banned patterns, the placeholder App.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const appDir = path.resolve(import.meta.dirname, '..')
const compDir = path.join(appDir, 'components')

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const FILES = [
  'button', 'badge', 'dot', 'card', 'tabs', 'radio-group', 'checkbox', 'input', 'textarea',
  'input-group', 'label', 'collapsible', 'hint', 'notice', 'skeleton',
]

test('each of the 15 primitive files exists', () => {
  const missing = FILES.filter((f) => !fs.existsSync(path.join(compDir, 'ui', f + '.tsx')))
  assert.deepEqual(missing, [])
})

// [pattern, why]. A match anywhere in ui/app/components fails the case.
const BANNED: [RegExp, string][] = [
  [/outline-none/, 'stock focus style: the global focus rule draws focus'],
  [/focus-visible:ring/, 'stock focus style'],
  [/ring-offset/, 'stock focus style'],
  [/focus-visible:border-ring/, 'stock focus style'],
  [/\bbg-muted\b/, '--muted is a text colour; use bg-secondary'],
  [/\brounded-(sm|md|lg|xl|2xl)\b/, 'stock radius; use chip, ctl, card, panel or hero'],
  [/text-\[/, 'arbitrary text size'],
  [/\bp-\[/, 'arbitrary padding'],
  [/\bgap-\[/, 'arbitrary gap'],
  [/\bh-\[/, 'arbitrary height'],
  [/\btext-white\b/, 'raw colour'],
  [/\bbg-white\b/, 'raw colour'],
  [/\bbg-black\b/, 'raw colour'],
  [/\[#/, 'raw colour'],
  [/\[rgb\(/, 'raw colour'],
  [/\[hsl\(/, 'raw colour'],
  [/\[oklch\(/, 'raw colour'],
  [/#[0-9a-fA-F]{3,8}\b/, 'raw hex colour'],
  [/(?<![\w-])text-ok\b/, 'ok is never text'],
  [/(?<![\w-])text-signal\b(?!-text)/, 'signal is never text'],
  [/text-sonnet/, 'sonnet is never text'],
  [/text-opus/, 'opus is never text'],
  [/transition-all/, 'animate only colour, shadow, opacity and transform'],
  [/transition-\[height/, 'never animate height'],
  [/transition-\[width/, 'never animate width'],
  [/<style/i, 'no injected style element'],
  [/dangerouslySetInnerHTML/, 'no raw HTML'],
  [/@radix-ui\/react-(dialog|popover|tooltip|scroll-area|toast)/, 'banned Radix primitive (ADR-0018)'],
  [/from ['"]sonner['"]/, 'banned toast library'],
]

test('ui/app/components has files to check', () => {
  assert.ok(walk(compDir).length > 0, 'ui/app/components is empty')
})

for (const [re, why] of BANNED) {
  test(`ui/app/components never matches ${re} (${why})`, () => {
    const hits: string[] = []
    for (const f of walk(compDir)) {
      const text = fs.readFileSync(f, 'utf8')
      text.split('\n').forEach((line, i) => {
        if (re.test(line)) hits.push(`${path.relative(appDir, f)}:${i + 1}: ${line.trim()}`)
      })
    }
    assert.deepEqual(hits, [])
  })
}

test('Tabs keep automatic activation', () => {
  const src = fs.readFileSync(path.join(compDir, 'ui', 'tabs.tsx'), 'utf8')
  assert.doesNotMatch(src, /activationMode\s*=\s*["{']*manual/)
})

test('coarse pointers grow Button sm to h-10 and Tabs triggers to h-9', () => {
  assert.match(fs.readFileSync(path.join(compDir, 'ui', 'button.tsx'), 'utf8'), /pointer-coarse:h-10/)
  assert.match(fs.readFileSync(path.join(compDir, 'ui', 'tabs.tsx'), 'utf8'), /pointer-coarse:h-9/)
})

test('App.tsx is a placeholder that shows the connection', () => {
  const src = fs.readFileSync(path.join(appDir, 'App.tsx'), 'utf8')
  const lines = src.split('\n').filter((l) => l.trim() !== '').length
  assert.ok(lines <= 30, `App.tsx has ${lines} non-blank lines, the cap is 30`)
  assert.match(src, /<h1[^>]*>\s*Truss\s*<\/h1>/)
  assert.match(src, /role="status"/)
  for (const s of ['Connecting to the run…', 'Live', 'Reconnecting…']) assert.ok(src.includes(s), `App.tsx lacks "${s}"`)
  assert.match(src, /\buseConnection\b/)
})

test('no file exists under ui/app/views', () => {
  assert.deepEqual(walk(path.join(appDir, 'views')), [])
})
