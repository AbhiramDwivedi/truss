import * as React from 'react'
import { CircleAlert, CircleX, Info } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

// A row of icon and words ("Reconnecting…"). The only primitive that adds a live region, and only when
// live="polite". Meaning is always in the words, never in the colour alone.
export type NoticeTone = 'info' | 'signal' | 'fail'

const look: Record<NoticeTone, string> = {
  info: 'bg-secondary text-muted',
  signal: 'bg-signal-soft text-signal-text',
  fail: 'bg-fail-soft text-fail-text',
}

const icon: Record<NoticeTone, typeof Info> = { info: Info, signal: CircleAlert, fail: CircleX }

export interface NoticeProps {
  tone?: NoticeTone
  live?: 'polite' | 'off'
  id?: string
  className?: string
  children: React.ReactNode
}

export function Notice({ tone = 'info', live = 'polite', id, className, children }: NoticeProps) {
  const Icon = icon[tone]
  return (
    <div
      id={id}
      role={live === 'polite' ? 'status' : undefined}
      className={cn('flex min-w-0 items-start gap-2 rounded-ctl px-3 py-2 text-ui', look[tone], className)}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}
