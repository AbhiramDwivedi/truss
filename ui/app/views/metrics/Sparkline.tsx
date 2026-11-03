// The Tokens tile's sparkline (D2 direction-d2.html:561-568), drawn from the client's own series of live
// stamps. Fewer than two points draw nothing, at the same height, so the tile never jumps.
const W = 112
const H = 26

export interface SparklineProps {
  series: number[]
}

export function Sparkline({ series }: SparklineProps) {
  if (series.length < 2) return <span aria-hidden="true" className="mt-1 block h-6.5" />
  const max = Math.max(...series, 1) * 1.1
  const step = W / (series.length - 1)
  const pts = series.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / max) * H).toFixed(1)}`)
  const lastY = pts.at(-1)!.split(',')[1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" className="mt-1 block h-6.5 w-full overflow-visible">
      <path d={`M0,${H} L${pts.join(' L')} L${W},${H} Z`} className="fill-brand/10" />
      <polyline points={pts.join(' ')} fill="none" className="stroke-brand" strokeWidth={1.5} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={W} cy={lastY} r={2.5} className="fill-brand" />
    </svg>
  )
}
