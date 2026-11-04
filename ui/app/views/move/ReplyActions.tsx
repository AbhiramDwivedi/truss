// The two-line Approve and Deny buttons of an approval ask (ADR-0028 section 2): the word and icon on the
// first line, what the press sends on the second, so the name starts with the word and ends with the hint.
import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { cn } from '../../lib/utils.ts'

export const APPROVE_HINT = 'Sends: Approved.'
export const DENY_HINT = 'Sends: Not approved.'

interface DecisionButtonProps {
  kind: 'allow' | 'deny'
  hero: boolean
  /** The filled look: only Approve, and only while the reply box is empty. */
  primary: boolean
  busy: boolean
  disabled: boolean
  onPress: () => void
}

export function DecisionButton({ kind, hero, primary, busy, disabled, onPress }: DecisionButtonProps) {
  const allow = kind === 'allow'
  const variant = primary ? (hero ? 'on-move' : 'primary') : hero ? 'ghost' : 'secondary'
  const quiet = !primary && hero ? 'border border-move-line text-move-fg hover:bg-move-fg/10 hover:text-move-fg' : undefined
  const line: ReactNode = (
    <span className="flex min-w-0 flex-col items-start text-left">
      <span>{allow ? 'Approve' : 'Deny'}</span>{' '}
      <span className={cn('text-micro font-normal whitespace-normal', hero ? (primary ? 'text-move' : 'text-move-muted') : primary ? 'text-primary-foreground' : 'text-muted')}>
        {allow ? APPROVE_HINT : DENY_HINT}
      </span>
    </span>
  )
  return (
    <Button
      variant={variant}
      className={cn('h-auto min-h-10 py-2 transition-none max-sm:w-full max-sm:justify-start pointer-coarse:min-h-11', quiet)}
      busy={busy}
      disabled={disabled}
      icon={allow ? <Check aria-hidden="true" /> : <X aria-hidden="true" />}
      onClick={onPress}
    >
      {busy ? 'Sending…' : line}
    </Button>
  )
}
