'use client'

import { useId, useState } from 'react'

export interface ChartSeries {
  label: string
  color: string
  values: number[]
}

export interface ChartGeometry {
  width: number
  height: number
  gridLines: { y: number; value: number }[]
  paths: { color: string; d: string }[]
  xLabels: { x: number; label: string }[]
  // One entry per x-axis data index, carrying every series' value at that
  // index in series order — the crosshair/tooltip hover layer reads from
  // this rather than re-deriving it, so hover and the static render can
  // never disagree (dataviz skill, interaction.md: "one tooltip, every
  // series").
  points: { x: number; label: string; values: number[] }[]
  // The last plotted (x, y) per series, in the same coordinate space as
  // `paths` — computed with the identical xFor/yFor used for the line
  // itself, so the end-dot marker can never drift from where its line
  // actually ends.
  seriesEndPoints: { color: string; x: number; y: number }[]
}

const CHART_WIDTH = 640
const CHART_HEIGHT = 200
const PADDING_LEFT = 36
const PADDING_BOTTOM = 20
const PADDING_TOP = 12
const GRID_LINE_COUNT = 4
// Caps rendered x-axis labels so a ~30-point monthly series doesn't collide
// into unreadable overlapping text; a 7-point weekly series keeps every label.
const MAX_X_LABELS = 7
// Mark specs from the dataviz skill (marks-and-anatomy.md): 2px line,
// >=8px (r>=4) end markers with a 2px surface-color ring.
const LINE_WIDTH = 2
const END_MARKER_RADIUS = 4
const END_MARKER_RING_WIDTH = 2

export function buildChartGeometry(series: readonly ChartSeries[], xLabels: readonly string[]): ChartGeometry {
  const plotWidth = CHART_WIDTH - PADDING_LEFT
  const plotHeight = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM
  const allValues = series.flatMap((s) => s.values)
  const max = Math.max(1, ...allValues)
  const pointCount = xLabels.length

  const xFor = (index: number): number =>
    pointCount <= 1 ? PADDING_LEFT : PADDING_LEFT + (index / (pointCount - 1)) * plotWidth
  const yFor = (value: number): number => PADDING_TOP + plotHeight - (value / max) * plotHeight

  const paths = series.map((s) => ({
    color: s.color,
    d: s.values
      .map((value, index) => `${index === 0 ? 'M' : 'L'} ${xFor(index).toFixed(1)} ${yFor(value).toFixed(1)}`)
      .join(' '),
  }))

  const lastIndex = pointCount - 1
  const seriesEndPoints = lastIndex >= 0
    ? series.map((s) => ({ color: s.color, x: xFor(lastIndex), y: yFor(s.values[lastIndex] ?? 0) }))
    : []

  const gridLines = Array.from({ length: GRID_LINE_COUNT + 1 }, (_, i) => {
    const value = Math.round((max / GRID_LINE_COUNT) * i)
    return { y: yFor(value), value }
  })

  const labelStep = Math.max(1, Math.ceil(pointCount / MAX_X_LABELS))
  const xLabelPoints = xLabels
    .map((label, index) => ({ x: xFor(index), label, index }))
    .filter((point) => point.index % labelStep === 0)
    .map(({ x, label }) => ({ x, label }))

  const points = xLabels.map((label, index) => ({
    x: xFor(index),
    label,
    values: series.map((s) => s.values[index] ?? 0),
  }))

  return { width: CHART_WIDTH, height: CHART_HEIGHT, gridLines, paths, xLabels: xLabelPoints, points, seriesEndPoints }
}

interface ReportChartProps {
  title: string
  series: readonly ChartSeries[]
  xLabels: readonly string[]
  /** Shown when every series is entirely zero — a brand-new client's first report. */
  emptyLabel: string
}

