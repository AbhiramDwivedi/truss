import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '../../lib/utils.ts'

// A field's visible name. Pass `sr-only` through className for a name only screen readers need.
export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return <LabelPrimitive.Root className={cn('text-meta font-medium text-fg', className)} {...props} />
}
