import { describe, it, expect } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  it('should render bytes below a kilobyte as B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('should render kilobytes without a decimal', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('2 KB')
  })

  it('should render megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(2.7 * 1024 * 1024)).toBe('2.7 MB')
  })
})
