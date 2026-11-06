// One mermaid block of the architecture document (R-38, ADR-0028 section 5). It shows a placeholder while the
// mermaid chunk loads, then the drawn SVG in a focusable figure, or the source with the reason when it can't draw.
// mermaid is loaded by DesignPanel.tsx only; this file gets it through the `load` prop. The page CSP has no
// style-src, so while mermaid renders its <style> elements are kept out and its style attributes become
// presentation attributes, and the returned SVG is parsed with no style attribute left (colours are mermaid.css).
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
  | { k: 'drawn'; svg: Element; label: string; natural: number }

let seq = 0

/** The config mermaid gets. `flowchart.htmlLabels: false` is what makes flowchart labels SVG text (a top-level
 *  `htmlLabels` is not read by flowcharts), so the text is measured and drawn by the same font and fits its box. */
export const MERMAID_CONFIG = {
  startOnLoad: false,
  securityLevel: 'strict',
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  suppressErrorRendering: true,
  theme: 'base',
} as const

// While mermaid renders, the two things the CSP counts as inline style are kept out of the document: a `style`
// attribute set through setAttribute (what d3 does) becomes presentation attributes instead, and a
// <style> element is not inserted (mermaid.css does its job, ADR-0028 section 5). toElement strips what is left.
// Colour is the token stylesheet's job (mermaid.css), so those declarations are dropped. Font declarations stay so
// mermaid measures its text in the font it asked for; mermaid.css rules beat presentation attributes when drawn.
const DROPPED = /^(fill|stroke|color|background(-.*)?|max-.*|min-.*)$/

/** The declarations of a style attribute worth keeping, as [name, value]. */
export function keptDeclarations(css: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const name = decl.slice(0, i).trim().toLowerCase()
    if (!/^[a-z-]+$/.test(name) || DROPPED.test(name)) continue
    out.push([name, decl.slice(i + 1).replace(/\s*!important\s*$/i, '').trim()])
  }
  return out
}

const STYLE_ATTR = /\sstyle=("[^"]*"|'[^']*')/g

let guardDepth = 0
let restore: (() => void) | null = null

// The page's own elements and HTML elements (mermaid's measuring spans, never serialised) keep their normal style
// handling; mermaid's SVG elements, in its temporary container or detached, don't.
const inApp = (el: Element): boolean => !(el instanceof SVGElement) || el.closest('#root') !== null

/** A stand-in for element.style that turns writes into presentation attributes (see keptDeclarations). */
function styleSink(el: Element, setAttr: Element['setAttribute']): CSSStyleDeclaration {
  const put = (name: string, value: string) => {
    for (const [n, v] of keptDeclarations(`${name}:${value}`)) setAttr.call(el, n, v)
  }
  const kebab = (k: string) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
  return new Proxy({} as CSSStyleDeclaration, {
    get: (_t, k) => {
      if (k === 'setProperty') return (n: string, v: string) => put(n, v)
      if (k === 'removeProperty') return (n: string) => (el.removeAttribute(n), '')
      if (k === 'getPropertyValue') return (n: string) => el.getAttribute(n) ?? ''
      return ''
    },
    set: (_t, k, v) => {
      if (typeof k === 'string' && k !== 'cssText') put(kebab(k), String(v))
      return true
    },
  })
}

const isStyleEl = (n: unknown): boolean => n instanceof Element && n.localName === 'style'

function installGuard(): () => void {
  const setAttr = Element.prototype.setAttribute
  const append = Node.prototype.appendChild
  const insert = Node.prototype.insertBefore
  Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    if (name === 'style' && !inApp(this)) {
      // The kept declarations become presentation attributes: those survive mermaid's own sanitising pass, and
      // mermaid.css still wins over them.
      for (const [n, v] of keptDeclarations(String(value))) setAttr.call(this, n, v)
      return
    }
    return setAttr.call(this, name, value)
  }
  const styleOwners = [HTMLElement.prototype, SVGElement.prototype]
  const styleProps = styleOwners.map((o) => Object.getOwnPropertyDescriptor(o, 'style'))
  styleOwners.forEach((o, i) => {
    const d = styleProps[i]
    if (!d?.get) return
    Object.defineProperty(o, 'style', {
      ...d,
      get(this: Element) {
        return inApp(this) ? d.get!.call(this) : styleSink(this, setAttr)
      },
    })
  })
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
    return isStyleEl(node) ? node : (append.call(this, node) as T)
  }
  Node.prototype.insertBefore = function <T extends Node>(this: Node, node: T, ref: Node | null): T {
    return isStyleEl(node) ? node : (insert.call(this, node, ref) as T)
  }
  return () => {
    Element.prototype.setAttribute = setAttr
    Node.prototype.appendChild = append
    Node.prototype.insertBefore = insert
    styleOwners.forEach((o, i) => {
      if (styleProps[i]) Object.defineProperty(o, 'style', styleProps[i]!)
    })
  }
}

