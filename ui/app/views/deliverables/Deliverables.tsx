// "Built artifacts and deliverables" (ADR-0023 section 4 "artifacts", D2 :762-830). The items come from the
// state alone: Plan is design.planMd, Docs are the architecture doc (ADRs live in the rail's timeline only, R-37),
// Code is one item per merged crew, Images are design.images (an image whose crew hasn't merged is pending). A type
// filter with counts, a Group by toggle, the list, and a preview: an aside at 1024 px and up, the Deliverable
// dialog below it. Plan and Architecture preview as rendered markdown (lazy), and the timeline can open one ADR's
// fields here through preview-target.ts.
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { Box, Copy, ExternalLink } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { Badge } from '../../components/ui/badge.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { cn } from '../../lib/utils.ts'
import type { RunState } from '../../store/types.ts'
import { basename, crewOfRef, hhmm, imageUrl } from '../rail/format.ts'
import { AdrPreview } from './AdrPreview.tsx'
import { DeliverableDialog } from './DeliverableDialog.tsx'
import { DeliverableItem, TYPE_LABEL, useCopy, type Deliverable, type DeliverableType } from './DeliverableItem.tsx'
import { usePreviewTarget } from './preview-target.ts'

// marked and mermaid load only when a document preview first opens.
const Markdown = lazy(() => import('../design/DesignPanel.tsx').then((m) => ({ default: m.Markdown })))

export interface DeliverablesProps {
  state: RunState | null
  now: number
  /** Opens the Design tab, where the full document or image lives. */
  onOpenDesign?: () => void
}

type Filter = 'all' | DeliverableType
type GroupBy = 'stage' | 'type'

const FILTERS: Filter[] = ['all', 'docs', 'code', 'plan', 'images']
const TYPE_ORDER: DeliverableType[] = ['plan', 'docs', 'code', 'images']
/** Items shown per group before "Show N more". */
const PAGE = 50

/** Every deliverable, in a stable order: run inputs, then by stage. */
export function deliverablesOf(state: RunState): Deliverable[] {
  const out: Deliverable[] = []
  const design = state.design
  // Architecture is always the first run input and the first Docs item.
  if (design?.architecture != null) {
    const a = design.architecture
    out.push({ id: 'architecture', type: 'docs', title: 'Architecture', path: a.path, crew: null, stage: null, time: null, pending: false, preview: { kind: 'text', text: a.markdown } })
  }
  if (design?.planMd != null) {
    out.push({ id: 'plan', type: 'plan', title: 'Plan', path: 'plan.md', crew: null, stage: null, time: null, pending: false, preview: { kind: 'text', text: design.planMd } })
  }
  for (const c of state.run?.crews ?? []) {
    if (c.status !== 'merged') continue
    out.push({
      id: `code-${c.slug}`,
      type: 'code',
      title: c.stage == null ? 'Merged code' : `Merged code, stage ${c.stage}`,
      path: c.owns[0] ?? `truss-${c.slug}`,
      crew: c.slug,
      stage: c.stage,
      time: c.latest?.ts ?? null,
      pending: false,
      preview: { kind: 'code', branch: `truss-${c.slug}`, owns: c.owns },
    })
  }
  const shotsPerStage = new Map<string, number>()
  for (const img of design?.images ?? []) {
    const crew = crewOfRef(state, img.ref)
    const pending = crew?.status !== 'merged'
    const stage = crew?.stage ?? null
    const k = String(stage)
    const n = (shotsPerStage.get(k) ?? 0) + 1
    shotsPerStage.set(k, n)
    out.push({
      id: `image-${img.ref}-${img.path}`,
      type: 'images',
      // An openable image is titled by place, not by file name, so its button never repeats a crew slug.
      title: pending ? basename(img.path) : stage == null ? `Screenshot ${n}` : `Screenshot ${n}, stage ${stage}`,
      path: img.path,
      crew: crew?.slug ?? img.ref.replace(/^truss-/, ''),
      stage,
      time: null,
      pending,
      preview: { kind: 'image', ref: img.ref, path: img.path },
    })
  }
  return out
}

