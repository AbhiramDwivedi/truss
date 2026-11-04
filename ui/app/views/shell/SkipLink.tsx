// The first Tab stop (ADR-0023 section 4): hidden until focused, it jumps past the header. App passes the
// target that exists at the current width; the default is Your move.
export interface SkipLinkProps {
  href?: string
}

export function SkipLink({ href = '#your-move' }: SkipLinkProps) {
  return (
    <a
      href={href}
      className="sr-only rounded-ctl bg-surface px-3 py-2 text-ui font-semibold text-fg shadow-e1 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to Your move
    </a>
  )
}
