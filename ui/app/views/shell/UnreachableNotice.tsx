// The 20 s stuck-connection notice. The Banner renders it in its reserved notice room, with Reload inline on the
// right, so nothing in main or the rail moves when it appears.
import { RotateCw } from 'lucide-react'
import { Button } from '../../components/ui/button.tsx'
import { Notice } from '../../components/ui/notice.tsx'

export function UnreachableNotice() {
  return (
    <div role="alert" className="flex min-w-0 items-center gap-2">
      <Notice tone="fail" live="off" className="min-w-0 flex-1 py-1 text-meta">
        Can&apos;t reach the truss UI server. Check it is still running, then reload.
      </Notice>
      <Button
        size="sm"
        variant="secondary"
        className="shrink-0 min-h-6 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        icon={<RotateCw aria-hidden="true" />}
        onClick={() => location.reload()}
      >
        Reload
      </Button>
    </div>
  )
}
