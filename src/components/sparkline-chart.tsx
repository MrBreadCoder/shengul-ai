import { getTranslations } from 'next-intl/server'
import { buildSparkline } from '@/lib/analytics/sparkline'

interface SparklineChartProps {
  title: string
  values: number[]
  /** CSS colour expression, taken from the status palette by the caller. */
  color: string
  total: string
  /** Position among its sibling charts, used only to stagger the entrance animation. */
  index?: number
}

const STAGGER_STEP_MS = 40

export async function SparklineChart({
  title,
  values,
  color,
  total,
  index,
}: SparklineChartProps): Promise<React.ReactElement> {
  const t = await getTranslations('analytics')
  const { width, height, max, bars } = buildSparkline(values)
  const style = index !== undefined ? { animationDelay: `${index * STAGGER_STEP_MS}ms` } : undefined

  return (
    <div className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4" style={style}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground truncate text-xs">{title}</span>
        <span className="tnum text-lg font-semibold tracking-tight">{total}</span>
      </div>

      {bars.length === 0 ? (
        <p className="text-faint mt-3 text-xs">{t('sparkline.noData')}</p>
      ) : (
        <svg
          role="img"
          aria-label={t('sparkline.ariaLabel', { title, total, days: bars.length, max })}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="mt-3 block h-12 w-full"
        >
          {bars.map((bar, index) => (
            <rect
              key={`${title}-${index}`}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1}
              fill={color}
              // Recent days read stronger than the tail of the window.
              opacity={0.45 + (0.55 * (index + 1)) / bars.length}
            />
          ))}
        </svg>
      )}

      <p className="text-faint tnum mt-2 text-[11px]">
        {t('sparkline.peakLabel', { max, days: bars.length })}
      </p>
    </div>
  )
}
