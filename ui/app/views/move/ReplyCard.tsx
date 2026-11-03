// An open reply request (ADR-0023 section 4, ADR-0011 R-7): Claude's turn ended and waits on the person.
// Approve or Deny, with an optional message that goes out with the decision.
import { useId, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { ReplyRequest } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { Card } from '../../components/ui/card.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'
import { Dot } from '../../components/ui/dot.tsx'
import { ago, cardName, plural } from './format.ts'

export interface ReplyCardProps {
  request: ReplyRequest
  hero: boolean
  now: number
  busy: boolean
  error: string | null
  onAnswer: (body: { decision: 'allow' | 'deny'; message?: string }) => void
}

export function ReplyCard({ request, hero, now, busy, error, onAnswer }: ReplyCardProps) {
  const base = useId()
  const [message, setMessage] = useState('')
  const decide = (decision: 'allow' | 'deny') => {
    const m = message.trim()
    onAnswer(m === '' ? { decision } : { decision, message: m })
  }
  const muted = hero ? 'text-move-muted' : 'text-muted'
  return (
    <Card variant={hero ? 'hero' : 'default'} asChild className={hero ? undefined : 'border-brand-line'}>
      <article aria-label={cardName(request)} data-request={request.id} data-open="true" className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
          {hero && (
            <span className="inline-flex h-6 items-center rounded-full bg-signal-soft px-2.5 font-semibold text-signal-text">Your move</span>
          )}
          <span className={cn('inline-flex items-center gap-1.5 font-medium', hero ? 'text-move-fg' : 'text-fg')}>
            <Dot tone={request.isError ? 'fail' : 'signal'} />
            Reply needed
          </span>
          <span className={cn('ml-auto tabular-nums', muted)}>Asked {ago(request.createdAt, now)}</span>
        </div>
        {request.isError && (
          <p className={cn('text-ui font-semibold', hero ? 'text-move-fg' : 'text-fail-text')}>Error: the turn ended with an error.</p>
        )}
        <p className="max-h-80 min-w-0 overflow-y-auto text-body break-words whitespace-pre-wrap">{request.text}</p>
        {request.backgroundTasks > 0 && (
          <p className={cn('text-meta', muted)}>
            {plural(request.backgroundTasks, 'background task')} running when the turn ended; the session may start a turn on its own.
          </p>
        )}
        <Input
          aria-label="Message with your answer"
          surface={hero ? 'move' : 'default'}
          placeholder="Optional message to send with your decision"
          autoComplete="off"
          value={message}
          disabled={busy}
          onChange={(e) => setMessage(e.target.value)}
        />
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button variant={hero ? 'on-move' : 'primary'} busy={busy} icon={<Check aria-hidden="true" />} onClick={() => decide('allow')}>
            Approve
          </Button>
          <Button
            variant={hero ? 'ghost' : 'secondary'}
            className={hero ? 'border border-move-line text-move-fg hover:bg-move-fg/10 hover:text-move-fg' : undefined}
            busy={busy}
            icon={<X aria-hidden="true" />}
            onClick={() => decide('deny')}
          >
            Deny
          </Button>
          {error && (
            <p id={`${base}-alert`} role="alert" className={cn('min-w-0 text-ui', hero ? 'text-move-fg' : 'text-fail-text')}>
              {error}
            </p>
          )}
        </div>
      </article>
    </Card>
  )
}
