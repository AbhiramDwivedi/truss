import * as React from 'react'
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group'
import { cn } from '../../lib/utils.ts'
import { triggerLook } from './tabs.tsx'

// Answers and the intent group. `dot` is a 16 px ring; `segment` takes the Tabs trigger look. Each item
// sits in a <label> of at least 24 px, so the words are the target too.
export type RadioLook = 'dot' | 'segment'

const LookContext = React.createContext<RadioLook>('dot')

export interface RadioGroupProps extends React.ComponentProps<typeof RadioGroupPrimitive.Root> {
  /** The items' default look; `segment` also draws the group as a scrolling tablist-like strip. */
  look?: RadioLook
}

export function RadioGroup({ className, look = 'dot', ...props }: RadioGroupProps) {
  return (
    <LookContext.Provider value={look}>
      <RadioGroupPrimitive.Root
        className={cn(
          look === 'segment'
            ? 'inline-flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-ctl bg-secondary p-0.5 no-scrollbar'
            : 'grid min-w-0 gap-2',
          className,
        )}
        {...props}
      />
    </LookContext.Provider>
  )
}

export interface RadioGroupItemProps extends React.ComponentProps<typeof RadioGroupPrimitive.Item> {
  look?: RadioLook
  /** Classes for the wrapping <label>. */
  labelClassName?: string
}

// The unchecked ring is border-subtle: border-strong on surface is under the 3:1 WCAG 1.4.11 boundary.
// Inside data-surface="move" the ring is move-muted, and checked is move on a move-fg option card.
const dotRing =
  'flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-subtle bg-surface transition-colors duration-(--duration-quick) ease-out data-[state=checked]:border-brand disabled:cursor-not-allowed disabled:opacity-50 [[data-surface=move]_&]:border-move-muted [[data-surface=move]_&]:data-[state=checked]:border-move'
const dotMark = 'size-2 rounded-full bg-brand [[data-surface=move]_&]:bg-move'

export function RadioGroupItem({ className, labelClassName, look, children, ...props }: RadioGroupItemProps) {
  const groupLook = React.useContext(LookContext)
  const as = look ?? groupLook
  if (as === 'segment') {
    return (
      <label className={cn('inline-flex min-h-6 shrink-0', labelClassName)}>
        <RadioGroupPrimitive.Item
          className={cn(
            triggerLook,
            'data-[state=checked]:bg-surface data-[state=checked]:text-fg data-[state=checked]:shadow-e1 data-[state=checked]:ring-1 data-[state=checked]:ring-border',
            className,
          )}
          {...props}
        >
          <span className="min-w-0 truncate">{children}</span>
        </RadioGroupPrimitive.Item>
      </label>
    )
  }
  return (
    <label className={cn('flex min-h-6 min-w-0 cursor-pointer items-center gap-2 text-ui', labelClassName)}>
      <RadioGroupPrimitive.Item className={cn(dotRing, className)} {...props}>
        <RadioGroupPrimitive.Indicator className={dotMark} />
      </RadioGroupPrimitive.Item>
      {children != null && <span className="min-w-0">{children}</span>}
    </label>
  )
}
