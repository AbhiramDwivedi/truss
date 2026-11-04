// The rail's "Decisions and ADRs" list (R-37, ADR-0028 section 3): what happened, newest first. Stuck crews
// (stuck.since), open requests (createdAt), goal follow-ups (intent goal), merged crews (latest.ts), then the
// ADRs, which carry no time. It is the one ADR list; an ADR item opens its fields in the deliverable preview
// through openAdr. `Open log` hands over to the Decisions tab through onOpenLog.
import { useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'
import type { RunState } from '../../store/types.ts'
import { KINDS, StatusStrip, kindOf, sortAdrs, type Kind } from '../decisions/AdrSection.tsx'
import { openAdr, usePreviewTarget } from '../deliverables/preview-target.ts'
import { cap, hhmm, stamp } from './format.ts'
import { TimelineItem, TimelineSkeleton, type TimelineItemProps } from './TimelineItem.tsx'

const PAGE = 200

export interface TimelineProps {
  state: RunState | null
  now: number
  onOpenLog?: () => void
}

type Entry = TimelineItemProps & { key: string; at: number | null; file?: string }

/** The status word on an ADR item: its kind, or the recorded word when the kind is unstated. */
function adrWord(status: string | null): string {
  const k = kindOf(status)
  if (k !== 'unstated') return cap(k)
  return status ? cap(status.split(/[,.:(]/)[0]!.trim() || status) : 'Status not stated'
}

function entries(state: RunState): Entry[] {
  const out: Entry[] = []
  for (const c of state.run?.crews ?? []) {
    if (c.stuck) {
      out.push({
        key: `stuck-${c.slug}`,
        kind: 'stuck',
        title: c.slug,
        detail: c.stuck.detail,
        // Worded apart from the crew card's band, which is the one "Stuck, silent <n>m" on the page.
        tag: `Stuck ${c.stuck.minutes} min`,
        time: hhmm(c.stuck.since),
        at: stamp(c.stuck.since),
      })
    }
  }
  for (const r of state.requests ?? []) {
    if (r.status !== 'open') continue
    const title =
      r.kind === 'question'
        ? `Question from Claude: ${r.questions[0]?.header ?? ''}`.trim()
        : r.kind === 'permission'
          ? `Permission request: ${r.toolName}`
          : r.approvalAsk === true
            ? 'Approval needed'
            : 'The PM replied'
    out.push({ key: `req-${r.id}`, kind: 'ask', title, tag: 'Waiting on you', time: hhmm(r.createdAt), at: stamp(r.createdAt) })
  }
  const queued = new Set((state.session.queue ?? []).map((q) => q.id))
  for (const t of state.transcript ?? []) {
    if (t.role !== 'user' || t.intent !== 'goal') continue
    if (t.id && queued.has(t.id)) continue
    out.push({ key: `goal-${t.n}`, kind: 'goal', title: 'New goal', detail: t.text, time: hhmm(t.ts), at: stamp(t.ts) })
  }
  for (const q of state.session.queue ?? []) {
    if (q.intent !== 'goal') continue
    out.push({ key: `queue-${q.id}`, kind: 'goal', title: 'New goal', detail: q.text, tag: 'Queued', time: hhmm(q.at), at: stamp(q.at) })
  }
  for (const c of state.run?.crews ?? []) {
    if (c.status !== 'merged') continue
    const ts = c.latest?.ts ?? null
    out.push({
      key: `merge-${c.slug}`,
      kind: 'merge',
      title: c.slug,
      detail: c.stage == null ? 'Merged' : `Merged, stage ${c.stage}`,
      time: hhmm(ts),
      at: stamp(ts),
    })
  }
  // Newest first; entries with no time keep their order after the timed ones.
  out.sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity))
  for (const a of sortAdrs(state.adrs ?? [])) {
    out.push({
      key: `adr-${a.file}`,
      kind: 'adr',
      title: a.title,
      detail: adrWord(a.status),
      date: a.date,
      time: '',
      at: null,
      file: a.file,
    })
  }
  return out
}

