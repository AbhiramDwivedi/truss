// One row of the ADR timeline (D2 :490-514): a kind marker on the rail line, a title, a time and a line of detail.
import { Check, FileText, MessageSquare, Plus, TriangleAlert } from 'lucide-react'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { cn } from '../../lib/utils.ts'

export type TimelineKind = 'stuck' | 'ask' | 'goal' | 'merge' | 'adr'

const marker: Record<TimelineKind, { icon: typeof Check; cls: string }> = {
  stuck: { icon: TriangleAlert, cls: 'bg-fail text-surface ring-4 ring-fail-soft' },
  ask: { icon: MessageSquare, cls: 'bg-signal text-fg ring-4 ring-signal-soft' },
  goal: { icon: Plus, cls: 'bg-brand-soft text-brand-strong ring-4 ring-surface outline outline-1 outline-brand-line' },
  merge: { icon: Check, cls: 'bg-ok text-surface ring-4 ring-surface' },
  adr: { icon: FileText, cls: 'bg-brand text-surface ring-4 ring-surface' },
}

const box: Record<TimelineKind, string> = {
  stuck: 'border-fail/35 bg-fail-soft',
  ask: 'border-signal/40 bg-signal-soft',
  goal: 'border-transparent',
  merge: 'border-transparent',
  adr: 'border-brand-line bg-surface shadow-e1',
}

const tagTone: Record<TimelineKind, string> = {
  stuck: 'text-fail-text',
  ask: 'text-signal-text',
  goal: 'text-muted',
  merge: 'text-muted',
  adr: 'text-muted',
}

export interface TimelineItemProps {
  kind: TimelineKind
  title: string
  /** HH:MM, or '' when the entry has no time. */
  time: string
  detail?: string
  /** A short word line under the detail, such as "Stuck" or "Waiting on you". */
  tag?: string
  /** Mono id shown before the title (an ADR number). */
  id?: string
  /** An ADR item only: the date line, and the handler that opens its preview. */
  date?: string | null
  onOpen?: (opener: HTMLElement) => void
  selected?: boolean
}

const ITEM = 'relative flex gap-3 pb-3 [content-visibility:auto] [contain-intrinsic-size:auto_3.5rem]'

function Marker({ kind }: { kind: TimelineKind }) {
  const M = marker[kind]
  return (
    <span className="relative z-10 mt-2.5 shrink-0">
      <span className={cn('grid size-5 place-items-center rounded-full', M.cls)}>
        <M.icon aria-hidden="true" className="size-3" />
      </span>
    </span>
  )
}

/** The loading row: a marker dot and a 56 px block. */
export function TimelineSkeleton() {
  return (
    <li className="relative flex gap-3 pb-3">
      <span className="relative z-10 mt-2.5 shrink-0">
        <span className="block size-5 rounded-full bg-secondary" />
      </span>
      <Skeleton className="h-14 flex-1 rounded-ctl" />
    </li>
  )
}

export function TimelineItem({ kind, title, time, detail, tag, id, date, onOpen, selected }: TimelineItemProps) {
  if (kind === 'adr') {
    return (
      <li className={ITEM}>
        <Marker kind={kind} />
        <button
          type="button"
          title={title}
          aria-current={selected ? 'true' : undefined}
          onClick={(e) => onOpen?.(e.currentTarget)}
          className={cn(
            'block min-w-0 flex-1 rounded-ctl border px-3 py-2.5 text-left hover:bg-secondary/60 focus-visible:outline-offset-[-2px]',
            box.adr,
            selected && 'border-brand ring-1 ring-brand',
          )}
        >
          <span className="line-clamp-2 text-ui font-semibold break-words text-fg">{title}</span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 text-micro text-muted">
            <span>{detail}</span>
            {date && <span className="font-mono text-micro tabular-nums">{date}</span>}
          </span>
        </button>
      </li>
    )
  }
  return (
    <li className={ITEM}>
      <Marker kind={kind} />
      <div className={cn('min-w-0 flex-1 rounded-ctl border px-3 py-2.5', box[kind])}>
        <div className="flex min-w-0 items-baseline gap-2">
          {id && <span className="shrink-0 font-mono text-micro font-semibold text-brand-strong">{id}</span>}
          <h3 className="min-w-0 flex-1 truncate text-ui font-semibold text-fg" title={title}>
            {title}
          </h3>
          {time && <span className="shrink-0 font-mono text-micro tabular-nums text-muted">{time}</span>}
        </div>
        {detail && <p className="mt-0.5 text-meta break-words text-muted">{detail}</p>}
        {tag && <p className={cn('mt-1.5 text-micro font-medium', tagTone[kind])}>{tag}</p>}
      </div>
    </li>
  )
}
