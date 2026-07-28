import { describe, it, expect } from 'vitest'
import type { ClientResourceRow } from '@/lib/db/client-resources'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'
import {
  MAX_RESOURCE_MENU,
  applyAttachmentBudget,
  buildResourceMenu,
  formatResourceMenu,
  resolveAttachments,
} from './menu'

function resource(id: string, overrides: Partial<ClientResourceRow> = {}): ClientResourceRow {
  return {
    id,
    client_id: 'c1',
    title: `Title ${id}`,
    description: `Description ${id}`,
    file_name: `${id}.pdf`,
    mime_type: 'application/pdf',
    byte_size: 1000,
    storage_path: `c1/${id}.pdf`,
    is_active: true,
    created_by: 'u1',
    created_at: '2026-07-26T00:00:00Z',
    ...overrides,
  }
}

describe('buildResourceMenu', () => {
  it('should number entries from 1 in the order given', () => {
    const menu = buildResourceMenu([resource('a'), resource('b')])
    expect(menu.map((e) => e.ordinal)).toEqual([1, 2])
    expect(menu.map((e) => e.resource.id)).toEqual(['a', 'b'])
  })

  it('should cap the menu at MAX_RESOURCE_MENU entries', () => {
    const resources = Array.from({ length: MAX_RESOURCE_MENU + 10 }, (_, i) => resource(`r${i}`))
    expect(buildResourceMenu(resources)).toHaveLength(MAX_RESOURCE_MENU)
  })

  it('should return an empty menu when there are no resources', () => {
    expect(buildResourceMenu([])).toEqual([])
  })
})

describe('formatResourceMenu', () => {
  it('should return an empty string when the menu is empty', () => {
    expect(formatResourceMenu([])).toBe('')
  })

  it('should render one line per entry as ordinal, title and description', () => {
    const text = formatResourceMenu(buildResourceMenu([resource('a'), resource('b')]))
    expect(text).toContain('1 — Title a — Description a')
    expect(text).toContain('2 — Title b — Description b')
  })

  it('should collapse line breaks inside a description onto one line', () => {
    const text = formatResourceMenu(
      buildResourceMenu([resource('a', { description: 'first\nsecond' })]),
    )
    expect(text).toContain('1 — Title a — first second')
    expect(text.split('\n').filter((line) => line.startsWith('1 —'))).toHaveLength(1)
  })
})

describe('applyAttachmentBudget', () => {
  it('should keep everything that fits and report nothing dropped', () => {
    const result = applyAttachmentBudget([resource('a'), resource('b')])

    expect(result.resources.map((r) => r.id)).toEqual(['a', 'b'])
    expect(result.droppedResourceIds).toEqual([])
    expect(result.totalBytes).toBe(2000)
  })

  it('should drop past the count ceiling in the order given', () => {
    const many = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 2 }, (_, i) => resource(`r${i}`))

    const result = applyAttachmentBudget(many)

    expect(result.resources).toHaveLength(MAX_ATTACHMENTS_PER_EMAIL)
    expect(result.droppedResourceIds).toEqual([
      `r${MAX_ATTACHMENTS_PER_EMAIL}`,
      `r${MAX_ATTACHMENTS_PER_EMAIL + 1}`,
    ])
  })

  it('should drop the entry that would breach the byte budget and keep looking', () => {
    const result = applyAttachmentBudget([
      resource('big', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES }),
      resource('huge', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES }),
      resource('tiny', { byte_size: 1 }),
    ])

    // 'tiny' still cannot fit — 'big' already spent the whole budget.
    expect(result.resources.map((r) => r.id)).toEqual(['big'])
    expect(result.droppedResourceIds).toEqual(['huge', 'tiny'])
    expect(result.totalBytes).toBe(MAX_TOTAL_ATTACHMENT_BYTES)
  })

  it('should return an empty result for an empty candidate list', () => {
    expect(applyAttachmentBudget([])).toEqual({
      resources: [], droppedResourceIds: [], totalBytes: 0,
    })
  })
})

describe('resolveAttachments', () => {
  const menu = buildResourceMenu([resource('a'), resource('b'), resource('c'), resource('d')])

  it('should resolve ordinals to their resources when all are valid', () => {
    const result = resolveAttachments(menu, [1, 3])
    expect(result.resources.map((r) => r.id)).toEqual(['a', 'c'])
    expect(result.droppedResourceIds).toEqual([])
    expect(result.totalBytes).toBe(2000)
  })

  it('should return nothing when the model picked nothing', () => {
    expect(resolveAttachments(menu, [])).toEqual({ resources: [], droppedResourceIds: [], totalBytes: 0 })
  })

  it('should return nothing when the menu is empty', () => {
    expect(resolveAttachments([], [1, 2])).toEqual({ resources: [], droppedResourceIds: [], totalBytes: 0 })
  })

  it('should ignore an ordinal the model hallucinated', () => {
    const result = resolveAttachments(menu, [1, 99, 0, -1])
    expect(result.resources.map((r) => r.id)).toEqual(['a'])
    expect(result.droppedResourceIds).toEqual([])
  })

  it('should ignore a repeated ordinal', () => {
    const result = resolveAttachments(menu, [2, 2, 2])
    expect(result.resources.map((r) => r.id)).toEqual(['b'])
  })

  it('should drop the overflow when more than MAX_ATTACHMENTS_PER_EMAIL are picked', () => {
    const result = resolveAttachments(menu, [1, 2, 3, 4])
    expect(result.resources).toHaveLength(MAX_ATTACHMENTS_PER_EMAIL)
    expect(result.resources.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(result.droppedResourceIds).toEqual(['d'])
  })

  it('should drop a resource that would breach the byte budget and keep going', () => {
    const big = buildResourceMenu([
      resource('big', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES - 100 }),
      resource('huge', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES }),
      resource('small', { byte_size: 50 }),
    ])
    const result = resolveAttachments(big, [1, 2, 3])
    expect(result.resources.map((r) => r.id)).toEqual(['big', 'small'])
    expect(result.droppedResourceIds).toEqual(['huge'])
    expect(result.totalBytes).toBe(MAX_TOTAL_ATTACHMENT_BYTES - 50)
  })

  it('should keep a resource sized exactly at the budget', () => {
    const exact = buildResourceMenu([resource('x', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES })])
    const result = resolveAttachments(exact, [1])
    expect(result.resources.map((r) => r.id)).toEqual(['x'])
    expect(result.droppedResourceIds).toEqual([])
  })
})
