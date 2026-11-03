import * as React from 'react'
import * as CheckboxPrimitive from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

// A 16 px box, checked bg-primary with a move-fg check, inside a <label> of at least 24 px.
export interface CheckboxProps extends React.ComponentProps<typeof CheckboxPrimitive.Root> {
  /** Classes for the wrapping <label>. */
  labelClassName?: string
}

export function Checkbox({ className, labelClassName, children, ...props }: CheckboxProps) {
  return (
    <label className={cn('flex min-h-6 min-w-0 cursor-pointer items-center gap-2 text-ui text-fg', labelClassName)}>
      <CheckboxPrimitive.Root
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-chip border border-subtle bg-surface text-move-fg transition-colors duration-(--duration-quick) ease-out data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        <CheckboxPrimitive.Indicator className="flex items-center justify-center">
          <Check aria-hidden="true" className="size-3" strokeWidth={3} />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      {children != null && <span className="min-w-0">{children}</span>}
    </label>
  )
}
