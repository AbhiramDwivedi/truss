// Contract check for the D2 design tokens (ADR-0023; plan-ui-redesign, tokens.json).
// Written before any implementation. It reads the BUILT css in ui/web/assets/*.css and never builds.
// Every case reads the css itself, so a missing build fails every case and nothing else.
// Lightning CSS minifies colours (case, 3-digit hex, rgb() to hex), so each value is normalised first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.dirname(path.dirname(here))
const assetsDir = path.join(uiDir, 'web', 'assets')
const tokens = JSON.parse(fs.readFileSync(path.join(here, 'tokens.json'), 'utf8'))

type Vars = Record<string, string>

function readCss(): string {
  assert.ok(fs.existsSync(assetsDir), `the built CSS is missing: ${assetsDir} does not exist (this check never builds)`)
  const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
  assert.ok(files.length > 0, `the built CSS is missing: no *.css in ${assetsDir}`)
  return files.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n')
}

// Custom properties of every innermost rule whose selector list holds `:root` (light) or `.dark` (dark).
// Later declarations win, as in the cascade.
function themes(css: string): { light: Vars; dark: Vars } {
  const light: Vars = {}
  const dark: Vars = {}
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = m[1].split(',').map((s) => s.trim())
    const isDark = sels.some((s) => /(^|:root|html|body)\.dark$/.test(s) || s === '.dark')
    const isLight = !isDark && sels.some((s) => s === ':root' || s === ':host' || s === 'html')
    if (!isDark && !isLight) continue
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':')
      if (i < 0) continue
      const name = d.slice(0, i).trim()
      if (!name.startsWith('--')) continue
      ;(isDark ? dark : light)[name] = d.slice(i + 1).trim()
    }
  }
  return { light, dark }
}

function hex(v: string): string {
  let h = v.trim().toLowerCase()
  const m = /^#([0-9a-f]{3,4})$/.exec(h)
  if (m) h = '#' + [...m[1]].map((c) => c + c).join('')
  return h
}

// The value of a custom property in a theme: dark falls back to :root, var(--x) is followed.
function resolve(t: { light: Vars; dark: Vars }, theme: 'light' | 'dark', name: string, depth = 0): string | undefined {
  const raw = theme === 'dark' ? (t.dark[name] ?? t.light[name]) : t.light[name]
  if (raw === undefined || depth > 8) return raw
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,[^)]*)?\)$/.exec(raw)
  return ref ? resolve(t, theme, ref[1], depth + 1) : raw
}

function px(v: string | undefined): string | undefined {
  if (v === undefined) return v
  const s = v.trim().toLowerCase()
  const rem = /^(-?[\d.]+)rem$/.exec(s)
  if (rem) return `${Math.round(parseFloat(rem[1]) * 16 * 1000) / 1000}px`
  return s === '0' ? '0px' : s
}

// A shadow value with colours as c(r,g,b,a), so rgb(15 23 42 / .05) and #0f172a0d compare equal.
function shadow(v: string | undefined): string | undefined {
  if (v === undefined) return v
  const num = (n: string) => (n.endsWith('%') ? (parseFloat(n) / 100) : parseFloat(n))
  const c = (r: number, g: number, b: number, a: number) => `c(${r},${g},${b},${Math.round(a * 100) / 100})`
  return v
    .toLowerCase()
    .replace(/rgba?\(([^)]*)\)/g, (_, inner: string) => {
      const p = inner.replace('/', ' ').replace(/,/g, ' ').trim().split(/\s+/)
      return c(+p[0], +p[1], +p[2], p[3] === undefined ? 1 : num(p[3]))
    })
    .replace(/#([0-9a-f]{8}|[0-9a-f]{6})\b/g, (_, h: string) =>
      c(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1))
    .replace(/(^|[\s,])0px\b/g, '$10')
    .replace(/(^|[^\d])0\.(\d)/g, '$1.$2')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+/g, ' ')
    .trim()
}

const keys = Object.keys(tokens.colors)

test('built css: every colour key holds D2 light hex in :root', () => {
  const t = themes(readCss())
  const bad = keys.filter((k) => hex(resolve(t, 'light', `--${k}`) ?? '') !== hex(tokens.colors[k].light))
  assert.deepEqual(bad, [], `:root does not hold tokens.json light hex for: ${bad.join(', ')}`)
})

test('built css: every colour key holds D2 dark hex in .dark', () => {
  const t = themes(readCss())
  const bad = keys.filter((k) => hex(resolve(t, 'dark', `--${k}`) ?? '') !== hex(tokens.colors[k].dark))
  assert.deepEqual(bad, [], `.dark does not hold tokens.json dark hex for: ${bad.join(', ')}`)
})

test('built css: shadcn variables resolve to their D2 key in both themes', () => {
  const t = themes(readCss())
  const bad: string[] = []
  for (const [v, key] of Object.entries<string>(tokens.shadcn)) {
    for (const theme of ['light', 'dark'] as const) {
      const got = resolve(t, theme, v)
      if (got === undefined || hex(got) !== hex(tokens.colors[key][theme])) bad.push(`${v} (${theme}) should be ${key}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('built css: --radius-<key> holds the D2 radius', () => {
  const t = themes(readCss())
  const bad = Object.entries<string>(tokens.radius).filter(([k, v]) => px(resolve(t, 'light', `--radius-${k}`)) !== px(v)).map(([k]) => k)
  assert.deepEqual(bad, [], `--radius-<key> differs from tokens.json for: ${bad.join(', ')}`)
})

test('built css: --text-<key> holds the D2 font size', () => {
  const t = themes(readCss())
  const bad = Object.entries<string>(tokens.text).filter(([k, v]) => px(resolve(t, 'light', `--text-${k}`)) !== px(v)).map(([k]) => k)
  assert.deepEqual(bad, [], `--text-<key> differs from tokens.json for: ${bad.join(', ')}`)
})

test('built css: e1, e2 and e-hero shadows hold D2 values in both themes', () => {
  const t = themes(readCss())
  const bad: string[] = []
  for (const [k, v] of Object.entries<{ light: string; dark: string }>(tokens.shadow)) {
    for (const theme of ['light', 'dark'] as const) {
      const got = resolve(t, theme, `--${k}`)
      if (shadow(got) !== shadow(v[theme])) bad.push(`--${k} (${theme})`)
    }
  }
  assert.deepEqual(bad, [])
})
