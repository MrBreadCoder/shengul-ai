import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { formatZodMessage } from './format-zod-message'

describe('formatZodMessage', () => {
  it('should render a single issue as "path: message"', () => {
    const schema = z.object({ name: z.string().min(1) })
    const result = schema.safeParse({ name: '' })
    if (result.success) throw new Error('expected parse to fail')

    expect(formatZodMessage(result.error)).toBe('name: Too small: expected string to have >=1 characters')
  })

  it('should join multiple issues with a semicolon', () => {
    const schema = z.object({ name: z.string().min(1), age: z.number().min(0) })
    const result = schema.safeParse({ name: '', age: -1 })
    if (result.success) throw new Error('expected parse to fail')

    const message = formatZodMessage(result.error)
    expect(message).toContain('name: ')
    expect(message).toContain('age: ')
    expect(message).toContain('; ')
  })

  it('should label a root-level issue as "(root)"', () => {
    const schema = z.string().refine(() => false, { message: 'always fails' })
    const result = schema.safeParse('anything')
    if (result.success) throw new Error('expected parse to fail')

    expect(formatZodMessage(result.error)).toBe('(root): always fails')
  })

  it('should cap the rendered issues and note how many were left out', () => {
    const schema = z.object({
      a: z.string().min(1),
      b: z.string().min(1),
      c: z.string().min(1),
      d: z.string().min(1),
    })
    const result = schema.safeParse({ a: '', b: '', c: '', d: '' })
    if (result.success) throw new Error('expected parse to fail')

    const message = formatZodMessage(result.error)
    expect(message.split('; ')).toHaveLength(4)
    expect(message).toContain('and 1 more')
  })
})
