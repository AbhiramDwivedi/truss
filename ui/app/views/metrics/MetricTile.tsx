// One tile of the live counter (D2 direction-d2.html:540-600): a muted term, a mono tabular value and a
// sub-line, on a sunken tile of fixed height so a changing value never moves the row.
import * as React from 'react'
import { cn } from '../../lib/utils.ts'

export interface MetricTileProps {
  label: string
  value: React.ReactNode
  /** The full figure when the value is compacted. */
  title?: string
  /** Words beside the value, such as a rate. */
  aside?: React.ReactNode
  /** A decorative bar or line under the value. */
  graphic?: React.ReactNode
  sub?: React.ReactNode
  /** Hover text for the sub-line, when it needs more than its own words. */
  subTitle?: string
  /** The sub-line reads as a warning. */
  subTone?: 'muted' | 'signal'
  className?: string
}

export function MetricTile({ label, value, title, aside, graphic, sub, subTitle, subTone = 'muted', className }: MetricTileProps) {
  return (
    <div className={cn('flex h-30 min-w-0 flex-col rounded-card border border-border bg-sunken p-4 shadow-e1', className)}>
      <dt className="text-meta font-medium text-muted">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-col">
        <span className="mt-1 flex min-w-0 items-baseline gap-2 font-mono text-title tabular-nums text-fg">
          <span className="min-w-0 truncate motion-safe:animate-tick-up" title={title}>
            {value}
          </span>
          {aside != null && <span className="shrink-0 text-meta text-muted">{aside}</span>}
        </span>
        {graphic}
        {sub != null && ' '}
        {sub != null && (
          <span
            title={subTitle ?? (typeof sub === 'string' ? sub : undefined)}
            className={cn('mt-auto line-clamp-2 break-words text-meta', subTone === 'signal' ? 'text-signal-text' : 'text-muted')}
          >
            {sub}
          </span>
        )}
      </dd>
    </div>
  )
}
