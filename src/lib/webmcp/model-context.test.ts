import { describe, expect, it } from 'vitest'
import { resolveModelContext, type ModelContextScope } from '@/lib/webmcp/model-context'

const MODEL_CONTEXT = { registerTool: async (): Promise<void> => {} }

function scope(overrides: Partial<ModelContextScope>): ModelContextScope {
  return { isSecureContext: true, ...overrides }
}

describe('resolveModelContext', () => {
  it('should return the document model context when the spec-compliant API is present', () => {
    const resolved = resolveModelContext(scope({ document: { modelContext: MODEL_CONTEXT } }))
    expect(resolved).toBe(MODEL_CONTEXT)
  })

  it('should fall back to the navigator model context when only the origin-trial API is present', () => {
    const resolved = resolveModelContext(scope({ navigator: { modelContext: MODEL_CONTEXT } }))
    expect(resolved).toBe(MODEL_CONTEXT)
  })

  it('should prefer the document model context when both are present', () => {
    const legacy = { registerTool: async (): Promise<void> => {} }
    const resolved = resolveModelContext(
      scope({ document: { modelContext: MODEL_CONTEXT }, navigator: { modelContext: legacy } }),
    )
    expect(resolved).toBe(MODEL_CONTEXT)
  })

  it('should return null when the page is not a secure context', () => {
    const resolved = resolveModelContext({
      isSecureContext: false,
      document: { modelContext: MODEL_CONTEXT },
    })
    expect(resolved).toBeNull()
  })

  it('should return null when secure-context status is unknown', () => {
    const resolved = resolveModelContext({ document: { modelContext: MODEL_CONTEXT } })
    expect(resolved).toBeNull()
  })

  it('should return null when the browser has no model context at all', () => {
    expect(resolveModelContext(scope({ document: {}, navigator: {} }))).toBeNull()
  })

  it('should return null when modelContext exists but cannot register tools', () => {
    expect(resolveModelContext(scope({ document: { modelContext: {} } }))).toBeNull()
    expect(resolveModelContext(scope({ document: { modelContext: { registerTool: 'nope' } } }))).toBeNull()
    expect(resolveModelContext(scope({ document: { modelContext: null } }))).toBeNull()
    expect(resolveModelContext(scope({ document: { modelContext: 'modelContext' } }))).toBeNull()
  })
})
