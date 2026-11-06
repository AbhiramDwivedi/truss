// One crew on the build network (ADR-0028 sections 6 and 7; R-40, R-42, R-44): a wire from the PM, a header
// with the slug, the one status word and the latest hand-off, an optional notice (waiting, stuck or partial),
// and the agent cards. Always open: the agents show without a click. Cards past the sixth fold behind a button.
import * as React from 'react'
import { Hand, TriangleAlert } from 'lucide-react'
import type { Crew, FlowEntry, Member } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { Badge } from '../../components/ui/badge.tsx'
import { StatusBadge } from '../status/StatusBadge.tsx'
import { agentStatus, crewStatus } from '../status/status.ts'
import { AgentCard } from './AgentCard.tsx'
import { StuckCard } from './StuckCard.tsx'
import { GutterLink, LIT_MS, Wire } from './Wire.tsx'
import { FAILED_STATES, blockedWords, detailMinutes, hhmm, isCheckRun, orderAgents, plural, roleWord, stepOf, taskLine } from './format.ts'

export interface CrewCardProps {
  crew: Crew
  now: number
  /** The latest hand-off from the PM to this crew, whatever its age. */
  handoff?: FlowEntry | null
  /** Trunk paint for the gutter segment that joins this card's grid line to the next. */
  trunkAnimated?: boolean
  trunkLit?: boolean
  /** Draw the gutter link only in the last stage; other stages have a full-height trunk. */
  gutterLink?: boolean
  /** The check-runs row starts open (a test seam; the row is closed on first sight). */
  checkRunsOpen?: boolean
}

/** Agent cards shown before "Show n more agents". */
export const FOLD = 6

const ASKS: Record<string, string> = {
  QUESTION: 'The foreman asked a question.',
  BLOCKED: 'The foreman is blocked.',
  PROPOSAL: 'The foreman proposed a change.',
}

/** True while the hand-off is within the lit window of `now`, read on every render. */
export function isRecent(handoff: FlowEntry | null | undefined, now: number): boolean {
  if (!handoff) return false
  const t = Date.parse(handoff.at)
  return !Number.isNaN(t) && now - t <= LIT_MS && now - t >= -2_000
}

/** The agent's task line: a stall says so, otherwise the shared task rule. */
function lineOf(m: Member, crew: Crew): string | null {
  const done = crew.status === 'merged' || crew.status === 'dropped'
  if (!done && m.state === 'stalled') {
    const min = detailMinutes(m.detail) ?? crew.stuck?.minutes ?? null
    return min !== null ? `Stalled ${min} min` : 'Stalled'
  }
  if (!done && m.state === 'allowance-spent') return 'Allowance spent'
  // A stalled member's detail is its stall minutes: in a done crew that is stall text, not a task.
  return taskLine(done && FAILED_STATES.has(m.state) ? { ...m, detail: null } : m, crew)
}

function Notice({ tone, icon, children }: { tone: 'signal' | 'fail'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn('mt-3 flex min-w-0 items-start gap-2 rounded-ctl p-3 text-meta', tone === 'signal' ? 'bg-signal-soft text-signal-text' : 'bg-fail-soft text-fail-text')}>
      <span aria-hidden="true" className="mt-px shrink-0">
        {icon}
      </span>
      <p className="min-w-0 break-words">{children}</p>
    </div>
  )
}

