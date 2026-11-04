// One row of the Deliverables list (D2 :762-769). An openable item is a button whose name is its title only, so
// the page keeps one button per crew slug; the crew and path sit beside it as aria-describedby meta in mono.
// A pending item is plain text: it says when it arrives and offers nothing to open.
import { useState } from 'react'
import { Box, Clock, FileText, Image, Layers } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { hhmm } from '../rail/format.ts'

export type DeliverableType = 'docs' | 'code' | 'plan' | 'images'

export type DeliverablePreview =
  | { kind: 'text'; text: string }
  | { kind: 'image'; ref: string; path: string }
  | { kind: 'code'; branch: string; owns: string[] }

export interface Deliverable {
  id: string
  type: DeliverableType
  title: string
  path: string
  /** The crew that built it, or null for run inputs. */
  crew: string | null
  /** The stage that built it, or null for run inputs. */
  stage: number | null
  time: string | null
  /** An image whose crew has not merged: nothing to open yet. */
  pending: boolean
  preview: DeliverablePreview
}

/** Copy a path to the clipboard; `copied` is the polite status line ("Copied …" or why it failed). */
export function useCopy(path: string): { copied: string | null; copy: () => void } {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = () => {
    const done = (ok: boolean) => setCopied(ok ? `Copied ${path}` : 'Not copied: the browser blocked the clipboard.')
    try {
      const w = navigator.clipboard?.writeText(path)
      if (w) w.then(() => done(true), () => done(false))
      else done(false)
    } catch {
      done(false)
    }
  }
  return { copied, copy }
}

export const TYPE_LABEL: Record<DeliverableType, string> = { docs: 'Docs', code: 'Code', plan: 'Plan', images: 'Images' }

const TYPE_ICON: Record<DeliverableType, typeof Box> = { docs: FileText, code: Box, plan: Layers, images: Image }

export interface DeliverableItemProps {
  item: Deliverable
  selected: boolean
  onOpen: (item: Deliverable, opener: HTMLButtonElement) => void
}

export function DeliverableItem({ item, selected, onOpen }: DeliverableItemProps) {
  const Icon = item.pending ? Clock : TYPE_ICON[item.type]
  const metaId = `deliverable-meta-${item.id.replace(/[^A-Za-z0-9_-]/g, '-')}`
  const time = hhmm(item.time)
  const tile = (
    <span
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-ctl',
        item.pending ? 'border border-dashed border-border-strong text-muted' : 'bg-brand-soft text-brand-strong',
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </span>
  )
  const meta = (
    <span id={metaId} className="block min-w-0 truncate font-mono text-micro text-muted" title={item.path}>
      {item.crew ? `${item.crew}, ` : ''}
      {item.path}
    </span>
  )
  if (item.pending) {
    return (
      <li className="flex min-w-0 items-start gap-3 rounded-ctl px-2.5 py-2">
        {tile}
        <div className="min-w-0 flex-1">
          <p className="truncate text-ui font-semibold text-muted" title={item.title}>
            {item.title}
          </p>
          {meta}
          <p className="mt-0.5 text-meta break-words text-muted">
            Arrives when {item.crew ?? 'its crew'} merges. Nothing to open yet.
          </p>
        </div>
      </li>
    )
  }
  return (
    <li
      className={cn(
        'relative flex min-w-0 items-center gap-3 rounded-ctl px-2.5 py-2 transition-colors duration-(--duration-quick) ease-out',
        selected ? 'bg-brand-soft ring-1 ring-brand-line' : 'hover:bg-secondary',
      )}
    >
      {tile}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          aria-describedby={metaId}
          aria-current={selected ? 'true' : undefined}
          title={item.title}
          onClick={(e) => onOpen(item, e.currentTarget)}
          className="block min-h-6 max-w-full min-w-0 truncate rounded-chip text-left text-ui leading-6 font-semibold text-fg after:absolute after:inset-0 after:content-['']"
        >
          {item.title}
        </button>
        {meta}
      </div>
      {time && <span className="shrink-0 font-mono text-micro tabular-nums text-muted">{time}</span>}
    </li>
  )
}
