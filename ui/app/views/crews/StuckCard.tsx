// The stuck card inside a crew (ADR-0023 section 4; D2 direction-d2.html:700-760): why, how long and
// what next, then three actions. Each action sends ADR-0023's message to Claude with no intent and
// says, beside the buttons, whether it was sent.
import * as React from 'react'
import type { Crew, CrewStuck, PostResult } from '../../store/types.ts'
import { postMessage } from '../../store/api.ts'
import { buttonVariants } from '../../components/ui/button.tsx'
import { flaggedAt, hhmmAt, stalledAgent, stalledRole } from './format.ts'

type Action = 'primary' | 'replan' | 'ask'

interface Sent {
  action: Action
  phase: 'sending' | 'sent' | 'failed'
  at?: number
  reason?: string
}

export interface StuckCardProps {
  crew: Crew
  stuck: CrewStuck
  now: number
}

/** ADR-0023 section 4's message for each action. */
function stuckMessage(crew: Crew, stuck: CrewStuck, action: Action): string {
  const head = `Crew ${crew.slug} is stuck: ${stuck.detail}.`
  if (action === 'replan') return `${head} Re-plan this crew.`
  if (action === 'ask') return `${head} What is happening, and what do you suggest?`
  if (stuck.kind === 'idle-project-manager') return `${head} Start a successor project manager for it.`
  return `${head} Restart its ${stalledRole(crew)}.`
}

const reasonWords = (r: PostResult): string =>
  r.error === 'network' ? 'the server is unreachable' : r.error === 'timeout' ? 'the server did not answer in time' : r.error === 'http' ? `the server answered ${r.status}` : String(r.error)

// Raw buttons, not Button: the soft pair carries the bg-danger-soft class token the view test pins, which
// cn would merge away against bg-fail-soft. The aria-disabled guard is the same as Button's.
function ActionButton({ variant, busy, onPress, children }: { variant: 'danger' | 'danger-soft'; busy: boolean; onPress: () => void; children: React.ReactNode }) {
  const base = buttonVariants({ variant, size: 'sm' })
  return (
    <button
      type="button"
      className={variant === 'danger-soft' ? `${base} bg-danger-soft` : base}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={(e) => {
        if (busy) {
          e.preventDefault()
          return
        }
        onPress()
      }}
    >
      <span className="min-w-0 truncate">{children}</span>
    </button>
  )
}

export function StuckCard({ crew, stuck, now }: StuckCardProps) {
  const [sent, setSent] = React.useState<Sent | null>(null)
  const busy = sent?.phase === 'sending'
  const idle = stuck.kind === 'idle-project-manager'
  const flag = flaggedAt(stuck)
  const primary = idle ? 'Start a successor project manager' : `Restart ${stalledRole(crew)}`

  const send = (action: Action) => {
    if (busy) return
    setSent({ action, phase: 'sending' })
    void postMessage(stuckMessage(crew, stuck, action)).then((r) => {
      if (r.error === null) setSent({ action, phase: 'sent', at: Date.now() })
      else setSent({ action, phase: 'failed', reason: reasonWords(r) })
    })
  }

  const label = (action: Action, words: string) => (sent?.action === action && busy ? 'Sending…' : words)

  return (
    <div className="mt-3 rounded-card border border-fail/40 bg-fail-soft p-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-meta">
        <dt className="font-semibold text-fail-text">Why</dt>
        <dd className="min-w-0 break-words text-fg">
          {idle ? `The project manager has sent nothing for ${stuck.minutes} min.` : `${stalledAgent(crew)} has sent nothing for ${stuck.minutes} min.`}
        </dd>
        <dt className="font-semibold text-fail-text">How long</dt>
        <dd className="font-mono tabular-nums text-fg">
          {stuck.minutes} min{flag !== null && `, flagged ${hhmmAt(flag)}`}
          {flag !== null && now - flag > 60_000 && ` (${Math.floor((now - flag) / 60_000)} min ago)`}
        </dd>
        <dt className="font-semibold text-fail-text">Next</dt>
        <dd className="min-w-0 text-fg">
          {idle ? 'Start a successor project manager, re-plan the crew, or ask Claude.' : `Restart the ${stalledRole(crew)}, re-plan the crew, or ask Claude.`}
        </dd>
      </dl>
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton variant="danger" busy={busy} onPress={() => send('primary')}>
          {label('primary', primary)}
        </ActionButton>
        <ActionButton variant="danger-soft" busy={busy} onPress={() => send('replan')}>
          {label('replan', 'Re-plan crew')}
        </ActionButton>
        <ActionButton variant="danger-soft" busy={busy} onPress={() => send('ask')}>
          {label('ask', 'Ask Claude')}
        </ActionButton>
      </div>
      <p aria-live="polite" className="mt-2 text-micro text-muted empty:hidden">
        {sent?.phase === 'sent' && sent.at !== undefined ? `Sent to Claude ${hhmmAt(sent.at)}` : ''}
      </p>
      <p role="alert" className="mt-2 text-micro text-fail-text empty:hidden">
        {sent?.phase === 'failed' ? `Not sent: ${sent.reason}.` : ''}
      </p>
    </div>
  )
}
