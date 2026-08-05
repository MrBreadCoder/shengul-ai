import { describe, it, expect } from 'vitest'
import en from './en.json'
import tr from './tr.json'

// Recursively collects every leaf key path, e.g. "common.save", so a
// namespace or key added to one locale and forgotten in the other fails CI
// instead of silently falling back — or breaking — at runtime.
function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    collectKeyPaths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('message catalogs', () => {
  it('should have identical key structure across every locale', () => {
    expect(collectKeyPaths(tr).sort()).toEqual(collectKeyPaths(en).sort())
  })

  it('should have no empty string values in either locale', () => {
    for (const catalog of [en, tr]) {
      for (const path of collectKeyPaths(catalog)) {
        const value = path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], catalog)
        expect(typeof value === 'string' && value.trim().length > 0, `${path} must not be empty`).toBe(true)
      }
    }
  })
})
