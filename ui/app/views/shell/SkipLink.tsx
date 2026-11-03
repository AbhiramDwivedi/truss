// The first Tab stop (ADR-0023 section 4): hidden until focused, it jumps to Your move.
export function SkipLink() {
  return (
    <a
      href="#your-move"
      className="sr-only rounded-ctl bg-surface px-3 py-2 text-ui font-semibold text-fg shadow-e1 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
    >
      Skip to Your move
    </a>
  )
}
