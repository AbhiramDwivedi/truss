// One crew on the build network (D2 direction-d2.html:640-760; ADR-0018 section 10; ADR-0023 section 4).
// The header is the toggle: its accessible name carries slug, stage, status, verdict, QC, agents planned,
// latest activity and any stuck or blocked reason. A stuck crew starts open, with the fail band and the
// stuck card; a planned crew is a dashed card that says when it starts.
import * as React from 'react'
import { Box, ChevronDown, Clock, Layers, PenTool, TriangleAlert } from 'lucide-react'
import type { Crew, Member } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { Badge, ModelBadge } from '../../components/ui/badge.tsx'
import { SegmentBar, type Segment } from '../metrics/SegmentBar.tsx'
import { StuckCard } from './StuckCard.tsx'
import { DONE_STATES, FAILED_STATES, LIVE_STATES, crewEnd, crewName, crewStart, detailMinutes, flaggedAt, hhmmAt, short } from './format.ts'

export interface CrewCardProps {
  crew: Crew
  now: number
}

const modelKey = (m: string | null): string => (m && /opus/i.test(m) ? 'opus' : m && /sonnet/i.test(m) ? 'sonnet' : (m ?? 'model unknown'))

function Identity({ crew, planned }: { crew: Crew; planned: boolean }) {
  const Icon = crew.verdict === 'design' ? PenTool : crew.verdict === 'change' ? Box : Layers
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-9 shrink-0 place-items-center rounded-ctl', planned ? 'bg-sunken text-muted' : 'bg-brand-soft text-brand-strong')}
    >
      <Icon className="size-4.5" />
    </span>
  )
}

function StatusBadge({ crew }: { crew: Crew }) {
  if (crew.status === 'merged') return <Badge tone="ok" size="sm">Merged</Badge>
  if (crew.status === 'running') return <Badge tone={crew.stuck ? 'fail' : 'brand'} size="sm">{crew.stuck ? 'Stuck' : 'Running'}</Badge>
  if (crew.status === 'planned') return <Badge size="sm">Planned</Badge>
  if (crew.status === 'dropped') return <Badge size="sm">Dropped</Badge>
  return <Badge size="sm">Status unknown</Badge>
}

function MemberRow({ m, crew }: { m: Member; crew: Crew }) {
  const stalled = m.state === 'stalled'
  const silent = stalled ? (detailMinutes(m.detail) ?? crew.stuck?.minutes ?? null) : null
  return (
    <li className={cn('relative min-w-0 overflow-hidden rounded-ctl px-2.5 py-2', stalled ? 'bg-fail-soft' : 'bg-sunken')}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate font-mono text-meta font-medium text-fg" title={m.name}>
          {m.name}
        </span>
        {m.type && <span className="text-micro text-muted">{m.type}</span>}
        <ModelBadge model={modelKey(m.model)} title={m.model ?? undefined}>
          {m.model ?? 'model unknown'}
        </ModelBadge>
        {m.effort && <span className="text-micro text-muted">{m.effort}</span>}
        <span className={cn('ml-auto text-micro font-medium', stalled || FAILED_STATES.has(m.state) ? 'text-fail-text' : 'text-muted')}>
          {stalled ? (silent !== null ? `Silent ${silent}m` : 'Silent') : m.state}
        </span>
      </div>
      {stalled && <span className="sr-only">{m.state}</span>}
      {LIVE_STATES.has(m.state) && (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
          <span className="block h-full w-1/3 bg-brand motion-safe:animate-scan" />
        </span>
      )}
    </li>
  )
}

