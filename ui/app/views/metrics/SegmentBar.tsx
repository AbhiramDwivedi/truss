// A row of status segments: the member bar on a crew card and the Agents and Crews merged tiles. A live
// segment carries D2's sheen; under reduced motion it is solid brand. Decorative: words sit beside it.
import { cn } from '../../lib/utils.ts'

export type SegmentTone = 'ok' | 'brand' | 'fail' | 'signal' | 'border' | 'strong'

export interface Segment {
  tone: SegmentTone
  live?: boolean
  title?: string
}

const fill: Record<SegmentTone, string> = {
  ok: 'bg-ok',
  brand: 'bg-brand',
  fail: 'bg-fail',
  signal: 'bg-signal',
  border: 'bg-border',
  strong: 'bg-border-strong',
}

export interface SegmentBarProps {
  segments: Segment[]
  className?: string
}

export function SegmentBar({ segments, className }: SegmentBarProps) {
  return (
    <span aria-hidden="true" className={cn('flex h-1.5 min-w-0 gap-0.5', className)}>
      {segments.length === 0 ? (
        <span className="h-full flex-1 rounded-full bg-border" />
      ) : (
        segments.map((s, i) => (
          <span key={i} title={s.title} className={cn('h-full min-w-0 flex-1 overflow-hidden rounded-full', fill[s.tone])}>
            {s.live && (
              <span className="block size-full bg-size-[200%_100%] motion-safe:bg-linear-90 motion-safe:from-transparent motion-safe:via-surface/55 motion-safe:to-transparent motion-safe:animate-sheen" />
            )}
          </span>
        ))
      )}
    </span>
  )
}
