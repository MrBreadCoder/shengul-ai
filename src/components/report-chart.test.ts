import { describe, it, expect } from 'vitest'
import { buildChartGeometry } from './report-chart'

describe('buildChartGeometry', () => {
  it('should produce one gridline per configured step plus the zero line', () => {
    const geometry = buildChartGeometry([{ label: 'A', color: 'red', values: [1, 2, 3] }], ['d1', 'd2', 'd3'])
    expect(geometry.gridLines.length).toBe(5)
    expect(geometry.gridLines[0]!.value).toBe(0)
  })

  it('should produce one SVG path per series, starting with M and using L for the rest', () => {
    const geometry = buildChartGeometry(
      [
        { label: 'A', color: 'red', values: [1, 2, 3] },
        { label: 'B', color: 'blue', values: [3, 2, 1] },
      ],
      ['d1', 'd2', 'd3'],
    )
    expect(geometry.paths.length).toBe(2)
    expect(geometry.paths[0]!.d.startsWith('M ')).toBe(true)
    expect(geometry.paths[0]!.d).toContain('L ')
  })

  it('should not crash on an all-zero series', () => {
    const geometry = buildChartGeometry([{ label: 'A', color: 'red', values: [0, 0, 0] }], ['d1', 'd2', 'd3'])
    expect(geometry.paths[0]!.d).toBeTruthy()
  })

  it('should thin x-axis labels for a long (monthly, ~30-point) series', () => {
    const values = Array.from({ length: 30 }, (_, i) => i)
    const labels = values.map((_, i) => `d${i}`)
    const geometry = buildChartGeometry([{ label: 'A', color: 'red', values }], labels)
    expect(geometry.xLabels.length).toBeLessThan(30)
    expect(geometry.xLabels.length).toBeGreaterThan(1)
  })

  it('should keep every x-axis label for a short (weekly, 7-point) series', () => {
    const values = [1, 2, 3, 4, 5, 6, 7]
    const labels = values.map((_, i) => `d${i}`)
    const geometry = buildChartGeometry([{ label: 'A', color: 'red', values }], labels)
    expect(geometry.xLabels.length).toBe(7)
  })

  it('should produce one hover point per data index carrying every series value at that x', () => {
    const geometry = buildChartGeometry(
      [
        { label: 'A', color: 'red', values: [1, 2, 3] },
        { label: 'B', color: 'blue', values: [3, 2, 1] },
      ],
      ['d1', 'd2', 'd3'],
    )
    expect(geometry.points.length).toBe(3)
    expect(geometry.points[1]).toMatchObject({ label: 'd2', values: [2, 2] })
  })
})