export function CrewCard({ crew, now }: CrewCardProps) {
  const [chosen, setChosen] = React.useState<boolean | null>(null)
  const open = chosen ?? !!crew.stuck
  const planned = crew.status === 'planned'
  const stuck = crew.stuck ?? null
  const flag = stuck ? flaggedAt(stuck) : null
  const listId = `crew-${crew.slug}-members`

  const est = crew.estAgents ?? null
  const segments: Segment[] = crew.members.map((m) => ({
    tone: DONE_STATES.has(m.state) ? 'ok' : FAILED_STATES.has(m.state) ? 'fail' : 'brand',
    live: LIVE_STATES.has(m.state),
    title: m.name,
  }))
  const target = Math.max(est ?? 0, crew.members.length)
  if (crew.status === 'merged' && segments.length === 0) for (let i = 0; i < target; i++) segments.push({ tone: 'ok' })
  while (segments.length < target) segments.push({ tone: 'border' })

  const start = crewStart(crew)
  const end = crew.status === 'merged' ? crewEnd(crew) : null
  const elapsed = start === null ? null : crew.status === 'merged' ? (end !== null ? `took ${short(end - start)}` : null) : planned ? null : short(now - start)

  return (
    <li id={`crew-${crew.slug}`} className="min-w-0 scroll-mt-28 list-none">
      <div
        className={cn(
          'min-w-0 overflow-hidden rounded-card border bg-surface',
          planned ? 'border-dashed border-border-strong' : 'border-border shadow-e1',
          stuck && 'border-fail/60 motion-safe:animate-stuck-glow',
        )}
      >
        {stuck && (
          <div className="flex min-w-0 items-center gap-2 bg-fail px-3 py-1.5 text-meta font-semibold text-surface">
            <span role="img" aria-label="Alert" className="inline-flex">
              <TriangleAlert aria-hidden="true" className="size-4" />
            </span>
            <span>Stuck, silent {stuck.minutes}m</span>
            {flag !== null && <span className="ml-auto text-micro font-medium">flagged {hhmmAt(flag)}</span>}
          </div>
        )}
        <div className="p-3">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-label={crewName(crew)}
            onClick={() => setChosen(!open)}
            className="flex w-full min-w-0 flex-col gap-2 rounded-ctl text-left"
          >
            <span className="flex w-full min-w-0 items-center gap-2.5">
              <Identity crew={crew} planned={planned} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-ui font-semibold text-fg">{crew.slug}</span>
                <span className="flex min-w-0 items-center gap-1.5 text-micro text-muted">
                  {crew.owns[0] && <span className="min-w-0 truncate font-mono">{crew.owns[0]}</span>}
                  {crew.verdict && <Badge size="sm">{crew.verdict}</Badge>}
                </span>
              </span>
              <ChevronDown aria-hidden="true" className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
            </span>
            <SegmentBar segments={segments} className="w-full" />
            <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted">
              {est !== null && <span>{est} agents planned</span>}
              {elapsed !== null && (
                <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                  <Clock aria-hidden="true" className="size-3" />
                  {elapsed}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                <StatusBadge crew={crew} />
                {crew.qc?.verdict && (
                  <Badge size="sm" tone={crew.qc.verdict === 'PASS' ? 'ok' : 'fail'}>
                    QC {crew.qc.verdict}
                  </Badge>
                )}
              </span>
            </span>
          </button>

          {planned && (
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              {crew.owns.length > 0 && (
                <span className="flex min-w-0 flex-wrap gap-1">
                  {crew.owns.map((o) => (
                    <Badge key={o} size="sm" className="font-mono">
                      {o}
                    </Badge>
                  ))}
                </span>
              )}
              <p className="text-micro text-muted">
                {est !== null ? `About ${est} agents. ` : ''}
                {crew.stage !== null && crew.stage > 0 ? `Starts when stage ${crew.stage - 1} merges.` : 'Starts when the run begins.'}
              </p>
            </div>
          )}

          {open &&
            (crew.members.length > 0 ? (
              <ul id={listId} aria-label={`${crew.slug} members`} className="mt-3 flex min-w-0 flex-col gap-1.5">
                {crew.members.map((m) => (
                  <MemberRow key={m.name} m={m} crew={crew} />
                ))}
              </ul>
            ) : (
              <p id={listId} className="mt-3 text-micro text-muted">
                No agents yet.
              </p>
            ))}

          {stuck && <StuckCard crew={crew} stuck={stuck} now={now} />}
        </div>
      </div>
    </li>
  )
}
