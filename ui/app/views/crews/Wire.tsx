// The wire from the PM to one crew card (ADR-0028 section 7, R-40), and the trunk it hangs from. Decorative:
// aria-hidden, and every fact it shows is also text on the card. Geometry is CSS only: the svg sits in the
// card's 24 px top padding and reaches 24 px left into the gutter, so its bus meets the trunk at x = 1.
// Stroke and animation sit on the <line>s, never on the <svg> (the contract reads the first stroked element).
// The dash patterns sum to 11, the dash keyframe's offset, so the dash never jumps on a loop.
import { cn } from '../../lib/utils.ts'
import type { Status } from '../status/status.ts'

export interface WireProps {
  crew: string
  status: Status
  /** A hand-off to this crew within the last 10 s, computed from `now` on every render. */
  recent: boolean
}

/** The window a hand-off keeps its wire lit. */
export const LIT_MS = 10_000

const PAINT = 'transition-[stroke,stroke-width] duration-200 ease-out [stroke-width:var(--wire-w)]'
const LIVE = '[stroke-width:var(--wire-w-live)]'
const SOLID = 'motion-reduce:[stroke-dasharray:none]'

const STROKE: Record<Status, string> = {
  active: 'stroke-brand motion-safe:animate-dash',
  waiting: 'stroke-signal',
  stuck: 'stroke-fail',
  done: 'stroke-border-strong',
  planned: 'stroke-border-strong',
}

const DASH: Partial<Record<Status, string>> = { active: '6 5', planned: '4 4' }

export function wireClass(status: Status, recent: boolean): string {
  return cn(PAINT, STROKE[status], recent && ['stroke-brand', LIVE, SOLID], status === 'active' && SOLID)
}

export function Wire({ crew, status, recent }: WireProps) {
  const cls = wireClass(status, recent)
  const dash = DASH[status]
  return (
    <svg
      data-crew={crew}
      aria-hidden="true"
      className="pointer-events-none absolute top-0 -left-6 h-6 w-[calc(100%+24px)] overflow-visible"
    >
      <line x1="0" x2="100%" y1="1" y2="1" strokeDasharray={dash} className={cls} />
      <line x1="48" x2="48" y1="0" y2="24" strokeDasharray={dash} className={cls} />
    </svg>
  )
}

export interface TrunkProps {
  /** Any crew is active: the trunk flows. */
  animated: boolean
  /** Any hand-off is recent: the trunk lights. */
  lit: boolean
  className?: string
}

/** One segment of the trunk, at gutter x = 1. The caller positions it. */
export function Trunk({ animated, lit, className }: TrunkProps) {
  return (
    <svg aria-hidden="true" className={cn('pointer-events-none absolute w-6 overflow-visible', className)}>
      <line
        x1="1"
        x2="1"
        y1="0"
        y2="100%"
        strokeDasharray={animated ? '6 5' : undefined}
        className={cn(PAINT, lit ? ['stroke-brand', LIVE] : 'stroke-border-strong', animated && 'motion-safe:animate-dash', (animated || lit) && SOLID)}
      />
    </svg>
  )
}
