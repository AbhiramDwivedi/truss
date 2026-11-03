import * as React from 'react'
import { Info } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

// An always-visible tip that a control names through aria-describedby (the Pause tip, ADR-0023:81).
export interface HintProps {
  id: string
  className?: string
  children: React.ReactNode
}

export function Hint({ id, className, children }: HintProps) {
  return (
    <p id={id} className={cn('flex min-w-0 items-start gap-1.5 text-meta text-muted', className)}>
      <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}
