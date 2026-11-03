// The preview as a bottom sheet below 1024 px (ADR-0023 section 4, D2 :823-830). The client's own markup, not a
// scroll-locking modal primitive (ADR-0018 section 1): role dialog, aria-modal, a Close button, a focus trap,
// Escape to close. The caller returns focus to the item in onClose.
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'

export interface DeliverableDialogProps {
  onClose: () => void
  children: ReactNode
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function DeliverableDialog({ onClose, children }: DeliverableDialogProps) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Focus moves into the dialog when it opens: its first control, Close.
    const first = box.current?.querySelector<HTMLElement>(FOCUSABLE)
    first?.focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab' || !box.current) return
    const all = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0)
    if (all.length === 0) {
      e.preventDefault()
      return
    }
    const first = all[0]!
    const last = all[all.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && (active === first || !box.current.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !box.current.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div aria-hidden="true" className="absolute inset-0 bg-fg/30" onClick={onClose} />
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label="Deliverable"
        onKeyDown={onKeyDown}
        className="absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-panel bg-surface text-fg shadow-hero"
      >
        <div className="flex items-center justify-between gap-2 px-4 pt-3">
          <span aria-hidden="true" className="mx-auto h-1 w-10 rounded-full bg-border-strong" />
        </div>
        <div className="absolute top-2 right-3 z-10">
          <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  )
}
