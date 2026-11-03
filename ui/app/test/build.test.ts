// Spec test for the floor-shell build: the built CSS, the document, the theme files and the package.
// It reads ui/web after `npm --prefix ui run build` and never builds. A missing build fails the CSS cases.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const uiDir = path.resolve(import.meta.dirname, '..', '..')
const repoDir = path.dirname(uiDir)
const webDir = path.join(uiDir, 'web')
const assetsDir = path.join(webDir, 'assets')
const tokens = JSON.parse(fs.readFileSync(path.join(uiDir, 'contract', 'redesign', 'tokens.json'), 'utf8'))

const read = (...p: string[]) => fs.readFileSync(path.join(uiDir, ...p), 'utf8')
const squash = (s: string) => s.replace(/\s+/g, '').replace(/["']/g, '')

function readCss(): string {
  assert.ok(fs.existsSync(assetsDir), `the built CSS is missing: ${assetsDir} does not exist (this test never builds)`)
  const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.css'))
  assert.ok(files.length > 0, `the built CSS is missing: no *.css in ${assetsDir}`)
  return files.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '')
}

type Rule = { at: string[]; sel: string; decls: Record<string, string> }

// Every block with its enclosing at-rule preludes, so nested @layer and @media blocks are found.
function parseRules(css: string): Rule[] {
  const rules: Rule[] = []
  const stack: { prelude: string; decls: Record<string, string> }[] = []
  let buf = ''
  const flushDecl = () => {
    const top = stack[stack.length - 1]
    const i = buf.indexOf(':')
    if (top && i > 0) top.decls[buf.slice(0, i).trim()] = buf.slice(i + 1).trim()
    buf = ''
  }
  for (const ch of css) {
    if (ch === '{') {
      stack.push({ prelude: buf.trim(), decls: {} })
      buf = ''
    } else if (ch === ';') flushDecl()
    else if (ch === '}') {
      flushDecl()
      const top = stack.pop()!
      rules.push({ at: stack.map((s) => s.prelude), sel: top.prelude, decls: top.decls })
    } else buf += ch
  }
  return rules
}

const inDarkMedia = (r: Rule) => r.at.some((a) => /prefers-color-scheme:\s*dark/.test(a))
const sels = (r: Rule) => r.sel.split(',').map((s) => squash(s))
const hasKeyframes = (r: Rule) => r.at.some((a) => a.startsWith('@keyframes')) || r.sel.startsWith('@keyframes')

function theme(rules: Rule[], which: 'light' | 'dark'): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rules) {
    if (hasKeyframes(r) || inDarkMedia(r)) continue
    const ss = sels(r)
    const match = which === 'light' ? ss.includes(':root') : ss.includes('.dark')
    if (match) Object.assign(out, r.decls)
  }
  return out
}

function hex(v: string | undefined): string | undefined {
  if (v === undefined) return v
  let h = v.trim().toLowerCase()
  const m = /^#([0-9a-f]{3,4})$/.exec(h)
  if (m) h = '#' + [...m[1]].map((c) => c + c).join('')
  return h
}

const cssRules = () => parseRules(readCss())

test('built css: every tokens.json colour is --<key> in light :root and in .dark', () => {
  const rules = cssRules()
  const light = theme(rules, 'light')
  const dark = theme(rules, 'dark')
  const bad: string[] = []
  for (const [k, v] of Object.entries<{ light: string; dark: string }>(tokens.colors)) {
    if (hex(light['--' + k]) !== hex(v.light)) bad.push(`light --${k} is ${light['--' + k]}, not ${v.light}`)
    if (hex(dark['--' + k]) !== hex(v.dark)) bad.push(`dark --${k} is ${dark['--' + k]}, not ${v.dark}`)
  }
  assert.deepEqual(bad, [])
})

