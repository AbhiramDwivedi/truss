import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils.ts'

// Radix Tabs with automatic activation (arrow keys select). The list scrolls inside itself at 360 px.
export function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn('flex min-w-0 flex-col gap-3', className)} {...props} />
}

export function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex max-w-full items-center gap-0.5 self-start overflow-x-auto rounded-ctl bg-secondary p-0.5 no-scrollbar',
        className,
      )}
      {...props}
    />
  )
}

// Shared with RadioGroupItem's segment look.
export const triggerLook =
  'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-chip px-2.5 text-meta font-medium whitespace-nowrap text-muted tabular-nums transition-colors duration-(--duration-quick) ease-out hover:text-fg pointer-coarse:h-9 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0'

export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        triggerLook,
        'data-[state=active]:bg-surface data-[state=active]:text-fg data-[state=active]:shadow-e1 data-[state=active]:ring-1 data-[state=active]:ring-border',
        className,
      )}
      {...props}
    />
  )
}

export function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('min-w-0', className)} {...props} />
}
