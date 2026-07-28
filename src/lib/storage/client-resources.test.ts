import { describe, it, expect, vi } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  RESOURCE_MAX_BYTES,
  assertValidResourceFile,
  uploadClientResource,
  downloadClientResource,
  deleteClientResourceObject,
  getClientResourceSignedUrl,
} from './client-resources'

function fileOf(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type })
}

describe('assertValidResourceFile', () => {
  it('should accept every allowed mime type', () => {
    for (const type of [
      'application/pdf', 'image/png', 'image/jpeg', 'image/gif',
      'image/webp', 'image/svg+xml', 'text/plain', 'text/markdown',
    ]) {
      expect(() => assertValidResourceFile(fileOf('f', type, 10))).not.toThrow()
    }
  })

  it('should throw VALIDATION_ERROR when the mime type is not allowed', () => {
    try {
      assertValidResourceFile(fileOf('evil.exe', 'application/x-msdownload', 10))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })

  it('should throw VALIDATION_ERROR when the file exceeds the 3MB cap', () => {
    try {
      assertValidResourceFile(fileOf('big.pdf', 'application/pdf', RESOURCE_MAX_BYTES + 1))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({ size: RESOURCE_MAX_BYTES + 1 })
    }
  })

  it('should throw VALIDATION_ERROR when the file is empty', () => {
    try {
      assertValidResourceFile(fileOf('empty.pdf', 'application/pdf', 0))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })
})

describe('uploadClientResource', () => {
  it('should store under a client-scoped path and return the sanitized filename', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload }) } } as never

    const result = await uploadClientResource(supabase, 'c1', fileOf('../résumé.pdf', 'application/pdf', 10))

    expect(result.fileName).toBe('resume.pdf')
    expect(result.storagePath.startsWith('c1/')).toBe(true)
    expect(result.storagePath.endsWith('.pdf')).toBe(true)
    expect(upload).toHaveBeenCalledWith(
      result.storagePath,
      expect.anything(),
      expect.objectContaining({ contentType: 'application/pdf', upsert: false }),
    )
  })

  it('should throw EXTERNAL_ERROR when storage rejects the upload', async () => {
    const supabase = {
      storage: { from: () => ({ upload: () => Promise.resolve({ error: { message: 'boom' } }) }) },
    } as never
    await expect(
      uploadClientResource(supabase, 'c1', fileOf('a.pdf', 'application/pdf', 10)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should reject an invalid file before touching storage', async () => {
    const upload = vi.fn()
    const supabase = { storage: { from: () => ({ upload }) } } as never
    await expect(
      uploadClientResource(supabase, 'c1', fileOf('a.exe', 'application/x-msdownload', 10)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('downloadClientResource', () => {
  it('should return the object bytes as a Buffer', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const supabase = {
      storage: { from: () => ({ download: () => Promise.resolve({ data: blob, error: null }) }) },
    } as never
    const buffer = await downloadClientResource(supabase, 'c1/x.pdf')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect([...buffer]).toEqual([1, 2, 3])
  })

  it('should throw EXTERNAL_ERROR when the object is missing', async () => {
    const supabase = {
      storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: { message: 'not found' } }) }) },
    } as never
    await expect(downloadClientResource(supabase, 'c1/x.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('deleteClientResourceObject', () => {
  it('should swallow a storage failure so cleanup never fails the request', async () => {
    const supabase = {
      storage: { from: () => ({ remove: () => Promise.reject(new Error('boom')) }) },
    } as never
    await expect(deleteClientResourceObject(supabase, 'c1/x.pdf')).resolves.toBeUndefined()
  })
})

describe('getClientResourceSignedUrl', () => {
  it('should return the signed url when signing succeeds', async () => {
    const supabase = {
      storage: {
        from: () => ({
          createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://s/x' }, error: null }),
        }),
      },
    } as never
    await expect(getClientResourceSignedUrl(supabase, 'c1/x.pdf')).resolves.toBe('https://s/x')
  })

  it('should throw EXTERNAL_ERROR when signing fails', async () => {
    const supabase = {
      storage: {
        from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
      },
    } as never
    await expect(getClientResourceSignedUrl(supabase, 'c1/x.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})
