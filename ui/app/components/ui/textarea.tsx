import * as React from 'react'
import { cn } from '../../lib/utils.ts'
import { fieldBase, fieldSurface } from './input.tsx'
import type { FieldName, FieldSurface } from './input.tsx'
import { InputGroupContext } from './input-group.tsx'

export type TextareaProps = Omit<React.ComponentProps<'textarea'>, 'aria-label' | 'aria-labelledby' | 'id'> &
  FieldName & {
    surface?: FieldSurface
    /** `bare` has no border or focus outline of its own: it is legal only inside an InputGroup. */
    variant?: 'default' | 'bare'
  }

const barePlaceholder: Record<FieldSurface, string> = {
  default: 'placeholder:text-subtle',
  move: 'placeholder:text-move-muted',
}

export function Textarea({ className, surface = 'default', variant = 'default', ...props }: TextareaProps) {
  const group = React.useContext(InputGroupContext)
  if (variant === 'bare') {
    if (group === null) {
      if (import.meta.env.DEV) throw new Error('Textarea variant="bare" is legal only inside an InputGroup')
    }
    return (
      <textarea
        className={cn(
          'min-h-10 w-full min-w-0 resize-none bg-transparent px-2 py-2 text-body text-current focus-visible:outline-0',
          barePlaceholder[group?.surface ?? surface],
          className,
        )}
        {...props}
      />
    )
  }
  return <textarea className={cn(fieldBase, 'min-h-20 resize-y py-2', fieldSurface[surface], className)} {...props} />
}