test('built css: --e1, --e2 and --e-hero exist in both themes', () => {
  const rules = cssRules()
  const light = theme(rules, 'light')
  const dark = theme(rules, 'dark')
  for (const k of ['--e1', '--e2', '--e-hero']) {
    assert.ok(light[k], `light :root has no ${k}`)
    assert.ok(dark[k], `.dark has no ${k}`)
  }
})

test('built css: --radius-<key> and --text-<key> carry the tokens.json px values', () => {
  const light = theme(cssRules(), 'light')
  const bad: string[] = []
  for (const g of ['radius', 'text']) {
    for (const [k, v] of Object.entries<string>(tokens[g])) {
      if (squash(light[`--${g}-${k}`] ?? '') !== v) bad.push(`--${g}-${k} is ${light[`--${g}-${k}`]}, not ${v}`)
    }
  }
  assert.deepEqual(bad, [])
})

test('built css: color-scheme is light in :root and dark in .dark', () => {
  const rules = cssRules()
  assert.equal(theme(rules, 'light')['color-scheme'], 'light')
  assert.equal(theme(rules, 'dark')['color-scheme'], 'dark')
})

test('built css: the stock Tailwind palette is not defined', () => {
  const css = readCss()
  assert.doesNotMatch(css, /--color-blue-500/)
  const stock = /--color-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d+/
  assert.doesNotMatch(css, stock)
  assert.doesNotMatch(css, /--color-(white|black)\s*:/)
})

test('built css: :focus-visible is a 2px --focus outline offset 2px with no border-radius', () => {
  const rule = cssRules().find((r) => !hasKeyframes(r) && sels(r).includes(':focus-visible') && r.decls['outline'])
  assert.ok(rule, 'no :focus-visible rule with an outline')
  assert.equal(squash(rule.decls['outline']), '2pxsolidvar(--focus)')
  assert.equal(squash(rule.decls['outline-offset']), '2px')
  assert.ok(!('border-radius' in rule.decls), ':focus-visible must not set border-radius')
})

test('built css: --focus is brand, move-fg on the move surface and fail when invalid', () => {
  const rules = cssRules()
  const get = (selector: string) => {
    const r = rules.filter((x) => !hasKeyframes(x) && sels(x).includes(selector) && x.decls['--focus'] !== undefined)
    return r.length ? squash(r[r.length - 1].decls['--focus']) : undefined
  }
  assert.equal(get(':root'), 'var(--brand)')
  assert.equal(get('[data-surface=move]'), 'var(--move-fg)')
  assert.equal(get('[aria-invalid=true]'), 'var(--fail)')
})

test('built css: --ring is defined only in :root', () => {
  const rules = cssRules()
  const where = rules.filter((r) => !hasKeyframes(r) && '--ring' in r.decls).map((r) => r.sel)
  assert.ok(where.length > 0, '--ring is not defined at all')
  for (const s of where) assert.ok(sels({ at: [], sel: s, decls: {} }).includes(':root'), `--ring is defined under ${s}`)
})

test('built css: ::selection uses --brand-line', () => {
  const r = cssRules().find((x) => sels(x).some((s) => s.endsWith('::selection') || s === ':selection'))
  assert.ok(r, 'no ::selection rule')
  assert.match(squash(Object.values(r.decls).join(';')), /var\(--brand-line\)/)
})

test('built css: reduced motion nulls animation on *, ::before and ::after', () => {
  const rules = cssRules().filter((r) => r.at.some((a) => /prefers-reduced-motion:\s*reduce/.test(a)))
  assert.ok(rules.length > 0, 'no prefers-reduced-motion: reduce block')
  const rule = rules.find((r) => r.decls['animation'] && /^none\s*!important$/.test(r.decls['animation'].trim()))
  assert.ok(rule, 'no `animation: none !important` in the reduced-motion block')
  const ss = sels(rule)
  assert.ok(ss.includes('*'), 'reduced motion does not cover *')
  assert.ok(ss.some((s) => /^(\*)?::?before$/.test(s)), 'reduced motion does not cover ::before')
  assert.ok(ss.some((s) => /^(\*)?::?after$/.test(s)), 'reduced motion does not cover ::after')
})

