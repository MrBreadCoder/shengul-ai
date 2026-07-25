import { describe, it, expect } from 'vitest'
import { buildSparkline, SPARKLINE_HEIGHT } from './sparkline'

describe('buildSparkline', () => {
  it('should produce no bars and zero width when there are no values', () => {
    const geometry = buildSparkline([])
    expect(geometry.bars).toEqual([])
    expect(geometry.width).toBe(0)
    expect(geometry.max).toBe(0)
  })

  it('should scale the tallest bar to the full chart height', () => {
    const geometry = buildSparkline([0, 5, 10])
    expect(geometry.max).toBe(10)
    expect(geometry.bars[2]?.height).toBe(SPARKLINE_HEIGHT)
    expect(geometry.bars[2]?.y).toBe(0)
  })

  it('should scale intermediate bars proportionally', () => {
    const geometry = buildSparkline([0, 5, 10])
    expect(geometry.bars[1]?.height).toBe(SPARKLINE_HEIGHT / 2)
  })

  it('should give zero values a minimum-height baseline bar', () => {
    const geometry = buildSparkline([0, 10])
    expect(geometry.bars[0]?.height).toBe(1)
    expect(geometry.bars[0]?.y).toBe(SPARKLINE_HEIGHT - 1)
  })

  it('should render flat baseline bars when every value is zero', () => {
    const geometry = buildSparkline([0, 0, 0])
    expect(geometry.max).toBe(0)
    expect(geometry.bars.map((bar) => bar.height)).toEqual([1, 1, 1])
  })

  it('should lay bars out left to right without overlap', () => {
    const geometry = buildSparkline([1, 2, 3])
    const xs = geometry.bars.map((bar) => bar.x)
    expect(xs[0]).toBe(0)
    expect(xs[1]).toBeGreaterThan(xs[0]! + geometry.bars[0]!.width - 1)
    expect(geometry.width).toBeGreaterThanOrEqual(xs[2]! + geometry.bars[2]!.width)
  })

  it('should clamp negative values to zero', () => {
    const geometry = buildSparkline([-4, 8])
    expect(geometry.max).toBe(8)
    expect(geometry.bars[0]?.height).toBe(1)
  })
})
