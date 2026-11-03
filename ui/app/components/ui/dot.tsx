import { cn } from '../../lib/utils.ts'

// A 6 px status mark. Always aria-hidden and always next to words: it never carries meaning alone.
export type DotTone = 'neutral' | 'brand' | 'signal' | 'fail' | 'ok' | 'move' | 'opus' | 'sonnet'

const fill: Record<DotTone, string> = {
  neutral: 'bg-border-strong',
  brand: 'bg-brand',
  signal: 'bg-signal',
  fail: 'bg-fail',
  ok: 'bg-ok',
  move: 'bg-move',
  opus: 'bg-opus',
  sonnet: 'bg-sonnet',
}

const ring: Record<DotTone, string> = {
  neutral: 'border-border-strong',
  brand: 'border-brand',
  signal: 'border-signal',
  fail: 'border-fail',
  ok: 'border-ok',
  move: 'border-move',
  opus: 'border-opus',
  sonnet: 'border-sonnet',
}

export interface DotProps {
  tone?: DotTone
  /** An outline only, for a state that has not started. */
  hollow?: boolean
  className?: string
}

export function Dot({ tone = 'neutral', hollow = false, className }: DotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-1.5 shrink-0 rounded-full', hollow ? cn('border', ring[tone]) : fill[tone], className)}
    />
  )
}

// A Dot with a ping halo. The halo is its own element, so reduced motion nulls it and the dot stays.
export function LivePing({ tone = 'ok', className }: Omit<DotProps, 'hollow'>) {
  return (
    <span aria-hidden="true" className={cn('relative inline-flex size-1.5 shrink-0', className)}>
      <span className={cn('absolute inset-0 rounded-full opacity-75 motion-safe:animate-ping-dot', fill[tone])} />
      <span className={cn('relative inline-block size-1.5 rounded-full', fill[tone])} />
    </span>
  )
}