export function ReportChart({ title, series, xLabels, emptyLabel }: ReportChartProps): React.ReactElement {
  const geometry = buildChartGeometry(series, xLabels)
  const hasData = series.some((s) => s.values.some((v) => v > 0))
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const chartId = useId()

  const hoveredPoint = hoverIndex !== null ? geometry.points[hoverIndex] : null

  function indexForClientX(svg: SVGSVGElement, clientX: number): number {
    const rect = svg.getBoundingClientRect()
    const ratio = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
    const svgX = ratio * geometry.width
    let nearest = 0
    let nearestDistance = Infinity
    geometry.points.forEach((point, index) => {
      const distance = Math.abs(point.x - svgX)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearest = index
      }
    })
    return nearest
  }

  function moveHover(delta: number): void {
    setHoverIndex((current) => {
      const base = current ?? geometry.points.length - 1
      return Math.min(geometry.points.length - 1, Math.max(0, base + delta))
    })
  }

  return (
    <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        {/* A legend is always present for 2+ series — the dependable identity
            channel; a single series needs none, since the title already says
            what's plotted (dataviz skill, marks-and-anatomy.md). Line-key
            swatches (a short stroke), not boxes — this is a line chart. */}
        {series.length > 1 ? (
          <div className="flex flex-wrap items-center gap-3">
            {series.map((s) => (
              <span key={s.label} className="text-muted-foreground flex items-center gap-1.5 text-xs">
                <svg width="12" height="4" aria-hidden>
                  <line x1={0} y1={2} x2={12} y2={2} stroke={s.color} strokeWidth={LINE_WIDTH} strokeLinecap="round" />
                </svg>
                {s.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {!hasData ? (
        <p className="text-faint py-10 text-center text-sm">{emptyLabel}</p>
      ) : (
        <div className="relative">
          <svg
            role="img"
            aria-label={title}
            aria-describedby={hoveredPoint ? `${chartId}-tooltip` : undefined}
            width="100%"
            height={geometry.height}
            viewBox={`0 0 ${geometry.width} ${geometry.height}`}
            preserveAspectRatio="none"
            className="overflow-visible focus-visible:outline-none"
            tabIndex={0}
            onPointerMove={(event) => setHoverIndex(indexForClientX(event.currentTarget, event.clientX))}
            onPointerLeave={() => setHoverIndex(null)}
            onFocus={() => setHoverIndex((current) => current ?? geometry.points.length - 1)}
            onBlur={() => setHoverIndex(null)}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
              event.preventDefault()
              moveHover(event.key === 'ArrowLeft' ? -1 : 1)
            }}
          >
            {geometry.gridLines.map((line) => (
              <g key={line.value}>
                <line x1={PADDING_LEFT} y1={line.y} x2={geometry.width} y2={line.y} stroke="var(--border)" strokeWidth={1} />
                <text x={0} y={line.y + 3} fontSize={10} fill="var(--muted-foreground)">
                  {line.value}
                </text>
              </g>
            ))}
            {/* Crosshair — a vertical hairline that tracks the pointer/focus
                and snaps to the nearest data position (dataviz skill,
                interaction.md: "the crosshair finds the X"). */}
            {hoveredPoint ? (
              <line
                x1={hoveredPoint.x}
                y1={PADDING_TOP}
                x2={hoveredPoint.x}
                y2={geometry.height - PADDING_BOTTOM}
                stroke="var(--muted-foreground)"
                strokeWidth={1}
                strokeDasharray="2 2"
              />
            ) : null}
            {geometry.paths.map((path) => (
              <path key={path.color} d={path.d} fill="none" stroke={path.color} strokeWidth={LINE_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
            ))}
            {geometry.seriesEndPoints.map((point) => (
              <circle
                key={point.color}
                cx={point.x}
                cy={point.y}
                r={END_MARKER_RADIUS}
                fill={point.color}
                stroke="var(--surface)"
                strokeWidth={END_MARKER_RING_WIDTH}
              />
            ))}
            {geometry.xLabels.map((point) => (
              <text
                key={point.label}
                x={point.x}
                y={geometry.height - 4}
                fontSize={10}
                fill="var(--muted-foreground)"
                textAnchor="middle"
              >
                {point.label}
              </text>
            ))}
          </svg>
          {hoveredPoint ? (
            <div
              id={`${chartId}-tooltip`}
              role="status"
              aria-live="polite"
              className="border-hairline-strong bg-popover text-popover-foreground pointer-events-none absolute top-2 z-10 flex flex-col gap-1 rounded-md border px-2.5 py-2 text-xs shadow-sm"
              style={{ left: `${Math.min(88, Math.max(2, (hoveredPoint.x / geometry.width) * 100))}%` }}
            >
              <span className="text-muted-foreground font-medium">{hoveredPoint.label}</span>
              {series.map((s, index) => (
                <span key={s.label} className="flex items-center gap-1.5">
                  <svg width="10" height="2" aria-hidden>
                    <line x1={0} y1={1} x2={10} y2={1} stroke={s.color} strokeWidth={LINE_WIDTH} />
                  </svg>
                  {/* Value leads (bold, high-contrast); series name follows,
                      secondary — the tooltip inverts the legend's hierarchy
                      because here the reader already has the series and
                      wants the number (dataviz skill, interaction.md). */}
                  <span className="font-medium">{hoveredPoint.values[index]}</span>
                  <span className="text-muted-foreground">{s.label}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