test('built css: the D2 keyframes, durations and easing exist', () => {
  const css = readCss()
  for (const k of ['arrive', 'tick-up', 'ping', 'dash', 'scan', 'sheen', 'glow']) {
    assert.match(css, new RegExp(`@keyframes\\s+${k}\\b`), `no @keyframes ${k}`)
  }
  const secs = (ms: number) => String(ms / 1000).replace(/^0\./, '0?\\.')
  for (const ms of [360, 420, 1600, 900, 1800, 2400]) {
    assert.match(css, new RegExp(`(?<![\\d.])(${ms}ms|${secs(ms)}s)(?![\\d])`), `no ${ms}ms duration`)
  }
  assert.match(css, /cubic-bezier\(\s*0?\.2\s*,\s*0\s*,\s*0\s*,\s*1\s*\)/, 'no cubic-bezier(.2,0,0,1)')
})

test('built css: Geist Variable and Geist Mono Variable are self-hosted with a woff2 file', () => {
  const faces = cssRules().filter((r) => r.sel === '@font-face').map((r) => squash(r.decls['font-family'] ?? ''))
  assert.ok(faces.includes('GeistVariable'), 'no @font-face for Geist Variable')
  assert.ok(faces.includes('GeistMonoVariable'), 'no @font-face for Geist Mono Variable')
  const woff = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.woff2'))
  assert.ok(woff.length > 0, `no woff2 in ${assetsDir}`)
})

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

test('no font or script is fetched from a CDN anywhere in ui/app or ui/web', () => {
  assert.ok(fs.existsSync(webDir), 'ui/web does not exist: the build has not run')
  const bad = [...walk(path.join(uiDir, 'app')), ...walk(webDir)]
    .filter((f) => !/\.(woff2?|png|ico)$/.test(f) && !/\.test\.ts$/.test(f))
    .filter((f) => /fonts\.googleapis|fonts\.gstatic|cdn\.tailwindcss|cdn\.jsdelivr|unpkg\.com/.test(fs.readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
})

// ---- the document ----

function scripts(html: string) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].map((m) => ({ attrs: m[1], body: m[2] }))
}