export function CrewCard({ crew, now, handoff = null, trunkAnimated = false, trunkLit = false, gutterLink = true, checkRunsOpen = false }: CrewCardProps) {
  const slugId = React.useId()
  const listId = `${slugId}-agents`
  const [expanded, setExpanded] = React.useState(false)
  const status = crewStatus(crew)
  const stuck = status === 'stuck' ? (crew.stuck ?? null) : null
  const planned = status === 'planned'

  const agents: Member[] = []
  if (crew.foreman) agents.push(crew.foreman)
  for (const m of crew.members) if (!crew.foreman || m.name !== crew.foreman.name) agents.push(m)
  // Foreman, then the named truss roles, then the rest; the runner and general-purpose check runs fold into one row.
  const checkRuns = agents.filter(isCheckRun)
  const named = orderAgents(agents.filter((m) => !isCheckRun(m)), crew.foreman)
  const [runsOpen, setRunsOpen] = React.useState(checkRunsOpen)
  const runsId = `${slugId}-runs`
  const shown = expanded ? named : named.slice(0, FOLD)
  const hidden = named.length - FOLD

  const ask = status === 'waiting' ? /^\s*(QUESTION|BLOCKED|PROPOSAL)\b/.exec(crew.foreman?.detail ?? '')?.[1] : undefined
  const partial = (crew.eventsUnread ?? 0) > 0
  const fromPm = handoff ? `From PM ${hhmm(handoff.at)}: ${handoff.summary}` : null
  const stage = crew.stage
  const qc = `QC ${crew.qc?.verdict ?? 'none'}`
  const blocked = crew.status === 'running' && crew.qc?.verdict === 'FAIL' ? blockedWords(crew) : null

  return (
    <li id={`crew-${crew.slug}`} className="relative min-w-0 list-none pt-6">
      {gutterLink && <GutterLink animated={trunkAnimated} lit={trunkLit} />}
      <Wire crew={crew.slug} status={status} recent={isRecent(handoff, now)} />
      <article
        aria-labelledby={slugId}
        className={cn(
          'relative z-10 min-w-0 rounded-card border p-4',
          planned ? 'border-dashed border-border-strong bg-sunken' : 'border-border bg-surface shadow-e1',
          stuck && 'border-fail/60',
        )}
      >
        <header className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-start gap-2">
            <h3 id={slugId} tabIndex={0} title={crew.slug} className="min-w-0 flex-1 truncate font-mono text-body font-semibold text-fg">
              {crew.slug}
            </h3>{' '}
            <StatusBadge status={status} size="sm" />
          </div>{' '}
          <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-micro text-muted">
            <span className="tabular-nums">{stage === null ? 'No stage' : `Stage ${stage}`}</span>{' '}
            <span className="tabular-nums">{plural(agents.length, 'agent')}</span>{' '}
            <span>{qc}</span>{' '}
            {blocked && <span className="font-medium text-fail-text">{blocked}</span>}{' '}
            {crew.status === 'dropped' && <Badge size="sm">Dropped</Badge>}
          </p>{' '}
          {fromPm && (
            <p title={fromPm} className="truncate text-meta text-muted">
              {fromPm}
            </p>
          )}
        </header>{' '}

        {ask && (
          <Notice tone="signal" icon={<Hand className="size-4" />}>
            {ASKS[ask]} You'll answer it in Your move.
          </Notice>
        )}{' '}
        {partial && (
          <Notice tone="fail" icon={<TriangleAlert className="size-4" />}>
            Couldn't read this crew's events. Showing the last known agents.
          </Notice>
        )}{' '}
        {stuck && <StuckCard crew={crew} stuck={stuck} now={now} />}{' '}

        {agents.length === 0 ? (
          <div className="mt-3 flex min-w-0 flex-col gap-1 text-meta text-muted">
            {planned && <p>{stage !== null && stage > 0 ? `Starts after stage ${stage - 1}.` : 'Not started yet.'}</p>}
            <p>No agents yet.</p>
          </div>
        ) : (
          <>
            <ul id={listId} aria-label={`${crew.slug} agents`} className="mt-3 flex min-w-0 flex-col gap-2">
              {shown.map((m) => (
                <AgentCard key={m.name} member={m} role={roleWord(m)} task={lineOf(m, crew)} activity={m.activity ?? null} status={agentStatus(m, crew)} step={stepOf(m, crew)} />
              ))}
            </ul>
            {checkRuns.length > 0 && (
              <div className="mt-2 min-w-0">
                <button
                  type="button"
                  aria-expanded={runsOpen}
                  aria-controls={runsId}
                  onClick={() => setRunsOpen((v) => !v)}
                  className="inline-flex min-h-6 items-center rounded-ctl px-2 text-meta font-medium text-fg underline underline-offset-2 hover:bg-sunken pointer-coarse:min-h-11"
                >
                  {plural(checkRuns.length, 'check run')}
                </button>
                <ul id={runsId} aria-label={`${crew.slug} check runs`} hidden={!runsOpen} className="mt-2 flex min-w-0 flex-col gap-2">
                  {runsOpen &&
                    checkRuns.map((m) => (
                      <AgentCard key={m.name} member={m} role={roleWord(m)} task={lineOf(m, crew)} activity={m.activity ?? null} status={agentStatus(m, crew)} step={stepOf(m, crew)} />
                    ))}
                </ul>
              </div>
            )}
            {hidden > 0 && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setExpanded((v) => !v)}
                className="mt-2 inline-flex min-h-6 items-center rounded-ctl px-2 text-meta font-medium text-fg underline underline-offset-2 hover:bg-sunken pointer-coarse:min-h-11"
              >
                {expanded ? 'Show fewer agents' : `Show ${plural(hidden, 'more agent')}`}
              </button>
            )}
          </>
        )}
      </article>
    </li>
  )
}
