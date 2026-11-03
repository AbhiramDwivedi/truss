import * as React from 'react'
import { cn } from '../../lib/utils.ts'

// Every field needs a name: an aria-label, an aria-labelledby, or an id that a <Label htmlFor> names.
export type FieldName = { 'aria-label': string } | { 'aria-labelledby': string } | { id: string }

export type FieldSurface = 'default' | 'move'

// Focus takes border-brand for the 3:1 boundary (ADR-0023:374); aria-invalid takes border-fail, and
// tokens.css turns --focus to fail under [aria-invalid="true"]. The outline is the global focus rule.
export const fieldSurface: Record<FieldSurface, string> = {
  default:
    'border-input bg-surface text-fg placeholder:text-subtle focus-visible:border-brand aria-invalid:border-fail aria-invalid:focus-visible:border-fail',
  move: 'border-move-line bg-move-fg/6 text-move-fg placeholder:text-move-muted focus-visible:border-move-fg aria-invalid:border-fail aria-invalid:focus-visible:border-fail',
}

export const fieldBase =
  'w-full min-w-0 rounded-ctl border px-3 text-body transition-colors duration-(--duration-quick) ease-out disabled:cursor-not-allowed disabled:opacity-50'

export type InputProps = Omit<React.ComponentProps<'input'>, 'aria-label' | 'aria-labelledby' | 'id'> &
  FieldName & {
    surface?: FieldSurface
  }

export function Input({ className, surface = 'default', type = 'text', ...props }: InputProps) {
  return <input type={type} className={cn(fieldBase, 'h-10', fieldSurface[surface], className)} {...props} />
}
