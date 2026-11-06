// The Design tab's body (ADR-0011 Decision 7, R-6): plan.md and the architecture doc as markdown, the images
// the run's crew branches built (through /api/image), and mermaid blocks as labelled source. App loads this
// file with React.lazy, so marked is fetched only when the tab opens. Raw HTML in the markdown is escaped,
// never passed through; links keep only web, mail and relative targets; markdown images show as words, since
// the page may load only its own files. Mermaid blocks are drawn as diagrams (R-38, ADR-0028 section 5): the
// mermaid chunk is imported here and nowhere else, on the first render of a block, and a block that can't be
// drawn shows its source. Only the latest architecture shows (R-39): change log, history and versions
// sections are dropped before the markdown is rendered.
import { useCallback, useMemo, useState } from 'react'
import { Marked, type Tokens } from 'marked'
import { ImageOff, RotateCw } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import type { DesignImage, RunState } from '../../store/types.ts'
import { imageUrl } from '../rail/format.ts'
import { MERMAID_CONFIG, MermaidBlock, type MermaidApi } from './MermaidBlock.tsx'
import './mermaid.css'

export interface DesignPanelProps {
  state: RunState | null
  now: number
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function safeHref(href: string): boolean {
  const h = String(href || '').trim()
  if (/^(https?:|mailto:|#)/i.test(h)) return true
  return !/^[a-z][a-z0-9+.-]*:/i.test(h)
}

// The mermaid blocks of the document being parsed, in order. toHtml fills it; the code renderer below leaves a
// marker per block, which Markdown swaps for a MermaidBlock. Raw HTML is escaped, so no text can forge a marker.
let found: string[] = []
const MARKER = /<div data-mermaid="(\d+)"><\/div>\n?/

const marked = new Marked({
  gfm: true,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(text)
    },
    code({ text, lang }: Tokens.Code) {
      const word = String(lang || '').trim().split(/\s+/)[0]!.toLowerCase()
      if (word === 'mermaid') {
        found.push(text)
        return `<div data-mermaid="${found.length - 1}"></div>\n`
      }
      return `<pre tabindex="0"><code>${escapeHtml(text)}</code></pre>\n`
    },
    link(token: Tokens.Link) {
      if (!safeHref(token.href)) return this.parser.parseInline(token.tokens)
      return false
    },
    image({ text }: Tokens.Image) {
      return `<span>[image: ${escapeHtml(text || 'no description')}]</span>`
    },
  },
})

/** A run of html, or (diagram set) the place of the mermaid block with that number in `sources`. */
interface Piece {
  html: string
  diagram: number | null
}
interface Pieces {
  parts: Piece[]
  sources: string[]
}

/** The pieces for `markdown` in order, or null when marked throws (the caller shows the text as it is). */
function toPieces(markdown: string): Pieces | null {
  found = []
  try {
    // A wide table scrolls inside a focusable box, so a keyboard can scroll it too (axe scrollable-region-focusable).
    // Raw HTML in the markdown is escaped, so every <table> here is one marked wrote.
    const html = (marked.parse(String(markdown), { async: false }) as string)
      .replace(/<table>/g, '<div tabindex="0" data-table-scroll><table>')
      .replace(/<\/table>/g, '</table></div>')
    const cut = html.split(new RegExp(MARKER.source, 'g'))
    const out: Piece[] = []
    for (let i = 0; i < cut.length; i += 2) {
      if (cut[i]) out.push({ html: cut[i]!, diagram: null })
      if (cut[i + 1] !== undefined) out.push({ html: '', diagram: Number(cut[i + 1]) })
    }
    return { parts: out, sources: found }
  } catch {
    return null
  }
}

/** mermaid, imported once on the first block that needs it; a failed import is tried again on the next open. */
let mermaidLoad: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  if (mermaidLoad === null) {
    mermaidLoad = import('mermaid')
      .then((mod) => {
        const m = mod.default
        m.initialize({ ...MERMAID_CONFIG, flowchart: { ...MERMAID_CONFIG.flowchart } })
        return m as MermaidApi
      })
      .catch((e: unknown) => {
        mermaidLoad = null
        throw e
      })
  }
  return mermaidLoad
}

