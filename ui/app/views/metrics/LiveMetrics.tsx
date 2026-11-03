// The live counter (D2 direction-d2.html:520-600; ADR-0023 section 4): a header with the stuck,
// question and queue chips, then six tiles. Every figure comes from the state; the Tokens rate and
// sparkline come from the live stamps this client has seen, so one stamp gives no rate.
import * as React from 'react'
import { TriangleAlert } from 'lucide-react'
import type { Crew, Member, RunState } from '../../store/types.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { LivePing } from '../../components/ui/dot.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { MetricTile } from './MetricTile.tsx'
import { SegmentBar, type Segment } from './SegmentBar.tsx'
import { Sparkline } from './Sparkline.tsx'
import { DONE_STATES, FAILED_STATES, LIVE_STATES, ago, clock, dayTime, exact, hhmm, ms, plural, rate, tokens } from '../crews/format.ts'

/** A live stamp older than this reads as not updating (ADR-0023 section 4). */
const STALE_MS = 2 * 60_000
const SERIES_MAX = 24

interface Stamp {
  at: number
  total: number
  receivedAt: number
}

export interface LiveMetricsProps {
  state: RunState | null
  now: number
}

const agentsOf = (c: Crew): Member[] => (c.foreman ? [c.foreman, ...c.members] : c.members)

/** The stamps this client has seen, oldest first: a new one is added when live.at moves. */
function useStamps(at: string | undefined, total: number | undefined, now: number): Stamp[] {
  const first = (): Stamp[] => {
    const t = ms(at)
    return t === null || total === undefined ? [] : [{ at: t, total, receivedAt: now }]
  }
  const [series, setSeries] = React.useState<Stamp[]>(first)
  React.useEffect(() => {
    const t = ms(at)
    if (t === null || total === undefined) return
    setSeries((prev) => {
      const last = prev.at(-1)
      if (last && last.at === t && last.total === total) return prev
      return [...prev, { at: t, total, receivedAt: Date.now() }].slice(-SERIES_MAX)
    })
  }, [at, total])
  return series
}

/** Tokens a minute over the last two stamps, or null before the second one. */
function perMinute(series: Stamp[]): number | null {
  if (series.length < 2) return null
  const a = series.at(-2)!
  const b = series.at(-1)!
  let span = b.at - a.at
  if (span <= 0) span = b.receivedAt - a.receivedAt
  if (span <= 0) return null
  return Math.max(0, ((b.total - a.total) / span) * 60_000)
}

export function LiveMetrics({ state, now }: LiveMetricsProps) {
  const live = state?.session.usage?.live
  const series = useStamps(live?.at, live?.totalTokens, now)

  if (state === null) return <Skeleton className="h-43 w-full rounded-panel" />
  const run = state.run
  if (!run) return null

  const usage = state.session.usage
  const crews = run.crews

  // Header chips: each shows only above zero.
  const stuck = crews.filter((c) => c.stuck)
  const open = state.requests.filter((r) => r.status === 'open')
  const questions = open.filter((r) => r.kind === 'question').length
  const queued = state.session.queue?.length ?? 0
  const updatedAt = ms(live?.at) ?? ms(usage?.at)

  // Elapsed.
  const approvedAt = run.goals?.[0]?.approvedAt ?? run.approvedAt
  const approvedMs = ms(approvedAt)

  // Tokens.
  const liveAt = ms(live?.at)
  const stale = liveAt !== null && now - liveAt > STALE_MS
  const perMin = perMinute(series)

  // Agents.
  const agents = crews.flatMap(agentsOf)
  const running = agents.filter((m) => LIVE_STATES.has(m.state)).length
  const stalled = agents.filter((m) => FAILED_STATES.has(m.state)).length
  const done = agents.filter((m) => DONE_STATES.has(m.state)).length
  const planned = crews.reduce((n, c) => n + Math.max(0, (c.estAgents ?? 0) - agentsOf(c).length), 0)
  const agentBar: Segment[] = [
    ...agents.map((m): Segment => ({
      tone: DONE_STATES.has(m.state) ? 'ok' : FAILED_STATES.has(m.state) ? 'fail' : 'brand',
      live: LIVE_STATES.has(m.state),
      title: m.name,
    })),
    ...Array.from({ length: planned }, (): Segment => ({ tone: 'border' })),
  ]

  // Crews merged.
  const merged = crews.filter((c) => c.status === 'merged').length
  const crewBar: Segment[] = crews.map((c) => ({
    tone: c.status === 'merged' ? 'ok' : c.stuck ? 'fail' : c.status === 'running' ? 'brand' : 'border',
    live: c.status === 'running' && !c.stuck,
    title: c.slug,
  }))
  const runningCrews = crews.filter((c) => c.status === 'running').length

  // Tasks done: every report in, with no denominator.
  const tasks = agents.filter((m) => m.state === 'reported').length

  return (
    <section aria-label="Live metrics" className="min-w-0 rounded-panel border border-border bg-surface p-4 shadow-e1 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="inline-flex items-center gap-2 text-meta font-semibold text-fg">
          <LivePing tone="ok" />
          Live
        </span>
        {updatedAt !== null && <span className="text-micro text-muted">updated {ago(now - updatedAt)}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {stuck.length > 0 && (
            <Badge tone="fail" href={`#crew-${stuck[0]!.slug}`}>
              <TriangleAlert aria-hidden="true" className="mr-1 inline size-3.5 align-[-2px]" />
              {stuck.length === 1 ? '1 crew stuck' : `${stuck.length} crews stuck`}
            </Badge>
          )}
          {open.length > 0 && (
            <Badge tone="move" href="#your-move">
              {questions === open.length ? plural(questions, 'question') : `${open.length} waiting on you`}
            </Badge>
          )}
          {queued > 0 && (
            <Badge tone="brand" href="#composer">
              {queued} queued
            </Badge>
          )}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-2 lg:grid-cols-3 xl:grid-cols-6">
        <MetricTile
          label="Elapsed"
          value={approvedMs === null ? '0s' : clock(now - approvedMs)}
          sub={approvedMs === null ? 'Not approved yet' : `since you approved, ${dayTime(approvedAt)}`}
        />
        <MetricTile
          label="Tokens"
          value={live ? tokens(live.totalTokens) : '0'}
          title={live ? exact(live.totalTokens) : undefined}
          aside={perMin !== null && !stale ? `${rate(perMin)}/min` : undefined}
          graphic={<Sparkline series={series.map((s) => s.total)} />}
          sub={live ? (stale ? `as of ${hhmm(live.at)}, not updating` : `as of ${hhmm(live.at)}`) : 'No tokens yet'}
          subTone={stale ? 'signal' : 'muted'}
        />
        <MetricTile
          label="Spend"
          value={usage?.costUsd != null ? `$${usage.costUsd.toFixed(2)}` : '$0.00'}
          sub={usage?.costUsd != null ? `as of turn end ${hhmm(usage.at)}` : 'No cost yet'}
        />
        <MetricTile
          label="Agents"
          value={running}
          aside="running"
          graphic={<SegmentBar segments={agentBar} className="mt-2" />}
          sub={`${stalled} stalled, ${done} done, plus ${planned} planned`}
        />
        <MetricTile
          label="Crews merged"
          value={`${merged} / ${crews.length}`}
          graphic={<SegmentBar segments={crewBar} className="mt-2" />}
          sub={`${runningCrews} running`}
        />
        <MetricTile label="Tasks done" value={tasks} sub={plural(tasks, 'report') + ' in'} />
      </dl>
    </section>
  )
}
