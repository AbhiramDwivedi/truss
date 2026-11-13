// @ts-nocheck
// Truss 0.31.0 item 4: docs cite code by symbol, never by line. The finder behind `doc-citations-031.check.ts`.
// A line citation goes stale with every edit above the cited line, and a stale one sends the next reader to the wrong code.
// Cite the function, constant or test name instead (`bin/store.ts` `withLock`), or a markdown file's section heading.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

// a path with a file extension, then `:N`, `:N-M` or `#LN`: `bin/store.ts:204`, `ux-engineer.md:41-42`, `a.js#L12`
const EXT = '(?:ts|tsx|js|jsx|mjs|cjs|md|json|py|sh|ps1|cmd|yml|yaml|toml|css|html)'
const PATH_LINE = new RegExp(`[A-Za-z0-9_.-]+\\.${EXT}(?::\\d+(?:[-–]\\d+)?\\b|#L\\d+)`, 'g')
// a bare follow-on `:N` or `:N-M` that names its file only by context: `` `:1046-1047` ``, `(:1046-1047)`, `, :40`
const BARE = /(?:^|[\s(`,;[])(:\d+(?:[-–]\d+)?)(?=[\s)`,;.\]]|$)/g

// Every line citation in one markdown text, as {line, text}. Fenced code blocks are skipped: an example there is not a citation.
export function lineCitations(md) {
  const out = []
  let fence = null
  md.replace(/\r/g, '').split('\n').forEach((l, i) => {
    const f = /^\s*(```+|~~~+)/.exec(l)
    if (f) {
      if (fence === null) fence = f[1][0]
      else if (f[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    for (const m of l.matchAll(PATH_LINE)) out.push({ line: i + 1, text: m[0] })
    for (const m of l.matchAll(BARE)) out.push({ line: i + 1, text: m[1] })
  })
  return out
}

// The docs the lint covers, repo-relative with `/`: the plugin docs (ADRs and goals included), the repo docs (feature map,
// knowledge docs) and the rule files. A missing directory is skipped, so a test can point `root` at a fixture tree.
// The doc roots the lint walks. `.claude/truss.json` targetedTests.map must send each root to the citation checks; doc-citations-031.check.ts pins that.
export const CITATION_DOC_ROOTS = ['plugins/truss/docs', 'docs', '.claude/rules']

export function citationDocs(root) {
  const out = []
  const walk = (rel) => {
    const abs = path.join(root, ...rel.split('/'))
    if (!existsSync(abs)) return
    for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'node_modules') walk(r) } else if (e.isFile() && e.name.endsWith('.md')) out.push(r)
    }
  }
  for (const d of CITATION_DOC_ROOTS) walk(d)
  return out
}

// `<doc>:<line> cites <text>` for every line citation under root.
export function citationLintFailures(root) {
  return citationDocs(root).flatMap((d) => lineCitations(readFileSync(path.join(root, ...d.split('/')), 'utf8')).map((c) => `${d}:${c.line} cites ${c.text}`))
}
