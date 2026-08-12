import { buildSparkline } from '@/lib/analytics/sparkline'

interface StatTileProps {
  label: string
  value: string
  hint?: string
  /** Position in its grid, used only to stagger the entrance animation. */
  index?: number
  /**
   * Optional daily series rendered as a thin sparkline under the value —
   * gives the number a shape instead of sitting alone in a box. Decorative:
   * the tile's own label is already the accessible name, so the chart is
   * `aria-hidden`. Omit for a snapshot count that has no daily series
   * (e.g. "active campaigns").
   */
  trend?: number[]
  /** CSS colour expression for the trend line. Defaults to the primary token. */
  trendColor?: string
}

// Caps the stagger so a tile far down a long grid never waits noticeably
// longer than one at the top — the reveal should read as "together," not "in order."
const MAX_STAGGER_STEPS = 8
const STAGGER_STEP_MS = 40
const TREND_COLOR_DEFAULT = 'var(--primary)'

export function StatTile({ label, value, hint, index, trend, trendColor }: StatTileProps): React.ReactElement {
  const style =
    index !== undefined ? { animationDelay: `${Math.min(index, MAX_STAGGER_STEPS) * STAGGER_STEP_MS}ms` } : undefined
  const geometry = trend && trend.length > 0 ? buildSparkline(trend) : null

  return (
    <div
      className="border-hairline bg-surface card-interactive animate-rise flex min-w-0 flex-col rounded-lg border p-4"
      style={style}
    >
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      <p className="tnum mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-faint mt-1 text-[11px] leading-snug">{hint}</p> : null}
      {geometry ? (
        <svg
          aria-hidden
          width={geometry.width}
          height={geometry.height}
          viewBox={`0 0 ${geometry.width} ${geometry.height}`}
          preserveAspectRatio="none"
          className="mt-3 block h-5 w-full"
        >
          {geometry.bars.map((bar, barIndex) => (
            <rect
              key={barIndex}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1}
              fill={trendColor ?? TREND_COLOR_DEFAULT}
              opacity={0.35 + (0.65 * (barIndex + 1)) / geometry.bars.length}
            />
          ))}
        </svg>
      ) : null}
    </div>
  )
}