type Group = { key: string; label: string; items: Deliverable[] }

function grouped(items: Deliverable[], by: GroupBy): Group[] {
  if (by === 'type') {
    return TYPE_ORDER.map((t) => ({ key: t, label: TYPE_LABEL[t], items: items.filter((i) => i.type === t) })).filter((g) => g.items.length > 0)
  }
  const stages = [...new Set(items.map((i) => i.stage).filter((s): s is number => s != null))].sort((a, b) => a - b)
  const out: Group[] = []
  const inputs = items.filter((i) => i.stage == null)
  if (inputs.length) out.push({ key: 'inputs', label: 'Run inputs', items: inputs })
  for (const s of stages) out.push({ key: `stage-${s}`, label: `Stage ${s}`, items: items.filter((i) => i.stage === s) })
  return out
}

function Preview({ item, onOpenDesign }: { item: Deliverable; onOpenDesign?: () => void }) {
  const { copied, copy } = useCopy(item.path)
  const p = item.preview
  return (
    <>
      {p.kind !== 'text' && (
      <div className="grid h-56 place-items-center overflow-hidden rounded-t-card border-b border-border bg-bg">
        {p.kind === 'image' ? (
          <img src={imageUrl({ ref: p.ref, path: p.path })} alt={`${p.path} (built on ${p.ref})`} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="flex flex-col items-center gap-2 p-4 text-center">
            <Box aria-hidden="true" className="size-8 text-brand-strong" />
            <p className="font-mono text-ui break-all text-fg">{p.branch}</p>
            {p.owns.length > 0 && (
              <p className="flex flex-wrap justify-center gap-1">
                {p.owns.map((o) => (
                  <Badge key={o} size="sm">
                    <span className="font-mono">{o}</span>
                  </Badge>
                ))}
              </p>
            )}
          </div>
        )}
      </div>
      )}
      <div className="p-4">
        <Badge tone="brand" size="sm">
          {TYPE_LABEL[item.type]}
        </Badge>
        <h3 className="mt-2 text-lead font-semibold break-words text-fg">{item.title}</h3>
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-meta">
          <dt className="text-muted">Path</dt>
          <dd className="font-mono break-all text-fg">{item.path}</dd>
          {item.crew && (
            <>
              <dt className="text-muted">From</dt>
              <dd className="truncate font-mono text-fg" title={item.crew}>
                {item.crew}
              </dd>
            </>
          )}
          {item.time && (
            <>
              <dt className="text-muted">When</dt>
              <dd className="font-mono tabular-nums text-fg">{hhmm(item.time)}</dd>
            </>
          )}
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" icon={<Copy aria-hidden="true" />} onClick={copy}>
            Copy path
          </Button>
          {onOpenDesign && (
            <Button variant="secondary" size="sm" icon={<ExternalLink aria-hidden="true" />} onClick={onOpenDesign}>
              Open in Design tab
            </Button>
          )}
        </div>
        <p role="status" className="mt-2 min-h-4 text-meta text-muted">
          {copied}
        </p>
        {p.kind === 'text' && (
          <div
            role="region"
            tabIndex={0}
            aria-label={item.type === 'plan' ? 'Plan document' : 'Architecture document'}
            className="mt-3 max-h-[70vh] overflow-y-auto rounded-card border border-border bg-bg p-4"
          >
            <Suspense fallback={<Skeleton className="h-40 w-full" />}>
              <Markdown text={p.text} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  )
}

const chip = (on: boolean) =>
  cn(
    'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-meta font-medium transition-colors duration-(--duration-quick) ease-out pointer-coarse:h-10',
    on ? 'bg-fg text-bg' : 'bg-secondary text-muted hover:text-fg',
  )

export function Deliverables({ state, onOpenDesign }: DeliverablesProps) {
  // The chips are toggles: a click on the pressed chip clears the choice (null), which shows every type.
  const [chosen, setChosen] = useState<Filter | null>('all')
  const filter: Filter = chosen ?? 'all'
  const toggle = (f: Filter) => setChosen((c) => (c === f ? null : f))
  const [by, setBy] = useState<GroupBy>('stage')
  const [selected, setSelected] = useState<string | null>(null)
  const [dialog, setDialog] = useState(false)
  const [more, setMore] = useState<Set<string>>(() => new Set())
  const [adrSel, setAdrSel] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const opener = useRef<HTMLElement | null>(null)
  const asideRef = useRef<HTMLElement | null>(null)
  const allChip = useRef<HTMLButtonElement | null>(null)

  const all = state ? deliverablesOf(state) : []
  const count = (f: Filter) => (f === 'all' ? all.length : all.filter((i) => i.type === f).length)
  const shown = filter === 'all' ? all : all.filter((i) => i.type === filter)
  const groups = grouped(shown, by)
  const openable = groups.flatMap((g) => g.items).filter((i) => !i.pending)
  const current = openable.find((i) => i.id === selected) ?? openable[0] ?? null

  const adrCurrent = (adrSel && state?.adrs?.find((a) => a.file === adrSel)) || null
  const preview = adrCurrent ? adrCurrent.title : current?.title
  const docSelected = !adrCurrent && current?.preview.kind === 'text'

  const narrow = () => typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches
  const open = (item: Deliverable, el: HTMLButtonElement) => {
    setSelected(item.id)
    setAdrSel(null)
    setNotice('')
    opener.current = el
    if (narrow()) setDialog(true)
  }
  const close = () => {
    setDialog(false)
    const el = opener.current
    if (el) requestAnimationFrame(() => el.focus())
  }
  const back = () => {
    setAdrSel(null)
    close()
  }

  // The timeline asked to read one ADR here (preview-target.ts). A target left over from before this mounted is ignored.
  const target = usePreviewTarget()
  const seen = useRef(target.seq)
  useEffect(() => {
    if (target.seq === seen.current || target.adr === null) return
    seen.current = target.seq
    const found = state?.adrs?.find((a) => a.file === target.adr)
    opener.current = target.opener
    if (!found) {
      setAdrSel(null)
      setSelected(null)
      setNotice('That ADR is no longer listed.')
      return
    }
    setNotice('')
    setChosen('all')
    setAdrSel(found.file)
    if (narrow()) {
      setDialog(true)
      return
    }
    requestAnimationFrame(() => {
      const aside = asideRef.current
      if (!aside) return
      const calm = window.matchMedia('(prefers-reduced-motion: no-preference)').matches
      aside.scrollIntoView({ block: 'nearest', behavior: calm ? 'smooth' : 'auto' })
      aside.querySelector<HTMLElement>('h3')?.focus()
    })
  }, [target, state])

  const design = onOpenDesign
    ? () => {
        if (dialog) setDialog(false)
        onOpenDesign()
      }
    : undefined
  const body = adrCurrent ? (
    <AdrPreview key={adrCurrent.file} adr={adrCurrent} onBack={back} />
  ) : current ? (
    <Preview key={current.id} item={current} onOpenDesign={design} />
  ) : null

  const showAll = () => {
    setChosen('all')
    requestAnimationFrame(() => allChip.current?.focus())
  }

  return (
    <section aria-labelledby="deliverables-h" className="min-w-0">
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-2.5 border-b border-border pb-3">
        <Box aria-hidden="true" className="size-5 shrink-0 text-muted" />
        <h2 id="deliverables-h" className="text-title font-semibold text-fg">
          Built artifacts and deliverables
        </h2>
        {all.length > 0 && (
          <span className="text-ui text-muted max-lg:hidden">
            {' '}
            {all.length - all.filter((i) => i.pending).length} ready
            {all.some((i) => i.pending) ? `, ${all.filter((i) => i.pending).length} to come` : ''}{' '}
          </span>
        )}
      </div>

      <p role="status" className={cn('text-meta text-muted', notice && 'mb-2')}>
        {notice}
      </p>

      {state === null ? (
        <Skeleton className="h-40 w-full" />
      ) : all.length === 0 && !adrCurrent ? (
        <p className="rounded-card border border-dashed border-border-strong p-4 text-ui text-muted">
          Nothing built yet. Deliverables appear as crews finish.
        </p>
      ) : (
        <>
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
            <div role="group" aria-label="Filter by type" className="no-scrollbar flex max-w-full min-w-0 gap-1.5 overflow-x-auto">
              {FILTERS.map((f) => (
                <button key={f} ref={f === 'all' ? allChip : undefined} type="button" aria-pressed={chosen === f} onClick={() => toggle(f)} className={chip(chosen === f)}>
                  {f === 'all' ? 'All' : TYPE_LABEL[f]}{' '}
                  <span className={cn('tabular-nums', chosen === f ? 'text-bg' : 'text-muted')}>{count(f)}</span>
                </button>
              ))}
            </div>
            <div role="group" aria-label="Group by" className="ml-auto inline-flex shrink-0 rounded-ctl bg-secondary p-0.5 text-meta font-medium">
              {(['stage', 'type'] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={by === g}
                  onClick={() => setBy(g)}
                  className={cn(
                    'h-6 rounded-chip px-2.5 transition-colors duration-(--duration-quick) ease-out pointer-coarse:h-10',
                    by === g ? 'bg-surface text-fg shadow-e1' : 'text-muted hover:text-fg',
                  )}
                >
                  {g === 'stage' ? 'By stage' : 'By type'}
                </button>
              ))}
            </div>
          </div>

          {shown.length === 0 && !adrCurrent ? (
            <div className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-border-strong p-4">
              <p className="text-ui text-muted">No deliverables of this type.</p>
              <Button size="sm" onClick={showAll}>
                Show all
              </Button>
            </div>
          ) : (
            <div
              className={cn(
                'grid min-w-0 gap-4',
                docSelected ? 'lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]' : 'lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]',
              )}
            >
              {shown.length > 0 && (
              <ul aria-label="Deliverables" className="min-w-0 self-start rounded-card border border-border bg-surface px-1.5 pb-1.5 shadow-e1">
                {groups.map((g) => {
                  const open_ = more.has(g.key)
                  const rows = open_ ? g.items : g.items.slice(0, PAGE)
                  const hidden = g.items.length - rows.length
                  return (
                    <li key={g.key} className="min-w-0">
                      <h3 className="flex items-center gap-2 px-2.5 pt-3 pb-1 text-meta font-semibold text-muted">
                        {g.label}
                        <span className="font-normal tabular-nums">{g.items.length}</span>
                      </h3>
                      <ul aria-label={g.label} className="min-w-0">
                        {rows.map((item) => (
                          <DeliverableItem key={item.id} item={item} selected={!adrCurrent && current?.id === item.id} onOpen={open} />
                        ))}
                      </ul>
                      {hidden > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="ml-1.5"
                          onClick={() => setMore((s) => new Set(s).add(g.key))}
                        >
                          Show {hidden} more
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
              )}
              {preview != null && (
                <aside
                  ref={asideRef}
                  aria-label={`Preview: ${preview}`}
                  className="min-w-0 self-start overflow-hidden rounded-card border border-border bg-surface shadow-e2 max-lg:hidden"
                >
                  {body}
                </aside>
              )}
            </div>
          )}
        </>
      )}

      {dialog && preview != null && <DeliverableDialog onClose={close}>{body}</DeliverableDialog>}
    </section>
  )
}
