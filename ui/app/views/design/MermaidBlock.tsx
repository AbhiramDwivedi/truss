// One mermaid block of the architecture document (R-38, ADR-0028 section 5). It shows a placeholder while the
// mermaid chunk loads, then the drawn SVG in a focusable figure, or the source with the reason when it can't draw.
// mermaid is loaded by DesignPanel.tsx only; this file gets it through the `load` prop. The page CSP has no
// style-src, so the returned SVG is parsed, its <style> elements are removed, and its style attributes are moved
// into CSSOM writes (allowed under the CSP) that leave the colours to mermaid.css.
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'

/** The placeholder's height and the drawn figure's minimum height, in px, so the page below doesn't jump. */
export const DIAGRAM_MIN = 160

/** After this long without the mermaid chunk, the placeholder shows the source too, and keeps waiting. */
export const SLOW_MS = 8000

/** The part of mermaid's API this file uses. */
export interface MermaidApi {
  parse: (text: string) => Promise<unknown>
  render: (id: string, text: string) => Promise<{ svg: string }>
}

export interface MermaidBlockProps {
  source: string
  /** Position in the shown document, from 0. */
  index: number
  /** How many mermaid blocks the shown document holds, drawn or not. */
  total: number
  load: () => Promise<MermaidApi>
  /** Called once per outcome: true when drawn, false when the source is shown instead. */
  onDone?: (index: number, drawn: boolean) => void
}

type State =
  | { k: 'loading' }
  | { k: 'chunk' }
  | { k: 'error'; line: string }
  | { k: 'drawn'; svg: Element; label: string }

let seq = 0

// Colour and font are the token stylesheet's job (mermaid.css); layout properties are kept.
const DROPPED = /^(fill|stroke|color|font(-.*)?|background(-.*)?)$/

function moveStyle(el: Element): void {
  const css = el.getAttribute('style')
  if (css === null) return
  el.removeAttribute('style')
  const style = (el as unknown as ElementCSSInlineStyle).style
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const name = decl.slice(0, i).trim().toLowerCase()
    if (name === '' || DROPPED.test(name)) continue
    const important = /\s*!important\s*$/i.test(decl)
    style.setProperty(name, decl.slice(i + 1).replace(/\s*!important\s*$/i, '').trim(), important ? 'important' : '')
  }
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim() !== '') ?? '').trim()
}

/** The SVG mermaid returned, made safe for a page with no style-src, and ready for the figure. */
function toElement(svg: string, source: string): { el: Element; label: string } {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  let root: Element | null = parsed.querySelector('parsererror') ? null : parsed.documentElement
  if (root === null) root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')
  if (root === null || root.tagName.toLowerCase() !== 'svg') throw new Error('mermaid returned no SVG')
  const el = document.importNode(root, true)
  for (const s of Array.from(el.querySelectorAll('style'))) s.remove()
  for (const n of [el, ...Array.from(el.querySelectorAll('[style]'))]) moveStyle(n)
  const vb = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const natural = vb.length === 4 && Number.isFinite(vb[2]) && vb[2]! > 0 ? Math.ceil(vb[2]!) : 0
  if (natural > 0) {
    el.setAttribute('width', String(natural))
    el.removeAttribute('height')
  }
  ;(el as unknown as ElementCSSInlineStyle).style.setProperty('max-width', 'none')
  ;(el as unknown as ElementCSSInlineStyle).style.setProperty('display', 'block')
  const acc = el.querySelector('title')?.textContent?.trim()
  const label = `Diagram: ${acc || firstLine(source) || 'untitled'}`
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', label)
  return { el, label }
}

function SourcePre({ source, id }: { source: string; id?: string }) {
  return (
    <pre
      id={id}
      tabIndex={0}
      className="mt-2 max-w-full overflow-x-auto rounded-ctl bg-secondary p-3 font-mono text-ui whitespace-pre text-fg"
    >
      <code>{source}</code>
    </pre>
  )
}

export function MermaidBlock({ source, index, total, load, onDone }: MermaidBlockProps) {
  const [state, setState] = useState<State>({ k: 'loading' })
  const [slow, setSlow] = useState(false)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)
  const done = useRef(onDone)
  done.current = onDone
  const sourceId = useId()

  useEffect(() => {
    let dead = false
    setState({ k: 'loading' })
    setSlow(false)
    setOpen(false)
    setShown(false)
    const timer = setTimeout(() => {
      if (!dead) setSlow(true)
    }, SLOW_MS)
    const finish = (next: State) => {
      if (dead) return
      clearTimeout(timer)
      setState(next)
      done.current?.(index, next.k === 'drawn')
    }
    void (async () => {
      let api: MermaidApi
      try {
        api = await load()
      } catch {
        finish({ k: 'chunk' })
        return
      }
      if (dead) return
      const id = `truss-mmd-${++seq}`
      try {
        await api.parse(source)
        const { svg } = await api.render(id, source)
        const { el, label } = toElement(svg, source)
        finish({ k: 'drawn', svg: el, label })
      } catch (e) {
        const msg = firstLine(String((e as { message?: unknown } | null)?.message ?? e ?? ''))
        finish({ k: 'error', line: (msg || 'unknown error').slice(0, 160) })
      } finally {
        // mermaid's measuring wrapper, left behind when a render throws.
        document.getElementById(`d${id}`)?.remove()
        document.getElementById(id)?.remove()
      }
    })()
    return () => {
      dead = true
      clearTimeout(timer)
    }
  }, [source, index, load])

  const drawn = state.k === 'drawn' ? state : null
  useEffect(() => {
    if (!drawn) return
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [drawn])

  if (state.k === 'loading') {
    return (
      <div className="my-3">
        <div
          aria-busy="true"
          style={{ height: DIAGRAM_MIN }}
          className="grid place-items-center rounded-card border border-border bg-sunken px-3 text-center text-ui text-muted"
        >
          Drawing diagram…
        </div>
        {slow && (
          <div className="mt-2">
            <p className="text-meta text-muted">The diagram tool is slow to load; its source is below.</p>
            <SourcePre source={source} />
          </div>
        )}
      </div>
    )
  }
  if (state.k === 'chunk') {
    return (
      <div className="my-3">
        <p className="text-meta text-muted">Diagrams couldn't load, so their source is shown.</p>
        <SourcePre source={source} />
      </div>
    )
  }
  if (state.k === 'error') {
    return (
      <div role="note" className="my-3">
        <p className="text-ui text-fg">This diagram couldn't be drawn: {state.line}</p>
        <SourcePre source={source} />
      </div>
    )
  }
  return (
    <figure
      tabIndex={0}
      aria-label={`Diagram ${index + 1} of ${total}`}
      style={{ minHeight: DIAGRAM_MIN }}
      className={cn(
        'my-3 overflow-x-auto rounded-card border border-border bg-surface p-3 transition-opacity duration-(--duration-quick) ease-out',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        ref={(host) => {
          if (host && host.firstChild !== state.svg) host.replaceChildren(state.svg)
        }}
      />
      <div className="sticky left-0 mt-2 max-w-full">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open}
          aria-controls={sourceId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide source' : 'Show source'}
        </Button>
        {open && <SourcePre source={source} id={sourceId} />}
      </div>
    </figure>
  )
}
