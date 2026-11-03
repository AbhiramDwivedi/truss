// The rail's "ADR timeline" (D2 :490-514): what happened, newest first. Stuck crews (stuck.since), open
// requests (createdAt), goal follow-ups (intent goal), merged crews (latest.ts), then the ADRs, which carry
// no time. `Open log` hands over to the Decisions and ADRs tab through onOpenLog.
import { FileText } from 'lucide-react'
import type { RunState } from '../../store/types.ts'
import { cap, hhmm, stamp } from './format.ts'
import { TimelineItem, type TimelineItemProps } from './TimelineItem.tsx'

export interface TimelineProps {
  state: RunState | null
  now: number
  onOpenLog?: () => void
}

type Entry = TimelineItemProps & { key: string; at: number | null }

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
          : 'Reply needed'
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
  for (const a of state.adrs ?? []) {
    out.push({
      key: `adr-${a.file}`,
      kind: 'adr',
      title: a.title,
      detail: a.status ? cap(a.status) : 'Status not stated',
      time: '',
      at: null,
    })
  }
  return out
}

export function Timeline({ state, onOpenLog }: TimelineProps) {
  const list = state ? entries(state) : []
  const adrs = state?.adrs.length ?? 0
  const decisions = state?.decisions.length ?? 0
  return (
    <section
      aria-label="ADR timeline"
      className="px-6 py-5 max-lg:mx-4 max-lg:rounded-card max-lg:border max-lg:border-border max-lg:bg-surface max-lg:px-4"
    >
      <div className="mb-4 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <FileText aria-hidden="true" className="size-4 shrink-0 text-brand" />
        <h2 className="text-body font-semibold text-fg">ADR timeline</h2>
        <span className="text-meta text-muted">
          {adrs === 1 ? '1 ADR' : `${adrs} ADRs`}, {decisions === 1 ? '1 decision' : `${decisions} decisions`}
        </span>
        <button
          type="button"
          onClick={() => onOpenLog?.()}
          className="ml-auto inline-flex min-h-6 items-center rounded-chip text-meta font-medium text-brand-strong hover:underline pointer-coarse:min-h-10"
        >
          Open log
        </button>
      </div>
      {list.length === 0 ? (
        <p className="text-ui text-muted">Nothing has happened yet.</p>
      ) : (
        <ol className="relative before:absolute before:top-2 before:bottom-2 before:left-2.5 before:w-px before:bg-border">
          {list.map(({ key, at: _at, ...item }) => (
            <TimelineItem key={key} {...item} />
          ))}
        </ol>
      )}
    </section>
  )
}