test('ui/app/index.html is the one CSP-safe document', () => {
  const html = read('app', 'index.html')
  assert.match(html, /<html[^>]*\blang=["']en["']/)
  assert.match(html, /<meta\s+name=["']viewport["']/i)
  assert.match(html, /<meta\s+name=["']color-scheme["']\s+content=["']light dark["']\s*\/?>/)
  assert.match(html, /<title>Truss<\/title>/)
  assert.match(html, /<link\s+rel=["']icon["']\s+type=["']image\/svg\+xml["']\s+href=["']\/favicon\.svg["']\s*\/?>/)
  const head = /<head[\s\S]*?<\/head>/i.exec(html)?.[0] ?? ''
  const theme = scripts(head).find((s) => /\bsrc=["']\/theme\.js["']/.test(s.attrs))
  assert.ok(theme, 'no <script src="/theme.js"> in the head')
  assert.doesNotMatch(theme.attrs, /\btype=|\bdefer\b|\basync\b/, 'theme.js must be a classic blocking script')
  assert.match(html, /id=["']root["']/)
  assert.match(html, /<noscript>\s*Truss needs JavaScript to show the run\.\s*<\/noscript>/)
  for (const s of scripts(html)) {
    assert.match(s.attrs, /\bsrc=/, 'inline <script>')
    assert.equal(s.body.trim(), '', 'inline <script> body')
  }
  assert.doesNotMatch(html, /<style\b/i)
  assert.doesNotMatch(html, /\sstyle=/i)
})

test('ui/web/index.html has no inline script or style', () => {
  assert.ok(fs.existsSync(path.join(webDir, 'index.html')), 'ui/web/index.html is missing: the build has not run')
  const html = read('web', 'index.html')
  for (const s of scripts(html)) {
    assert.match(s.attrs, /\bsrc=/, 'inline <script>')
    assert.equal(s.body.trim(), '', 'inline <script> body')
  }
  assert.doesNotMatch(html, /<style\b/i)
  assert.doesNotMatch(html, /\sstyle=/i)
  assert.ok(fs.existsSync(path.join(webDir, 'theme.js')), 'ui/web/theme.js was not copied by the build')
})

test('the favicon is a byte copy of the approved icon, in source and in the build', () => {
  const want = fs.readFileSync(path.join(uiDir, 'contract', 'redesign', 'icon-favicon.svg'))
  assert.ok(fs.readFileSync(path.join(uiDir, 'app', 'public', 'favicon.svg')).equals(want), 'ui/app/public/favicon.svg differs')
  assert.ok(fs.readFileSync(path.join(webDir, 'favicon.svg')).equals(want), 'ui/web/favicon.svg differs')
})

test('theme.js and theme.ts follow the OS theme and store nothing', () => {
  const js = read('app', 'public', 'theme.js')
  const ts = read('app', 'lib', 'theme.ts')
  assert.match(js, /matchMedia\(\s*['"]\(prefers-color-scheme:\s*dark\)['"]\s*\)/)
  assert.match(js, /documentElement/)
  assert.match(js, /classList\.(toggle|add)\(\s*['"]dark['"]/)
  assert.match(ts, /export\s+(function|const)\s+useTheme\b/)
  assert.match(ts, /useSyncExternalStore/)
  assert.doesNotMatch(js, /localStorage/)
  assert.doesNotMatch(ts, /localStorage/)
})

// ---- the package ----

test('ui/package.json is exact-pinned, matches the lock and holds the approved stack', () => {
  const p = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json')).packages['']
  const all: Record<string, string> = { ...p.dependencies, ...p.devDependencies }
  const bad: string[] = []
  for (const k of ['dependencies', 'devDependencies']) {
    for (const [n, v] of Object.entries<string>(p[k] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(v)) bad.push(`${n} is not exact-pinned: ${v}`)
      if (lock[k]?.[n] !== v) bad.push(`${n} ${v} is not in package-lock.json as is`)
    }
  }
  assert.deepEqual(bad, [])
  const need = [
    'react', 'react-dom', 'vite', 'tailwindcss', '@tailwindcss/vite', 'typescript', 'lucide-react',
    '@fontsource-variable/geist', '@fontsource-variable/geist-mono', 'class-variance-authority', 'clsx', 'tailwind-merge',
    ...['tabs', 'collapsible', 'radio-group', 'checkbox', 'label', 'slot'].map((x) => '@radix-ui/react-' + x),
  ]
  assert.deepEqual(need.filter((n) => !all[n]), [])
  const banned = ['dialog', 'popover', 'tooltip', 'scroll-area', 'toast'].map((x) => '@radix-ui/react-' + x).concat('sonner')
  assert.deepEqual(banned.filter((n) => all[n]), [])
})

test('ui/package.json scripts other than build are unchanged', () => {
  const s = JSON.parse(read('package.json')).scripts
  assert.equal(s.start, 'node server/main.ts')
  assert.equal(s.test, "node --test contract/state.check.ts contract/session.check.ts contract/http.check.ts test/*/*.test.ts 'app/**/*.test.ts'")
  assert.equal(s.e2e, 'playwright test')
  assert.equal(s['check:live'], 'node --test contract/live.check.ts')
})

test('ui/README.md gives the build step and ui/web is not tracked', () => {
  assert.ok(read('README.md').includes('npm --prefix ui run build'))
  const tracked = execFileSync('git', ['ls-files', 'ui/web'], { cwd: repoDir, encoding: 'utf8' }).trim()
  assert.equal(tracked, '', 'ui/web has tracked files; it is build output only')
})