export function withCssomStyles<T>(run: () => Promise<T>): Promise<T> {
  if (guardDepth++ === 0) restore = installGuard()
  return run().finally(() => {
    if (--guardDepth === 0) {
      restore?.()
      restore = null
    }
  })
}

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim() !== '') ?? '').trim()
}

/** The SVG mermaid returned, made safe for a page with no style-src, and ready for the figure. */
function toElement(svg: string, source: string): { el: Element; label: string; natural: number } {
  // A style attribute in the markup is an inline style to the CSP even when parsed, so none reaches the parser.
  svg = svg.replace(STYLE_ATTR, '')
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  let root: Element | null = parsed.querySelector('parsererror') ? null : parsed.documentElement
  if (root === null) root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg')
  if (root === null || root.tagName.toLowerCase() !== 'svg') throw new Error('mermaid returned no SVG')
  const el = document.importNode(root, true)
  for (const s of Array.from(el.querySelectorAll('style'))) s.remove()
  const vb = (el.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  const natural = vb.length === 4 && Number.isFinite(vb[2]) && vb[2]! > 0 ? Math.ceil(vb[2]!) : 0
  // Scaled to fit: its natural width at most, never wider than the figure, height from the viewBox.
  el.removeAttribute('width')
  el.removeAttribute('height')
  const st = (el as unknown as ElementCSSInlineStyle).style
  st.setProperty('width', natural > 0 ? `${natural}px` : '100%')
  st.setProperty('max-width', '100%')
  st.setProperty('height', 'auto')
  st.setProperty('display', 'block')
  const acc = el.querySelector('title')?.textContent?.trim()
  const label = `Diagram: ${acc || firstLine(source) || 'untitled'}`
  el.setAttribute('role', 'img')
  el.setAttribute('aria-label', label)
  return { el, label, natural }
}

function SourcePre({ source, id }: { source: string; id?: string }) {
  return (
    <pre
      id={id}
      tabIndex={0}
      className="mt-2 max-w-full overflow-x-auto rounded-ctl bg-secondary p-3 font-mono text-ui whitespace-pre text-fg"
    >
      <code>
        {source.split('\n').map((line, i) => {
          const indent = line.length - line.trimStart().length
          // One block per line, with the indentation as padding: the text has no newline to collapse into a space.
          return (
            <span key={i} className="block min-h-[1lh]" style={indent > 0 ? { paddingLeft: `${indent}ch` } : undefined}>
              {line.trimStart()}
            </span>
          )
        })}
      </code>
    </pre>
  )
}

/** The drawing unscaled in a modal dialog: the browser traps focus in it, Esc closes it, and focus goes back. */
function FullSize({ svg, natural, title, onClose }: { svg: Element; natural: number; title: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (d && !d.open) d.showModal()
    return () => d?.close()
  }, [])
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      className="m-auto max-h-[90vh] max-w-[95vw] overflow-auto rounded-card border border-border bg-surface p-4 text-fg backdrop:bg-black/40"
    >
      <div className="sticky top-0 left-0 mb-2 flex items-center justify-between gap-3">
        <h2 id={titleId} className="text-lead font-semibold">
          {title}
        </h2>
        <Button size="sm" variant="ghost" autoFocus onClick={onClose}>
          Close
        </Button>
      </div>
      <div
        ref={(host) => {
          if (!host || host.firstChild) return
          const copy = svg.cloneNode(true) as Element
          const st = (copy as unknown as ElementCSSInlineStyle).style
          st.setProperty('max-width', 'none')
          st.setProperty('width', natural > 0 ? `${natural}px` : 'auto')
          host.replaceChildren(copy)
        }}
      />
    </dialog>
  )
}

export function MermaidBlock({ source, index, total, load, onDone }: MermaidBlockProps) {
  const [state, setState] = useState<State>({ k: 'loading' })
  const [slow, setSlow] = useState(false)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(false)
  const [full, setFull] = useState(false)
  const done = useRef(onDone)
  done.current = onDone
  const sourceId = useId()

  useEffect(() => {
    let dead = false
    setState({ k: 'loading' })
    setSlow(false)
    setOpen(false)
    setShown(false)
    setFull(false)
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
        const { svg } = await withCssomStyles(async () => {
          await api.parse(source)
          return api.render(id, source)
        })
        const { el, label, natural } = toElement(svg, source)
        finish({ k: 'drawn', svg: el, label, natural })
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
      <div role="note" style={{ minHeight: DIAGRAM_MIN }} className="my-3">
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
        'my-3 rounded-card border border-border bg-surface p-3 transition-opacity duration-(--duration-quick) ease-out',
        shown ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div
        ref={(host) => {
          if (host && host.firstChild !== state.svg) host.replaceChildren(state.svg)
        }}
      />
      <div className="mt-2 max-w-full">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setFull(true)}
        >
          Open full size
        </Button>
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
      {full && <FullSize svg={state.svg} natural={state.natural} title={state.label} onClose={() => setFull(false)} />}
    </figure>
  )
}
