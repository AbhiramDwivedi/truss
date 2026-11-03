import * as React from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Button } from './button.tsx'

// Crew members. The trigger is a ghost Button whose ChevronDown turns 180° when open; the content is
// shown or hidden, never animated by height.
export function Collapsible(props: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root {...props} />
}

export interface CollapsibleTriggerProps extends Omit<React.ComponentProps<'button'>, 'aria-disabled'> {
  size?: 'sm' | 'md' | 'lg'
}

export function CollapsibleTrigger({ className, size = 'sm', children, ...props }: CollapsibleTriggerProps) {
  return (
    <CollapsiblePrimitive.Trigger asChild>
      <Button
        variant="ghost"
        size={size}
        className={cn('group', className)}
        iconEnd={
          <ChevronDown
            aria-hidden="true"
            className="transition-transform duration-(--duration-quick) ease-out group-data-[state=open]:rotate-180"
          />
        }
        {...props}
      >
        {children}
      </Button>
    </CollapsiblePrimitive.Trigger>
  )
}

export function CollapsibleContent({ className, ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return <CollapsiblePrimitive.Content className={cn('min-w-0', className)} {...props} />
}
