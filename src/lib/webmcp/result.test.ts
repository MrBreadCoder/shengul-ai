import { describe, expect, it } from 'vitest'
import { errorResult, jsonResult, textResult } from '@/lib/webmcp/result'

describe('textResult', () => {
  it('should wrap prose in a single text content part', () => {
    expect(textResult('hello')).toEqual({ content: [{ type: 'text', text: 'hello' }] })
  })

  it('should not mark a successful result as an error', () => {
    expect(textResult('hello').isError).toBeUndefined()
  })
})

describe('jsonResult', () => {
  it('should serialise structured data into a text content part', () => {
    expect(jsonResult({ total: 2, names: ['a', 'b'] })).toEqual({
      content: [{ type: 'text', text: '{"total":2,"names":["a","b"]}' }],
    })
  })

  it('should serialise an empty collection without collapsing it to nothing', () => {
    expect(jsonResult({ total: 0, items: [] }).content[0]?.text).toBe('{"total":0,"items":[]}')
  })
})

describe('errorResult', () => {
  it('should flag the result so the agent can correct itself', () => {
    expect(errorResult('bad input')).toEqual({
      content: [{ type: 'text', text: 'bad input' }],
      isError: true,
    })
  })
})
