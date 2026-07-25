import { describe, it, expect, vi } from 'vitest'
import { assertValidLogoFile, uploadClientLogo, deleteClientLogoObject, LOGO_BUCKET } from './logos'
import { AppError } from '@/lib/errors/app-error'

function makeFile(name: string, type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], name, { type })
}

describe('assertValidLogoFile', () => {
  it('should return the extension for a valid PNG under the size limit', () => {
    const file = makeFile('logo.png', 'image/png', 1024)
    expect(assertValidLogoFile(file)).toBe('png')
  })

  it('should throw VALIDATION_ERROR for an unsupported content type', () => {
    const file = makeFile('logo.gif', 'image/gif', 1024)
    expect(() => assertValidLogoFile(file)).toThrow(AppError)
  })

  it('should throw VALIDATION_ERROR for a file over 2MB', () => {
    const file = makeFile('logo.png', 'image/png', 2 * 1024 * 1024 + 1)
    expect(() => assertValidLogoFile(file)).toThrow(AppError)
  })
})

describe('uploadClientLogo', () => {
  it('should upload and return the public URL', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null })
    const getPublicUrl = vi.fn().mockReturnValue({ data: { publicUrl: 'https://x.test/storage/v1/object/public/client-logos/c1/abc.png' } })
    const supabase = { storage: { from: () => ({ upload, getPublicUrl }) } } as never

    const url = await uploadClientLogo(supabase, 'c1', makeFile('logo.png', 'image/png', 1024))
    expect(url).toBe('https://x.test/storage/v1/object/public/client-logos/c1/abc.png')
    expect(upload).toHaveBeenCalledOnce()
  })

  it('should throw EXTERNAL_ERROR when the storage upload fails', async () => {
    const upload = vi.fn().mockResolvedValue({ error: { message: 'boom' } })
    const supabase = { storage: { from: () => ({ upload, getPublicUrl: vi.fn() }) } } as never

    await expect(uploadClientLogo(supabase, 'c1', makeFile('logo.png', 'image/png', 1024))).rejects.toBeInstanceOf(
      AppError,
    )
  })

  it('should reject an invalid file before calling storage', async () => {
    const upload = vi.fn()
    const supabase = { storage: { from: () => ({ upload }) } } as never
    await expect(uploadClientLogo(supabase, 'c1', makeFile('logo.gif', 'image/gif', 1024))).rejects.toBeInstanceOf(
      AppError,
    )
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('deleteClientLogoObject', () => {
  it('should remove the object at the parsed storage path', async () => {
    const remove = vi.fn().mockResolvedValue({ error: null })
    const from = vi.fn().mockReturnValue({ remove })
    const supabase = { storage: { from } } as never

    await deleteClientLogoObject(supabase, `https://x.test/storage/v1/object/public/${LOGO_BUCKET}/c1/abc.png`)
    expect(from).toHaveBeenCalledWith(LOGO_BUCKET)
    expect(remove).toHaveBeenCalledWith(['c1/abc.png'])
  })

  it('should do nothing when the URL does not match the bucket marker', async () => {
    const remove = vi.fn()
    const supabase = { storage: { from: () => ({ remove }) } } as never
    await deleteClientLogoObject(supabase, 'https://example.com/some-other-image.png')
    expect(remove).not.toHaveBeenCalled()
  })

  it('should swallow storage errors instead of throwing', async () => {
    const supabase = { storage: { from: () => ({ remove: vi.fn().mockRejectedValue(new Error('boom')) }) } } as never
    await expect(
      deleteClientLogoObject(supabase, `https://x.test/storage/v1/object/public/${LOGO_BUCKET}/c1/abc.png`),
    ).resolves.toBeUndefined()
  })
})
