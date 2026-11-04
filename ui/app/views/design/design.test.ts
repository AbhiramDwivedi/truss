// Spec-first checks for the design area (rework-docs, R-38 and R-39, ADR-0028 sections 2 to 5).
// Written from the UX direction before the build: latestOnly(md), the Markdown placeholder for mermaid blocks, and
// source-level rules for the mermaid setup. Async drawing is the e2e spec's job (ui/contract/rework/docs.spec.ts).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { createRenderer, appDir, type Renderer } from '../../test/render.ts'

const designDir = path.join(appDir, 'views', 'design')
const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })

async function latestOnlyFn(): Promise<(md: string) => string> {
  const mod = await r.load('views/design/DesignPanel.tsx')
  assert.equal(typeof mod.latestOnly, 'function', 'DesignPanel.tsx exports a pure function latestOnly(md)')
  return mod.latestOnly
}

// ---- latestOnly (R-39) --------------------------------------------------------------------------------------
test('latestOnly drops Change log, Changelog, History and Versions sections with their bodies', async () => {
  const latestOnly = await latestOnlyFn()
  for (const h of ['Change log', 'Changelog', 'History', 'Versions', 'Version history']) {
    const md = `# Doc\n\n## Modules\n\nKeep me.\n\n## ${h}\n\nDrop body for ${h}.\n\n- item\n\n## Next\n\nStays.\n`
    const out = latestOnly(md)
    assert.doesNotMatch(out, new RegExp(`## ${h}`), `${h} heading is gone`)
    assert.doesNotMatch(out, /Drop body/, `${h} body is gone`)
    assert.match(out, /Keep me\./)
    assert.match(out, /## Next/)
    assert.match(out, /Stays\./)
  }
})

test('latestOnly matches the heading case-insensitively and at any level', async () => {
  const latestOnly = await latestOnlyFn()
  const out = latestOnly('# A\n\n### CHANGE LOG\n\ngone\n\n### B\n\nkept\n')
  assert.doesNotMatch(out, /CHANGE LOG|gone/)
  assert.match(out, /### B/)
  assert.match(out, /kept/)
})

test('latestOnly also drops a nested lower-level heading under a dropped one', async () => {
  const latestOnly = await latestOnlyFn()
  const md = '## Modules\n\nkeep\n\n## Change log\n\nintro gone\n\n### 2026-11-01\n\nnested gone\n\n#### deeper\n\ndeeper gone\n\n## After\n\nafter stays\n'
  const out = latestOnly(md)
  assert.doesNotMatch(out, /intro gone|nested gone|deeper gone|2026-11-01|deeper/)
  assert.match(out, /## After/)
  assert.match(out, /after stays/)
  assert.match(out, /keep/)
})

test('latestOnly: the next same-level section stays, and a higher-level heading ends the drop', async () => {
  const latestOnly = await latestOnlyFn()
  const md = '# Top\n\n## History\n\nold\n\n### Old sub\n\nold sub\n\n# Another top\n\nstays under top\n\n## Sibling\n\nsibling stays\n'
  const out = latestOnly(md)
  assert.doesNotMatch(out, /## History|old sub|Old sub/)
  assert.doesNotMatch(out, /\bold\b/)
  assert.match(out, /# Another top/)
  assert.match(out, /stays under top/)
  assert.match(out, /## Sibling/)
})

test('latestOnly keeps a "# History" line inside a code fence, and does not start a drop from it', async () => {
  const latestOnly = await latestOnlyFn()
  const md = '## Example\n\n```md\n# History\n\nfenced body\n```\n\nafter fence\n\n~~~\n## Versions\n~~~\n\ntail\n'
  assert.equal(latestOnly(md), md)
})

test('latestOnly keeps a heading that sits inside a fence while a real one outside is still dropped', async () => {
  const latestOnly = await latestOnlyFn()
  const md = '## History\n\n```\n## Not a heading\n```\n\nbody gone\n\n## Keep\n\nkept\n'
  const out = latestOnly(md)
  assert.doesNotMatch(out, /body gone|Not a heading|## History/)
  assert.match(out, /## Keep/)
  assert.match(out, /kept/)
})

test('latestOnly returns text without such headings unchanged', async () => {
  const latestOnly = await latestOnlyFn()
  const md = '# Architecture\n\n## Modules\n\nThe history of the project is long. Versions of things.\n\n## Decisions\n\n- a\n- b\n'
  assert.equal(latestOnly(md), md)
  assert.equal(latestOnly(''), '')
})

test('latestOnly on the architecture fixture leaves no Change log, History or Versions heading', async () => {
  const latestOnly = await latestOnlyFn()
  const fixture = read(path.join(appDir, '..', 'contract', 'fixtures', 'rework', 'architecture', 'architecture.md'))
  assert.ok(fixture.length > 0, 'the architecture fixture exists')
  const out = latestOnly(fixture)
  const heads = out.split('\n').filter((l) => /^#{1,6}\s/.test(l))
  assert.ok(!heads.some((l) => /\b(change ?log|history|versions?)\b/i.test(l)), 'no dropped-kind heading remains')
})

// ---- Markdown placeholder (R-38) ----------------------------------------------------------------------------
test('Markdown: a mermaid block first renders as the "Drawing diagram…" placeholder with aria-busy', async () => {
  const mod = await r.load('views/design/DesignPanel.tsx')
  assert.equal(typeof mod.Markdown, 'function', 'DesignPanel.tsx exports the Markdown component')
  const html: string = r.render(React.createElement(mod.Markdown, { text: '## Flow\n\n```mermaid\ngraph TD\n  Client --> PM\n```\n\nAfter.\n' }))
  assert.match(html, /Drawing diagram…/, 'the placeholder text')
  assert.match(html, /aria-busy="true"/, 'the placeholder is aria-busy')
  assert.doesNotMatch(html, /mermaid diagram \(source\)/, 'the old source label is gone')
  assert.match(html, /After\./, 'the rest of the document still renders')
})

test('Markdown: raw <script> in the markdown is still escaped', async () => {
  const mod = await r.load('views/design/DesignPanel.tsx')
  assert.equal(typeof mod.Markdown, 'function', 'DesignPanel.tsx exports the Markdown component')
  const html: string = r.render(React.createElement(mod.Markdown, { text: 'Hello\n\n<script>alert(1)</script>\n\n```mermaid\ngraph TD\n  A --> B\n```\n' }))
  assert.doesNotMatch(html, /<script/i)
  assert.match(html, /&lt;script&gt;/)
})

// ---- source rules (ADR-0028 section 5) ----------------------------------------------------------------------
const panelSrc = () => stripComments(read(path.join(designDir, 'DesignPanel.tsx')))
const blockSrc = () => stripComments(read(path.join(designDir, 'MermaidBlock.tsx')))
const bothSrc = () => panelSrc() + '\n' + blockSrc()
const q = `['"\`]`

test('mermaid is initialised strictly: securityLevel strict, htmlLabels false, suppressErrorRendering true, startOnLoad false, theme base', () => {
  const s = bothSrc()
  assert.match(s, new RegExp(`securityLevel\\s*:\\s*${q}strict${q}`), "securityLevel: 'strict'")
  assert.match(s, /htmlLabels\s*:\s*false/, 'htmlLabels: false')
  assert.match(s, /suppressErrorRendering\s*:\s*true/, 'suppressErrorRendering: true')
  assert.match(s, /startOnLoad\s*:\s*false/, 'startOnLoad: false')
  assert.match(s, new RegExp(`theme\\s*:\\s*${q}base${q}`), "theme: 'base'")
})

test('mermaid ids are truss-mmd-<n>, the SVG goes in through DOMParser, and parse() runs before render()', () => {
  const s = bothSrc()
  assert.match(s, /truss-mmd-/, 'ids truss-mmd-<n>')
  assert.match(s, /DOMParser/, 'SVG parsed with DOMParser')
  assert.match(s, /importNode/, 'SVG imported with importNode')
  const parseAt = s.search(/(?<!marked)\.parse\(/)
  const renderAt = s.search(/\.render\(/)
  assert.ok(parseAt >= 0, 'a mermaid .parse( call exists')
  assert.ok(renderAt >= 0, 'a mermaid .render( call exists')
  assert.ok(parseAt < renderAt, 'parse( comes before render(')
  assert.match(s, /<style|querySelectorAll\(\s*['"]style['"]\s*\)|['"]style['"]/, 'style elements are handled')
})

test('no .innerHTML assignment in DesignPanel.tsx or MermaidBlock.tsx', () => {
  assert.ok(panelSrc().length > 0)
  assert.doesNotMatch(bothSrc(), /\.innerHTML\s*(\+)?=(?!=)/)
})

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walkFiles(p, out) } else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p)
  }
  return out
}

test("import('mermaid') appears in DesignPanel.tsx and in no other file under ui/app", () => {
  const hits = walkFiles(appDir).filter((f) => new RegExp(`import\\(\\s*${q}mermaid${q}\\s*\\)`).test(stripComments(read(f)))).map((f) => path.relative(appDir, f))
  assert.deepEqual(hits, [path.join('views', 'design', 'DesignPanel.tsx')])
})

test('DIAGRAM_MIN is 160 and MermaidBlock.tsx exports MermaidBlock and DIAGRAM_MIN', () => {
  const file = path.join(designDir, 'MermaidBlock.tsx')
  assert.ok(fs.existsSync(file), 'ui/app/views/design/MermaidBlock.tsx exists')
  const s = read(file)
  assert.match(s, /export\s+const\s+DIAGRAM_MIN\s*(:\s*number\s*)?=\s*160\b/)
  assert.match(s, /export\s+(function|const)\s+MermaidBlock\b/)
})

test('mermaid.css themes svg[id^="truss-mmd-"] with token variables and no hex colours', () => {
  const file = path.join(designDir, 'mermaid.css')
  assert.ok(fs.existsSync(file), 'ui/app/views/design/mermaid.css exists')
  const css = read(file).replace(/\/\*[\s\S]*?\*\//g, '')
  assert.match(css, /svg\[id\^=["']truss-mmd-["']\]/, 'selects svg[id^="truss-mmd-"]')
  assert.match(css, /var\(--/, 'uses token variables')
  for (const t of ['--surface', '--border-strong', '--fg', '--muted', '--sunken']) assert.ok(css.includes(`var(${t}`), `uses var(${t})`)
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b/, 'no raw hex colours')
})

test('DesignPanel.tsx imports mermaid.css', () => {
  assert.match(read(path.join(designDir, 'DesignPanel.tsx')), /import\s+['"]\.\/mermaid\.css['"]/)
})