// Prose styles for marked's output, from the D2 type scale; Tailwind's preflight strips the browser's own.
const prose =
  'min-w-0 text-body break-words text-fg ' +
  '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-title [&_h1]:font-semibold first:[&_h1]:mt-0 ' +
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lead [&_h2]:font-semibold ' +
  '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-body [&_h3]:font-semibold ' +
  '[&_h4]:mt-3 [&_h4]:mb-1 [&_h4]:text-ui [&_h4]:font-semibold ' +
  '[&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 ' +
  '[&_a]:text-brand-strong [&_a]:underline [&_strong]:font-semibold [&_em]:italic ' +
  '[&_blockquote]:border-l-2 [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-muted ' +
  '[&_code]:font-mono [&_code]:text-ui [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-ctl [&_pre]:bg-secondary [&_pre]:p-3 ' +
  '[&_figcaption]:mt-2 [&_figcaption]:text-meta [&_figcaption]:font-medium [&_figcaption]:text-muted ' +
  '[&_[data-table-scroll]]:my-2 [&_[data-table-scroll]]:max-w-full [&_[data-table-scroll]]:overflow-x-auto [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left ' +
  '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_hr]:my-4 [&_hr]:border-border'

/** The markdown cut at its `## ` headings (never inside a code fence), each part with its heading. */
export function sections(markdown: string): string[] {
  const out: string[] = []
  let part: string[] = []
  let fence: string | null = null
  for (const line of String(markdown).split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) fence = fence === null ? f[1]![0]! : fence === f[1]![0] ? null : fence
    if (fence === null && /^## /.test(line) && part.length > 0) {
      out.push(part.join('\n'))
      part = []
    }
    part.push(line)
  }
  out.push(part.join('\n'))
  return out
}

// A long document opens at its first sections, up to this many lines; the rest renders on request.
// The architecture doc runs to over a thousand lines, and drawing it all at once makes the tab slow to open.
export const FIRST_LINES = 150

/** How many of `parts` show before "Show the whole document": always the first, then while they fit. */
export function firstCount(parts: string[], budget = FIRST_LINES): number {
  let lines = 0
  let n = 0
  for (const p of parts) {
    lines += p.split('\n').length
    if (n > 0 && lines > budget) break
    n++
  }
  return n
}

const HEADING_DROPPED = /\b(change ?log|history|versions?)\b/i

/** The markdown without its change log, history and versions sections (R-39): each such heading goes, with
 *  everything up to the next heading of the same or a higher level. Lines in code fences are never headings. */
export function latestOnly(markdown: string): string {
  const out: string[] = []
  let fence: string | null = null
  let dropping = 0 // the level of the heading being dropped, or 0
  for (const line of String(markdown).split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (f) fence = fence === null ? f[1]![0]! : fence === f[1]![0] ? null : fence
    if (fence === null && !f) {
      const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
      if (h) {
        const level = h[1]!.length
        if (dropping > 0 && level <= dropping) dropping = 0
        if (dropping === 0 && HEADING_DROPPED.test(h[2]!)) dropping = level
      }
    }
    if (dropping === 0) out.push(line)
  }
  return out.join('\n')
}

