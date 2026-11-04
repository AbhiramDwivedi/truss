// An open reply request (ADR-0028 section 2, R-47): the PM's turn ended with text and waits on the person.
// "The PM replied" is answered with a reply; only an approval ask ("Approval needed") has Approve and Deny.
import { useId, useRef, useState } from 'react'
import { MessageSquareText, TriangleAlert } from 'lucide-react'
import type { ReplyRequest, TranscriptEntry } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { Card } from '../../components/ui/card.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Label } from '../../components/ui/label.tsx'
import { Textarea } from '../../components/ui/textarea.tsx'
import { ago, cardName, NOT_TAKEN, plural, replyTarget, revealMessage, STILL_SENDING, useSendState } from './format.ts'
import { DecisionButton } from './ReplyActions.tsx'

type Body = { decision: 'allow' | 'deny' } | { decision: 'message'; message: string }

export interface ReplyCardProps {
  request: ReplyRequest
  hero: boolean
  now: number
  busy: boolean
  error: string | null
  onAnswer: (body: Body) => void
  /** The thread, so Read in thread can find the PM's message. */
  transcript?: TranscriptEntry[]
}

export function ReplyCard({ request, hero, now, busy, error, onAnswer, transcript = [] }: ReplyCardProps) {
  const base = useId()
  const [message, setMessage] = useState('')
  const last = useRef<Body | null>(null)
  const ask = request.approvalAsk === true
  const stage = useSendState(busy, error !== null && !busy)
  const text = message.trim()
  const hasText = text !== ''
  const target = replyTarget(transcript, request)

  const send = (body: Body) => {
    last.current = body
    onAnswer(body)
  }
  const sendReply = () => {
    if (hasText) send({ decision: 'message', message: text })
  }
  const pressed = last.current

  const muted = hero ? 'text-move-muted' : 'text-muted'
  const alertText = stage === 'stuck' ? NOT_TAKEN : error
  const showAlert = stage === 'stuck' || (stage === 'failed' && error !== null)
  const hint = ask
    ? hasText
      ? 'Sends your text instead of Approved. or Not approved.'
      : null
    : hasText
      ? 'Sends your text to the PM as the reply.'
      : 'Type a reply first.'
  const replyPrimary = !ask || hasText

  return (
    <Card variant={hero ? 'hero' : 'default'} asChild className={hero ? undefined : 'border-brand-line'}>
      <article aria-label={cardName(request)} data-request={request.id} data-open="true" className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
          {hero && (
            <span className="inline-flex h-6 items-center rounded-full bg-signal-soft px-2 font-semibold text-signal-text">Your move</span>
          )}
          <h3 className={cn('text-lead font-semibold', hero ? 'text-move-fg' : 'text-fg')}>{cardName(request)}</h3>
          <span className={cn('ml-auto tabular-nums', muted)}>Asked {ago(request.createdAt, now)}</span>
        </div>
        {request.isError && (
          <p className={cn('flex items-center gap-2 text-ui font-semibold', hero ? 'text-move-fg' : 'text-fail-text')}>
            <TriangleAlert aria-hidden="true" className="size-4 shrink-0" />
            The PM's turn ended with an error.
          </p>
        )}
        <p className="line-clamp-6 min-w-0 text-body break-words whitespace-pre-wrap">{request.text}</p>
        {request.backgroundTasks > 0 && (
          <p className={cn('text-meta', muted)}>
            {plural(request.backgroundTasks, 'background task')} running when the turn ended; the session may start a turn on its own.
          </p>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className={cn('pointer-coarse:min-h-11 max-sm:w-full', hero && 'text-move-fg hover:bg-move-fg/10 hover:text-move-fg')}
            icon={<MessageSquareText aria-hidden="true" />}
            disabled={busy || target === null}
            onClick={() => target !== null && revealMessage(target)}
          >
            Read in thread
          </Button>
          {ask && (
            <>
              <DecisionButton
                kind="allow"
                hero={hero}
                primary={!hasText}
                busy={busy && pressed?.decision === 'allow'}
                disabled={busy}
                onPress={() => send({ decision: 'allow' })}
              />
              <DecisionButton
                kind="deny"
                hero={hero}
                primary={false}
                busy={busy && pressed?.decision === 'deny'}
                disabled={busy}
                onPress={() => send({ decision: 'deny' })}
              />
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={`${base}-reply`} className={cn('text-meta font-medium', hero ? 'text-move-fg' : 'text-fg')}>
            Your reply
          </Label>
          <Textarea
              id={`${base}-reply`}
              rows={3}
              surface={hero ? 'move' : 'default'}
              autoComplete="off"
              value={message}
              disabled={busy}
              aria-describedby={hint ? `${base}-hint` : undefined}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  if (!busy) sendReply()
                }
              }}
            />
          {hint && (
            <p id={`${base}-hint`} className={cn('text-meta', muted)}>
              {hint}
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button
              variant={replyPrimary ? (hero ? 'on-move' : 'primary') : hero ? 'ghost' : 'secondary'}
              className={cn(!replyPrimary && hero && 'border border-move-line text-move-fg hover:bg-move-fg/10 hover:text-move-fg', 'pointer-coarse:min-h-11 max-sm:w-full')}
              busy={busy && pressed?.decision === 'message'}
              disabled={busy || !hasText}
              onClick={sendReply}
            >
              {busy && pressed?.decision === 'message' ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </div>
        {stage === 'slow' && (
          <p role="status" className={cn('text-meta', muted)}>
            {STILL_SENDING}
          </p>
        )}
        {showAlert && alertText && (
          <div role="alert" className={cn('flex min-w-0 flex-wrap items-center gap-2 text-ui', hero ? 'text-move-fg' : 'text-fail-text')}>
            <p className="min-w-0">{alertText}</p>
            {pressed && (
              <Button variant={hero ? 'ghost' : 'secondary'} size="sm" className={cn('pointer-coarse:min-h-11 max-sm:w-full', hero && 'border border-move-line text-move-fg')} onClick={() => send(pressed)}>
                Try again
              </Button>
            )}
          </div>
        )}
      </article>
    </Card>
  )
}
