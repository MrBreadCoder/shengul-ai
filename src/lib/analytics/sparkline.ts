// Geometry for the inline-SVG bar chart. Kept as pure math so it is unit
// testable without a DOM — the component in src/app/analytics is a thin
// <rect> renderer over this output.
export const SPARKLINE_HEIGHT = 48
const BAR_WIDTH = 8
const BAR_GAP = 2
// A zero day still draws a 1px baseline so gaps in the series stay visible.
const MIN_BAR_HEIGHT = 1

export interface SparkBar {
  x: number
  y: number
  width: number
  height: number
}

export interface SparklineGeometry {
  width: number
  height: number
  max: number
  bars: SparkBar[]
}

export function buildSparkline(values: readonly number[]): SparklineGeometry {
  const safeValues = values.map((value) => (value > 0 ? value : 0))
  const max = safeValues.reduce((highest, value) => (value > highest ? value : highest), 0)
  const width =
    safeValues.length === 0 ? 0 : safeValues.length * BAR_WIDTH + (safeValues.length - 1) * BAR_GAP

  const bars = safeValues.map((value, index) => {
    const scaled = max === 0 ? 0 : Math.round((value / max) * SPARKLINE_HEIGHT)
    const height = Math.max(MIN_BAR_HEIGHT, scaled)
    return {
      x: index * (BAR_WIDTH + BAR_GAP),
      y: SPARKLINE_HEIGHT - height,
      width: BAR_WIDTH,
      height,
    }
  })

  return { width, height: SPARKLINE_HEIGHT, max, bars }
}