export function Markdown({ text: raw }: { text: string }) {
  const text = useMemo(() => latestOnly(raw), [raw])
  const parts = useMemo(() => sections(text), [text])
  const first = useMemo(() => firstCount(parts), [parts])
  const [whole, setWhole] = useState(false)
  const shownText = whole || first >= parts.length ? text : parts.slice(0, first).join('\n')
  const pieces = useMemo(() => toPieces(shownText), [shownText])
  const more = parts.length - first
  // Each block reports once; the status line speaks when every block of the shown document has.
  const [outcome, setOutcome] = useState<Record<number, boolean>>({})
  const onDone = useCallback((i: number, drawn: boolean) => setOutcome((o) => (o[i] === drawn ? o : { ...o, [i]: drawn })), [])
  if (pieces === null) {
    return (
      <pre tabIndex={0} className="overflow-x-auto rounded-ctl bg-secondary p-3 font-mono text-ui whitespace-pre-wrap text-fg">
        {text}
      </pre>
    )
  }
  const total = pieces.sources.length
  const settled = Array.from({ length: total }, (_, i) => outcome[i]).filter((v) => v !== undefined)
  const failed = settled.filter((v) => !v).length
  const status =
    total === 0 || settled.length < total
      ? ''
      : failed === 0
        ? `Diagrams drawn: ${total} of ${total}`
        : `${failed} ${failed === 1 ? 'diagram' : 'diagrams'} couldn't be drawn`
  return (
    <>
      <div className={prose}>
        {pieces.parts.map((p, i) =>
          p.diagram === null ? (
            <div key={i} dangerouslySetInnerHTML={{ __html: p.html }} />
          ) : (
            <MermaidBlock key={i} source={pieces.sources[p.diagram]!} index={p.diagram} total={total} load={loadMermaid} onDone={onDone} />
          ),
        )}
      </div>
      <p role="status" className="sr-only">
        {status}
      </p>
      {!whole && more > 0 && (
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setWhole(true)}>
          Show the whole document ({more} more {more === 1 ? 'section' : 'sections'})
        </Button>
      )}
    </>
  )
}

function Figure({ img }: { img: DesignImage }) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  // An absolute URL on the page's own origin, so the src works wherever it is read back.
  const src = new URL(imageUrl(img) + (attempt ? `&retry=${attempt}` : ''), window.location.href).href
  return (
    <li className="min-w-0">
      <figure className="min-w-0 overflow-hidden rounded-card border border-border bg-surface shadow-e1">
        {failed ? (
          <div className="grid min-h-32 place-items-center gap-2 bg-secondary p-4 text-center">
            <ImageOff aria-hidden="true" className="size-5 text-muted" />
            <p role="alert" className="text-ui text-fg">
              Couldn't load the design files.
            </p>
            <Button
              size="sm"
              icon={<RotateCw aria-hidden="true" />}
              onClick={() => {
                setFailed(false)
                setAttempt((n) => n + 1)
              }}
            >
              Retry
            </Button>
          </div>
        ) : (
          <img
            key={attempt}
            src={src}
            alt={`${img.path} (built on ${img.ref})`}
            onError={() => setFailed(true)}
            className="block h-auto w-full bg-secondary"
          />
        )}
        <figcaption className="border-t border-border px-3 py-2 font-mono text-micro break-all text-muted">
          {img.path} ({img.ref})
        </figcaption>
      </figure>
    </li>
  )
}

export function DesignPanel({ state }: DesignPanelProps) {
  const design = state?.design ?? null
  const plan = design?.planMd ?? null
  const arch = design?.architecture ?? null
  const images = design?.images ?? []
  if (plan == null && arch == null && images.length === 0) {
    return <p className="text-ui text-muted">No plan, architecture doc or images yet.</p>
  }
  return (
    <div className="min-w-0 space-y-6">
      {plan != null && (
        <section aria-labelledby="design-plan-h" className="min-w-0 rounded-card border border-border bg-surface p-4 shadow-e1">
          <h3 id="design-plan-h" className="mb-2 text-meta font-medium text-muted">
            Plan
          </h3>
          <Markdown text={plan} />
        </section>
      )}
      {arch != null && (
        <section aria-labelledby="design-arch-h" className="min-w-0 rounded-card border border-border bg-surface p-4 shadow-e1">
          <h3 id="design-arch-h" className="mb-2 text-meta font-medium break-all text-muted">
            Architecture: <span className="font-mono">{arch.path}</span>
          </h3>
          <Markdown text={arch.markdown} />
        </section>
      )}
      {images.length > 0 && (
        <section aria-labelledby="design-img-h" className="min-w-0">
          <h3 id="design-img-h" className="mb-2 text-meta font-medium text-muted">
            Images the run built
          </h3>
          <ul aria-label="Images the run built" className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {images.map((img) => (
              <Figure key={`${img.ref}\n${img.path}`} img={img} />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
