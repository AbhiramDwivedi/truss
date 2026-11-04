// The ADRs region of the Decisions and ADRs tab: a status summary strip (segmented bar + legend), a status filter,
// and one card per ADR, newest number first. Every field past `status` is optional (old ADRs and old snapshots
// lack them) and the card simply leaves its chip out.
import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge, type BadgeTone } from '../../components/ui/badge.tsx'
import { cn } from '../../lib/utils.ts'
import type { Adr, AdrLink } from '../../store/types.ts'
import { cap } from '../rail/format.ts'

export type Kind = 'accepted' | 'proposed' | 'rejected' | 'superseded' | 'unstated'

export const KINDS: readonly Kind[] = ['accepted', 'proposed', 'rejected', 'superseded', 'unstated']
export const TONE: Record<Kind, BadgeTone> = { accepted: 'ok', proposed: 'signal', rejected: 'fail', superseded: 'neutral', unstated: 'neutral' }
// Bar segments and legend swatches use the same theme tokens the badges sit on.
const SWATCH: Record<Kind, string> = {
  accepted: 'bg-ok',
  proposed: 'bg-signal',
  rejected: 'bg-fail',
  superseded: 'bg-border-strong',
  unstated: 'bg-border',
}

export function kindOf(status: string | null): Kind {
  const s = (status ?? '').toLowerCase()
  if (s.startsWith('accepted')) return 'accepted'
  if (s.startsWith('proposed')) return 'proposed'
  if (s.startsWith('rejected')) return 'rejected'
  if (s.startsWith('superseded')) return 'superseded'
  return 'unstated'
}

/** `ADR-0021: Use SQLite` reads as `Use SQLite`; a title without the prefix is left alone. */
export function plainTitle(title: string): string {
  return title.replace(/^ADR-\d+\s*[:\-–—]\s*/i, '') || title
}

const pad = (n: number): string => String(n).padStart(4, '0')

/** Newest number first; ADRs without a number follow, by file name, newest first. */
export function sortAdrs(adrs: Adr[]): Adr[] {
  return [...adrs].sort((a, b) => {
    const x = a.number ?? -1
    const y = b.number ?? -1
    if (x !== y) return y - x
    return a.file < b.file ? 1 : a.file > b.file ? -1 : 0
  })
}

const LINK_WORD: Record<AdrLink['kind'], string> = { amends: 'amends', supersedes: 'supersedes', 'superseded-by': 'superseded by' }

function Chip({ children, title, mono }: { children: React.ReactNode; title?: string; mono?: boolean }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 max-w-full min-w-0 items-center rounded-chip bg-secondary px-1.5 text-micro text-muted',
        mono && 'font-mono tabular-nums',
      )}
    >
      <span className="truncate">{children}</span>
    </span>
  )
}

export function StatusStrip({ counts, total }: { counts: Record<Kind, number>; total: number }) {
  const shown = KINDS.filter((k) => counts[k] > 0)
  const summary = shown.map((k) => `${counts[k]} ${k}`).join(', ')
  return (
    <div className="mb-3 min-w-0">
      <div
        role="img"
        aria-label={`ADR status: ${summary}`}
        className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-secondary"
      >
        {shown.map((k) => (
          <span key={k} className={cn('h-full', SWATCH[k])} style={{ flexGrow: counts[k], flexBasis: 0 }} />
        ))}
      </div>
      <ul aria-label="ADR status counts" className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {KINDS.map((k) => (
          <li key={k} className={cn('flex items-center gap-1.5 text-meta', counts[k] === 0 ? 'text-muted/70' : 'text-fg')}>
            <span aria-hidden="true" className={cn('size-2.5 rounded-sm', SWATCH[k])} />
            <span className="tabular-nums font-semibold">{counts[k]}</span>{' '}
            <span className="text-muted">{k}</span>
          </li>
        ))}
        <li className="sr-only">{total} in all</li>
      </ul>
    </div>
  )
}

function AdrCard({ a }: { a: Adr }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const kind = kindOf(a.status)
  const title = plainTitle(a.title)
  const links = a.links ?? []
  return (
    <li className="min-w-0 rounded-ctl border border-border bg-bg/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-more`}
        className="flex w-full min-w-0 items-start gap-2.5 rounded-ctl px-3 py-2 text-left hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0 text-muted transition-transform', open && 'rotate-90')} />
        {a.number != null && (
          <span className="mt-px shrink-0 rounded-chip bg-brand-soft px-1.5 font-mono text-micro leading-5 font-semibold tabular-nums text-brand-strong">
            {pad(a.number)}
          </span>
        )}
        <span className="min-w-0 flex-1 text-ui font-semibold break-words text-fg">{title}</span>
        <Badge tone={TONE[kind]} size="sm">
          {a.status ? cap(a.status.split(/[,.:(]/)[0]!.trim() || a.status) : 'Status not stated'}
        </Badge>
      </button>
      <div className="min-w-0 space-y-1.5 px-3 pb-2.5 pl-[2.375rem]">
        {(a.date || a.decidedBy || links.length > 0) && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {a.date && <span className="font-mono text-micro tabular-nums text-muted">{a.date}</span>}
            {a.decidedBy && <Chip title={a.decidedBy}>{`decided by ${a.decidedBy}`}</Chip>}
            {links.map((l) => (
              <Chip key={`${l.kind}-${l.n}`} mono>{`${LINK_WORD[l.kind]} ${pad(l.n)}`}</Chip>
            ))}
          </div>
        )}
        {a.summary && <p className={cn('text-meta text-muted', !open && 'line-clamp-2')}>{a.summary}</p>}
        <div id={`${id}-more`} hidden={!open} className="min-w-0 space-y-1 text-micro text-muted">
          {a.status && <p className="break-words">Status: {a.status}</p>}
          {a.decidedBy && <p className="break-words">Decided by: {a.decidedBy}</p>}
          <p className="truncate font-mono" title={a.file}>
            {a.file}
          </p>
        </div>
      </div>
    </li>
  )
}

export function AdrSection({ adrs }: { adrs: Adr[] }) {
  const [filter, setFilter] = useState<Kind | null>(null)
  const counts = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>
  for (const a of adrs) counts[kindOf(a.status)]++
  // A live update can empty the chosen status; then the filter falls back to All rather than showing nothing.
  const active = filter !== null && counts[filter] > 0 ? filter : null
  const shown = sortAdrs(adrs).filter((a) => active === null || kindOf(a.status) === active)
  return (
    <>
      <StatusStrip counts={counts} total={adrs.length} />
      <div role="group" aria-label="Filter ADRs by status" className="mb-3 flex flex-wrap gap-1.5">
        {([null, ...KINDS.filter((k) => counts[k] > 0)] as (Kind | null)[]).map((k) => {
          const on = active === k
          return (
            <button
              key={k ?? 'all'}
              type="button"
              aria-pressed={on}
              onClick={() => setFilter(k)}
              className={cn(
                'inline-flex h-7 shrink-0 items-center rounded-full px-2.5 text-meta font-medium transition-colors duration-(--duration-quick) ease-out pointer-coarse:h-10',
                on ? 'bg-fg text-bg' : 'bg-secondary text-muted hover:text-fg',
              )}
            >
              {k === null ? 'All' : cap(k)}
            </button>
          )
        })}
      </div>
      <ul aria-label="ADRs" className="space-y-2">
        {shown.map((a) => (
          <AdrCard key={a.file} a={a} />
        ))}
      </ul>
    </>
  )
}
