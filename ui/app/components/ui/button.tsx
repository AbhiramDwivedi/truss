import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { LoaderCircle } from 'lucide-react'
import { cn } from '../../lib/utils.ts'

// D2 buttons (ADR-0023 sections 2-3). `primary` is the one filled blue button per view. Focus is drawn
// by the global :focus-visible rule in styles/app.css, so no ring classes here.
const buttonVariants = cva(
  'relative inline-flex max-w-full min-w-0 shrink-0 items-center justify-center gap-1.5 rounded-ctl font-semibold whitespace-nowrap transition-colors duration-(--duration-quick) ease-out disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-busy:cursor-progress [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground shadow-e1 hover:bg-brand-strong [.dark_&]:hover:bg-primary',
        secondary: 'border border-border bg-surface text-fg hover:bg-secondary',
        ghost: 'text-muted hover:bg-secondary hover:text-fg',
        danger: 'bg-fail text-surface',
        'danger-soft': 'border border-fail/40 bg-fail-soft text-fail-text',
        'on-move': 'bg-move-fg text-move shadow-e1',
      },
      size: {
        sm: 'h-8 px-3 text-meta pointer-coarse:h-10 [&_svg]:size-3.5',
        md: 'h-9 px-3.5 text-meta [&_svg]:size-3.5',
        lg: 'h-10 px-4 text-ui [&_svg]:size-4',
        icon: 'size-9 text-meta [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft' | 'on-move'

type BaseProps = Omit<React.ComponentProps<'button'>, 'aria-disabled'> & {
  variant?: Variant
  asChild?: boolean
  /** The action is under way: keeps the label, swaps the leading icon for a spinner and ignores clicks. */
  busy?: boolean
  /** Stays focusable but does nothing; describe why with a Hint through aria-describedby. */
  'aria-disabled'?: boolean | 'true' | 'false'
  /** A leading lucide icon. Pass one to a button that can go busy, so the spinner keeps its width. */
  icon?: React.ReactNode
  /** A trailing lucide icon, outside the truncating label. */
  iconEnd?: React.ReactNode
}

// An icon-only button has no visible name, so its type requires one.
export type ButtonProps =
  | (BaseProps & { size?: 'sm' | 'md' | 'lg' })
  | (BaseProps & { size: 'icon'; 'aria-label': string })

const inert = (v: BaseProps['aria-disabled']) => v === true || v === 'true'

// A plain function component with no hooks: the guards below are ordinary handlers.
export function Button(props: ButtonProps) {
  const {
    className,
    variant,
    size,
    asChild = false,
    busy = false,
    icon,
    iconEnd,
    type,
    children,
    onClick,
    onKeyDown,
    onKeyUp,
    ...rest
  } = props
  const blocked = busy || inert(props['aria-disabled'])
  const guard = <E extends React.SyntheticEvent>(fn?: (e: E) => void) =>
    (e: E) => {
      if (blocked) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      fn?.(e)
    }
  const guardKey = (fn?: (e: React.KeyboardEvent<HTMLButtonElement>) => void) =>
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (blocked && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      fn?.(e)
    }
  const classes = cn(buttonVariants({ variant, size }), className)
  const handlers = {
    onClick: guard(onClick),
    onKeyDown: guardKey(onKeyDown),
    onKeyUp: guardKey(onKeyUp),
    'aria-busy': busy || undefined,
  }
  if (asChild) {
    return (
      <Slot className={classes} {...rest} {...handlers}>
        {children}
      </Slot>
    )
  }
  const lead = busy ? <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" /> : icon
  return (
    <button type={type ?? 'button'} className={classes} {...rest} {...handlers}>
      {lead}
      {size === 'icon' ? (busy ? null : children) : children != null && <span className="min-w-0 truncate">{children}</span>}
      {iconEnd}
    </button>
  )
}

export { buttonVariants }
