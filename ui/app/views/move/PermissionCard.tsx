// An open permission request (ADR-0023 section 4, ADR-0011 R-15): a tool wants to run. The card shows
// the tool, what it would do, why it asked and the blocked path, then Approve or Deny with a message.
import { useId, useState } from 'react'
import { Check, X } from 'lucide-react'
import type { PermissionRequest } from '../../store/types.ts'
import { cn } from '../../lib/utils.ts'
import { Card } from '../../components/ui/card.tsx'
import { Button } from '../../components/ui/button.tsx'
import { Input } from '../../components/ui/input.tsx'
import { Dot } from '../../components/ui/dot.tsx'
import { ago, cardName } from './format.ts'

export interface PermissionCardProps {
  request: PermissionRequest
  hero: boolean
  now: number
  busy: boolean
  error: string | null
  onAnswer: (body: { decision: 'allow' | 'deny'; message?: string }) => void
}

export function PermissionCard({ request, hero, now, busy, error, onAnswer }: PermissionCardProps) {
  const base = useId()
  const [message, setMessage] = useState('')
  const decide = (decision: 'allow' | 'deny') => {
    const m = message.trim()
    onAnswer(m === '' ? { decision } : { decision, message: m })
  }
  const muted = hero ? 'text-move-muted' : 'text-muted'
  const code = hero ? 'rounded-chip bg-move-fg/10 px-1.5 py-0.5 font-mono text-meta break-all' : 'rounded-chip bg-secondary px-1.5 py-0.5 font-mono text-meta break-all'
  const facts: [string, string | null, boolean][] = [
    ['Tool', request.toolName, false],
    [request.toolName === 'Bash' ? 'Command' : 'Summary', request.summary, true],
    ['Why it asked', request.decisionReason, false],
    ['Blocked path', request.blockedPath, true],
  ]
  return (
    <Card variant={hero ? 'hero' : 'default'} asChild className={hero ? undefined : 'border-brand-line'}>
      <article aria-label={cardName(request)} data-request={request.id} data-open="true" className="flex min-w-0 flex-col gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-meta">
          {hero && (
            <span className="inline-flex h-6 items-center rounded-full bg-signal-soft px-2.5 font-semibold text-signal-text">Your move</span>
          )}
          <span className={cn('inline-flex items-center gap-1.5 font-medium', hero ? 'text-move-fg' : 'text-fg')}>
            <Dot tone="signal" />
            Permission request
          </span>
          <span className={cn('ml-auto tabular-nums', muted)}>Asked {ago(request.createdAt, now)}</span>
        </div>
        {request.title && <p className="max-w-[52ch] text-ask break-words">{request.title}</p>}
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-ui">
          {facts
            .filter(([, v]) => v !== null && v !== '')
            .map(([k, v, mono]) => (
              <div key={k} className="contents">
                <dt className={muted}>{k}</dt>
                <dd className="min-w-0 break-words">{mono ? <code className={code}>{v}</code> : v}</dd>
              </div>
            ))}
        </dl>
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
