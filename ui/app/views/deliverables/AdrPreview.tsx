// One ADR's fields, read in the deliverable preview when the timeline opens it (ADR-0028 section 3). Reading, not a
// second list: no body field. A field the record lacks leaves its row out; a missing summary says so.
import { ArrowLeft, Copy } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { Badge } from '../../components/ui/badge.tsx'
import type { Adr } from '../../store/types.ts'
import { cap } from '../rail/format.ts'
import { TONE, kindOf } from '../decisions/AdrSection.tsx'
import { useCopy } from './DeliverableItem.tsx'

export interface AdrPreviewProps {
  adr: Adr
  /** "Back to the list": the caller returns focus to the timeline item that opened this. */
  onBack: () => void
}

export function AdrPreview({ adr, onBack }: AdrPreviewProps) {
  const { copied, copy } = useCopy(adr.file)
  const kind = kindOf(adr.status)
  const links = adr.links ?? []
  return (
    <div className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="brand" size="sm">
          ADR
        </Badge>
        <Badge tone={TONE[kind]} size="sm">
          {kind === 'unstated' ? 'Status not stated' : cap(kind)}
        </Badge>
      </div>
      <h3 tabIndex={-1} className="mt-2 text-lead font-semibold break-words text-fg">
        {adr.title}
      </h3>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-meta">
        {adr.number != null && (
          <>
            <dt className="text-muted">Number</dt>
            <dd className="font-mono tabular-nums text-fg">{String(adr.number).padStart(4, '0')}</dd>
          </>
        )}
        {adr.date && (
          <>
            <dt className="text-muted">Date</dt>
            <dd className="font-mono tabular-nums text-fg">{adr.date}</dd>
          </>
        )}
        {adr.decidedBy && (
          <>
            <dt className="text-muted">Decided by</dt>
            <dd className="break-words text-fg">{adr.decidedBy}</dd>
          </>
        )}
        {links.length > 0 && (
          <>
            <dt className="text-muted">Links</dt>
            <dd className="flex flex-wrap gap-1">
              {links.map((l) => (
                <Badge key={`${l.kind}-${l.n}`} size="sm">
                  {l.kind.replace('-', ' ')} {String(l.n).padStart(4, '0')}
                </Badge>
              ))}{' '}
            </dd>
          </>
        )}
        <dt className="text-muted">Path</dt>
        <dd className="font-mono break-all text-fg">{adr.file}</dd>
      </dl>
      <p className="mt-3 text-ui break-words text-fg">{adr.summary || 'No summary recorded.'}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" icon={<Copy aria-hidden="true" />} onClick={copy}>
          Copy path
        </Button>
        <Button variant="ghost" size="sm" icon={<ArrowLeft aria-hidden="true" />} onClick={onBack}>
          Back to the list
        </Button>
      </div>
      <p role="status" className="mt-2 min-h-4 text-meta text-muted">
        {copied}
      </p>
    </div>
  )
}
