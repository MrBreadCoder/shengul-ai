import { describe, it, expect, vi, beforeEach } from 'vitest'

const getActiveResourcesByIdsMock = vi.fn()
vi.mock('@/lib/db/client-resources', () => ({
  getActiveResourcesByIds: (...a: unknown[]) => getActiveResourcesByIdsMock(...a),
}))

import { resolveSelectedResources } from './select'

const supabase = {} as never

function row(id: string, byteSize: number): Record<string, unknown> {
  return { id, client_id: 'c1', byte_size: byteSize, title: id, file_name: `${id}.pdf` }
}

beforeEach(() => {
  getActiveResourcesByIdsMock.mockReset()
})

describe('resolveSelectedResources', () => {
  it('should return [] without querying when nothing is selected', async () => {
    await expect(resolveSelectedResources(supabase, 'c1', [])).resolves.toEqual([])
    expect(getActiveResourcesByIdsMock).not.toHaveBeenCalled()
  })

  it('should return the rows in the caller ordering, not the database ordering', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([row('r2', 1), row('r1', 1)])

    const result = await resolveSelectedResources(supabase, 'c1', ['r1', 'r2'])

    expect(result.map((r) => r.id)).toEqual(['r1', 'r2'])
  })

  it('should reject a selection larger than the per-email count limit', async () => {
    await expect(
      resolveSelectedResources(supabase, 'c1', ['r1', 'r2', 'r3', 'r4']),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(getActiveResourcesByIdsMock).not.toHaveBeenCalled()
  })

  it('should reject an id that does not resolve for this client', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([row('r1', 1)])

    await expect(
      resolveSelectedResources(supabase, 'c1', ['r1', 'r-foreign']),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { missingResourceIds: ['r-foreign'] },
    })
  })

  it('should reject a selection that breaches the byte budget', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      row('r1', 2 * 1024 * 1024),
      row('r2', 2 * 1024 * 1024),
    ])

    await expect(resolveSelectedResources(supabase, 'c1', ['r1', 'r2'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { limitBytes: 3 * 1024 * 1024 },
    })
  })

  it('should accept a selection exactly on the byte budget', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([row('r1', 3 * 1024 * 1024)])

    await expect(resolveSelectedResources(supabase, 'c1', ['r1'])).resolves.toHaveLength(1)
  })
})
