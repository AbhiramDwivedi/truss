import * as React from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'
import { Dot } from './dot.tsx'

// Status chips (ADR-0023 section 3). Text is always a text token on its soft background: `ok`,
// `signal`, `sonnet` and `opus` never colour text, so `ok` carries an ok Dot beside `text-fg`.
export type BadgeTone = 'neutral' | 'brand' | 'signal' | 'fail' | 'ok' | 'move' | 'fail-solid'

const badgeVariants = cva(
  'inline-flex max-w-full min-w-0 items-center gap-1 align-middle font-medium whitespace-nowrap tabular-nums',
  {
    variants: {
      tone: {
        neutral: 'bg-secondary text-muted',
        brand: 'bg-brand-soft text-brand-strong',
        signal: 'bg-signal-soft text-signal-text',
        fail: 'bg-fail-soft text-fail-text',
        ok: 'bg-ok-soft text-fg',
        move: 'bg-move text-move-fg',
        'fail-solid': 'bg-fail text-surface',
      },
      size: {
        sm: 'h-5 px-1.5 text-micro',
        md: 'h-6 px-2.5 text-meta',
      },
      shape: {
        chip: 'rounded-chip',
        pill: 'rounded-full',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md', shape: 'chip' },
  },
)

// The ring a badge takes when it is a link, so it reads as a target.
const linkRing: Record<BadgeTone, string> = {
  neutral: 'ring-border',
  brand: 'ring-brand/30',
  signal: 'ring-signal/30',
  fail: 'ring-fail/30',
  ok: 'ring-ok/30',
  move: 'ring-move/30',
  'fail-solid': 'ring-fail/30',
}

export interface BadgeProps {
  tone?: BadgeTone
  size?: 'sm' | 'md'
  shape?: 'chip' | 'pill'
  /** The full value, shown when the text is truncated. */
  title?: string
  /** Renders the badge as a link with a tone ring and a coarse-pointer target. */
  href?: string
  className?: string
  children?: React.ReactNode
}

export function Badge({ tone = 'neutral', size, shape, title, href, className, children }: BadgeProps) {
  const inner = (
    <>
      {tone === 'ok' && <Dot tone="ok" />}
      <span className="min-w-0 truncate">{children}</span>
    </>
  )
  if (href !== undefined) {
    return (
      <a
        href={href}
        title={title}
        className={cn(badgeVariants({ tone, size, shape }), 'ring-1 pointer-coarse:h-8', linkRing[tone], className)}
      >
        {inner}
      </a>
    )
  }
  return (
    <span title={title} className={cn(badgeVariants({ tone, size, shape }), className)}>
      {inner}
    </span>
  )
}

// The model a member runs on. The model colour sits on a Dot only, never on the text (ADR-0023:126).
export interface ModelBadgeProps {
  model: 'opus' | 'sonnet' | (string & {})
  size?: 'sm' | 'md'
  title?: string
  className?: string
  children?: React.ReactNode
}

export function ModelBadge({ model, size = 'sm', title, className, children }: ModelBadgeProps) {
  const known: 'opus' | 'sonnet' | null = model === 'opus' ? 'opus' : model === 'sonnet' ? 'sonnet' : null
  return (
    <span
      title={title}
      className={cn(badgeVariants({ size, shape: 'chip' }), 'border border-border bg-transparent text-fg', className)}
    >
      {known !== null ? <Dot tone={known} /> : <Dot tone="neutral" hollow />}
      <span className="min-w-0 truncate">{children ?? model}</span>
    </span>
  )
}

export { badgeVariants }
