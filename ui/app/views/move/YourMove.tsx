// Your move (ADR-0023 section 4): what the run needs from the person right now. The oldest open request
// is the hero on the move surface, the rest queue under it, and settled cards keep their names below.
// With nothing open it is a quiet card: Start a run, or Nothing needs you right now.
import { useEffect, useRef, useState } from 'react'
import type { Request, RunState } from '../../store/types.ts'
import { postAnswer } from '../../store/api.ts'
import { Card } from '../../components/ui/card.tsx'
import { Skeleton } from '../../components/ui/skeleton.tsx'
import { Notice } from '../../components/ui/notice.tsx'
import { QuestionCard } from './QuestionCard.tsx'
import { ReplyCard } from './ReplyCard.tsx'
import { PermissionCard } from './PermissionCard.tsx'
import {
  GOAL_BOX_ID,
  SESSION_ENDED,
  cardName,
  hhmm,
  noteResult,
  notSent,
  openCards,
  plural,
  reasonOf,
  replyWaitsOnAgents,
  settledWords,
  usePageFlags,
  type AnswerBody,
} from './format.ts'

export interface YourMoveProps {
  state: RunState | null
  now: number
}

const MAX_SETTLED = 20

interface Local {
  /** What this page posted and the server took (200, or 409 answered). */
  sent?: AnswerBody
  /** The server said 409 cancelled. */
  cancelled?: boolean
  error?: string | null
}

function answerError(status: number, error: string | null): string {
  if (status === 404) return 'This request no longer exists on the server, so it could not be answered.'
  if (status === 400) return 'The server did not accept that answer. Check it and try again.'
  if (status === 0) return 'Could not reach the server; nothing was sent. Try again.'
  if (status === 409 && error === 'ended') return SESSION_ENDED
  return `The answer was not accepted (server answered ${status}). Try again.`
}

