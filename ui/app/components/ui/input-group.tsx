import * as React from 'react'
import { cn } from '../../lib/utils.ts'
import type { FieldSurface } from './input.tsx'

// The composer: the group owns the border and the focus ring (a focus-within outline, the one exception
// to the global focus rule); it holds a `variant="bare"` Textarea and a trailing action slot.
export const InputGroupContext = React.createContext<{ surface: FieldSurface } | null>(null)

const groupSurface: Record<FieldSurface, string> = {
  default: 'border-input bg-surface text-fg focus-within:border-brand',
  move: 'border-move-line bg-move-fg/6 text-move-fg focus-within:border-move-fg',
}

export interface InputGroupProps extends React.ComponentProps<'div'> {
  surface?: FieldSurface
}

export function InputGroup({ className, surface = 'default', ...props }: InputGroupProps) {
  return (
    <InputGroupContext.Provider value={{ surface }}>
      <div
        data-slot="input-group"
        className={cn(
          'flex w-full min-w-0 items-end gap-2 rounded-ctl border p-1 outline-(--focus) transition-colors duration-(--duration-quick) ease-out focus-within:outline-2 focus-within:outline-offset-2 has-aria-invalid:border-fail has-aria-invalid:outline-fail',
          groupSurface[surface],
          className,
        )}
        {...props}
      />
    </InputGroupContext.Provider>
  )
}

export function InputGroupAction({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex shrink-0 items-center gap-1 self-end', className)} {...props} />
}
