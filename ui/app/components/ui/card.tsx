import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils.ts'

// Surfaces by hierarchy (ADR-0023 section 3). Only `hero` (Your move) carries shadow-hero, and it marks
// itself data-surface="move" so --focus turns move-fg inside it.
const cardVariants = cva('min-w-0', {
  variants: {
    variant: {
      default: 'rounded-card border border-border bg-card text-card-foreground shadow-e1',
      panel: 'rounded-panel border border-border bg-card text-card-foreground shadow-e1',
      sunken: 'rounded-card bg-secondary text-fg',
      'alert-fail': 'rounded-card border border-fail/40 bg-fail-soft text-fg',
      'alert-signal': 'rounded-card border border-signal/40 bg-signal-soft text-fg',
      hero: 'rounded-hero bg-move text-move-fg shadow-hero',
    },
    density: {
      default: 'p-4',
      compact: 'p-3',
    },
  },
  compoundVariants: [{ variant: 'hero', className: 'p-6 max-lg:p-4' }],
  defaultVariants: { variant: 'default', density: 'default' },
})

export type CardVariant = 'default' | 'panel' | 'sunken' | 'alert-fail' | 'alert-signal' | 'hero'

export interface CardProps extends React.ComponentProps<'div'> {
  variant?: CardVariant
  /** `compact` is p-3; hero keeps its own p-6 / max-lg:p-4. */
  density?: 'default' | 'compact'
  /** Render the one child (an <article> or <section>) with the card's classes. */
  asChild?: boolean
}

export function Card({ className, variant = 'default', density, asChild = false, ...props }: CardProps) {
  const Comp = asChild ? Slot : 'div'
  return (
    <Comp
      data-surface={variant === 'hero' ? 'move' : undefined}
      className={cn(cardVariants({ variant, density }), className)}
      {...props}
    />
  )
}

export { cardVariants }