export function YourMove({ state, now }: YourMoveProps) {
  const flags = usePageFlags()
  const [local, setLocal] = useState<Record<string, Local>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const inFlight = useRef(new Set<string>())
  const region = useRef<HTMLElement>(null)
  const handOn = useRef(false)

  const isSettledHere = (r: Request) => r.status !== 'open' || local[r.id]?.sent !== undefined || local[r.id]?.cancelled === true
  const open = openCards(state).filter((r) => !isSettledHere(r))
  const openCount = open.length

  // The tab title counts what waits on the person.
  useEffect(() => {
    document.title = openCount > 0 ? `(${openCount}) Truss` : 'Truss'
  }, [openCount])

  // After an answer, focus goes to the next open card's first control, else the goal box.
  useEffect(() => {
    if (!handOn.current) return
    handOn.current = false
    const a = document.activeElement
    if (a && a !== document.body && region.current?.contains(a) === false) return
    const next = region.current?.querySelector<HTMLElement>(
      'article[data-open="true"] :is(button, input, textarea, [role="radio"]):not(:disabled):not([tabindex="-1"])',
    )
    if (next) next.focus()
    else document.getElementById(GOAL_BOX_ID)?.focus()
  })

  const answer = async (r: Request, body: AnswerBody) => {
    if (inFlight.current.has(r.id)) return
    inFlight.current.add(r.id)
    setBusyId(r.id)
    setLocal((m) => ({ ...m, [r.id]: { ...m[r.id], error: null } }))
    const res = await postAnswer(r.id, body)
    inFlight.current.delete(r.id)
    setBusyId((b) => (b === r.id ? null : b))
    noteResult(res.status, res.error)
    if (res.status === 200 || (res.status === 409 && res.error === 'answered')) {
      handOn.current = true
      setLocal((m) => ({ ...m, [r.id]: { sent: body, error: null } }))
      return
    }
    if (res.status === 409 && res.error === 'cancelled') {
      handOn.current = true
      setLocal((m) => ({ ...m, [r.id]: { cancelled: true, error: null } }))
      return
    }
    // A reply card words a failure like the composer does: "Not sent: <reason>. Your text is still here."
    const words =
      r.kind === 'reply' && !(res.status === 409 && res.error === 'ended')
        ? notSent(reasonOf(res.status, res.error))
        : answerError(res.status, res.error)
    setLocal((m) => ({ ...m, [r.id]: { ...m[r.id], error: words } }))
  }

  const heading = (
    <h2 id="your-move-title" className="text-title font-semibold text-fg">
      Your move
    </h2>
  )

  if (state === null) {
    return (
      <section id="your-move" aria-labelledby="your-move-title" aria-busy="true" tabIndex={-1} className="flex min-w-0 flex-col gap-3">
        {heading}
        <Skeleton className="h-[360px] w-full rounded-hero lg:h-[280px]" />
      </section>
    )
  }

  const settled = state.requests
    .filter(isSettledHere)
    .sort((a, b) => Date.parse(b.answeredAt ?? b.createdAt) - Date.parse(a.answeredAt ?? a.createdAt))
    .slice(0, MAX_SETTLED)
  // A reply that came back while agents still run asks nothing; it keeps a quiet card with its text.
  const waitingReplies = state.requests.filter(
    (r): r is Extract<Request, { kind: 'reply' }> => r.status === 'open' && !isSettledHere(r) && replyWaitsOnAgents(r),
  )
  const renderOpen = (r: Request, hero: boolean) => {
    const props = {
      hero,
      now,
      busy: busyId === r.id,
      error: local[r.id]?.error ?? null,
    }
    if (r.kind === 'question') return <QuestionCard key={r.id} request={r} {...props} onAnswer={(b) => void answer(r, b)} />
    if (r.kind === 'permission') return <PermissionCard key={r.id} request={r} {...props} onAnswer={(b) => void answer(r, b)} />
    return <ReplyCard key={r.id} request={r} {...props} transcript={state.transcript} onAnswer={(b) => void answer(r, b)} />
  }

  const waitingCard = (r: Extract<Request, { kind: 'reply' }>) => (
    <Card key={r.id} variant="default" density="compact" asChild>
      <article aria-label={cardName(r)} data-request={r.id} className="flex min-w-0 flex-col gap-1 text-ui">
        <p className="line-clamp-3 min-w-0 text-fg break-words whitespace-pre-wrap">{r.text}</p>
        <p className="min-w-0 text-meta text-muted break-words">
          Agents still running; nothing needed from you ({plural(r.backgroundTasks, 'background task')}).
        </p>
      </article>
    </Card>
  )

  const settledCard = (r: Request) => {
    const { head, lines } = settledWords(local[r.id]?.cancelled ? { ...r, status: 'cancelled' } : r, local[r.id]?.sent ?? null)
    const when = hhmm(r.answeredAt)
    return (
      <Card key={r.id} variant="default" density="compact" asChild>
        <article aria-label={cardName(r)} data-request={r.id} className="flex min-w-0 flex-col gap-1 text-ui">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-fg">{cardName(r)}</span>
            {when && <span className="font-mono text-meta text-muted tabular-nums">{when}</span>}
          </div>
          {r.kind === 'permission' && (r.title || r.summary) && (
            <p className="min-w-0 text-fg break-words">
              {r.title}
              {r.title && r.summary ? ' ' : ''}
              {r.summary && <code className="rounded-chip bg-secondary px-1.5 py-0.5 font-mono text-meta break-all">{r.summary}</code>}
            </p>
          )}
          {r.kind === 'reply' && r.text && <p className="line-clamp-3 min-w-0 text-fg break-words whitespace-pre-wrap">{r.text}</p>}
          <p role="status" className="min-w-0 text-muted break-words">
            {head}
          </p>
          {lines.map((l, i) => (
            <p key={i} className="min-w-0 text-meta text-muted break-words">
              {l}
            </p>
          ))}
        </article>
      </Card>
    )
  }

  const justAnswered = settled.filter((r) => local[r.id]?.sent !== undefined || local[r.id]?.cancelled === true)
  const earlier = settled.filter((r) => !justAnswered.includes(r))

  const [hero, ...rest] = open

  // Nothing open, waiting or settled: nothing to show, so no region and no heading.
  if (!hero && waitingReplies.length === 0 && settled.length === 0 && !flags.ended) return null

  return (
    <section
      id="your-move"
      ref={region}
      {...(hero ? { 'aria-labelledby': 'your-move-title' } : { 'aria-label': 'Your move' })}
      tabIndex={-1}
      className="flex min-w-0 flex-col gap-3 outline-none"
    >
      {/* The heading shows only while something waits on the person. */}
      {hero && heading}

      {flags.ended && <Notice tone="fail">{SESSION_ENDED}</Notice>}

      {/* Every open card, the waiting replies and the "more waiting" label sit in one keyed list under this section,
          so when the hero is settled the next card moves up in place and keeps what was typed in it. */}
      {hero && [
        renderOpen(hero, true),
        ...waitingReplies.map(waitingCard),
        ...(rest.length > 0
          ? [
              <p key="more-waiting" className="text-meta font-medium text-muted">
                {rest.length} more waiting on you
              </p>,
            ]
          : []),
        ...rest.map((r) => renderOpen(r, false)),
      ]}

      {!hero && waitingReplies.map(waitingCard)}

      {/* What the person just answered here stays in view; the rest collapse into one closed disclosure. */}
      {justAnswered.map(settledCard)}

      {earlier.length > 0 && (
        <details className="flex min-w-0 flex-col gap-2">
          <summary className="cursor-pointer text-meta font-medium text-muted">
            {earlier.length} earlier {earlier.length === 1 ? 'request' : 'requests'} answered
          </summary>
          <div className="mt-2 flex min-w-0 flex-col gap-2">{earlier.map(settledCard)}</div>
        </details>
      )}
    </section>
  )
}