export function Timeline({ state, onOpenLog }: TimelineProps) {
  const [filter, setFilter] = useState<Kind | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const allRef = useRef<HTMLButtonElement>(null)
  const target = usePreviewTarget()
  const list = state ? entries(state) : []
  const adrs = state?.adrs ?? []
  const decisions = state?.decisions.length ?? 0
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>
  for (const a of adrs) counts[kindOf(a.status)]++
  // The filter narrows ADR items; events hide while a status is chosen.
  const shownAll =
    filter === null ? list : list.filter((e) => e.kind === 'adr' && kindOf(adrs.find((a) => a.file === e.file)?.status ?? null) === filter)
  // The cap counts ADR items; the few event items (stuck, ask, goal, merge) always show.
  const adrItems = shownAll.filter((e) => e.kind === 'adr')
  const hidden = new Set(adrItems.slice(limit).map((e) => e.key))
  const shown = shownAll.filter((e) => !hidden.has(e.key))
  const more = hidden.size
  const empty = state !== null && list.length === 0
  return (
    <section
      aria-labelledby="timeline-h"
      className="px-6 py-5 max-lg:mx-4 max-lg:rounded-card max-lg:border max-lg:border-border max-lg:bg-surface max-lg:px-4"
    >
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <FileText aria-hidden="true" className="size-4 shrink-0 text-brand" />
        <h2 id="timeline-h" className="text-body font-semibold text-fg">
          Decisions and ADRs
        </h2>
        {state && (
          <span className="text-meta text-muted">
            {adrs.length === 1 ? '1 ADR' : `${adrs.length} ADRs`}, {decisions === 1 ? '1 decision' : `${decisions} decisions`}
          </span>
        )}
        {state && !empty && onOpenLog && (
          <button
            type="button"
            onClick={() => onOpenLog()}
            className="ml-auto inline-flex min-h-6 items-center rounded-chip text-meta font-medium text-brand-strong hover:underline pointer-coarse:min-h-10"
          >
            Open log
          </button>
        )}
      </div>
      {state === null ? (
        <ol aria-hidden="true" className="relative before:absolute before:top-2 before:bottom-2 before:left-2.5 before:w-px before:bg-border">
          <TimelineSkeleton />
          <TimelineSkeleton />
          <TimelineSkeleton />
        </ol>
      ) : empty ? (
        <p className="text-ui text-muted">No ADRs or decisions yet. They appear here as the design engineer records them.</p>
      ) : (
        <>
          <StatusStrip counts={counts} total={adrs.length} />
          <div role="group" aria-label="Filter by status" className="no-scrollbar mb-3 flex gap-1.5 overflow-x-auto">
            {([null, ...KINDS] as (Kind | null)[]).map((k) => {
              const on = filter === k
              return (
                <button
                  key={k ?? 'all'}
                  ref={k === null ? allRef : undefined}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    setFilter(k)
                    setLimit(PAGE)
                  }}
                  className={cn(
                    'inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-meta font-medium transition-colors duration-(--duration-quick) ease-out pointer-coarse:h-10',
                    on ? 'bg-fg text-bg' : 'bg-secondary text-muted hover:text-fg',
                  )}
                >
                  {k === null ? 'All' : cap(k)} <span className="tabular-nums">{k === null ? adrs.length : counts[k]}</span>
                </button>
              )
            })}
          </div>
          {shownAll.length === 0 ? (
            <div className="rounded-card border border-dashed border-border-strong px-4 py-6 text-center">
              <p className="text-ui text-muted">No items match this filter.</p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setFilter(null)
                  allRef.current?.focus()
                }}
              >
                Show all
              </Button>
            </div>
          ) : (
            <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-2.5 before:w-px before:bg-border">
              {shown.map(({ key, at: _at, file, ...item }) => (
                <TimelineItem
                  key={key}
                  {...item}
                  selected={file !== undefined && target.adr === file}
                  onOpen={file !== undefined ? (el) => openAdr(file, el) : undefined}
                />
              ))}
            </ol>
          )}
          {more > 0 && (
            <Button variant="ghost" size="sm" className="mt-1" onClick={() => setLimit((l) => l + PAGE)}>
              Show {Math.min(PAGE, more)} more
            </Button>
          )}
        </>
      )}
    </section>
  )
}
