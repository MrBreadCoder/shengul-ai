import { afterEach, describe, expect, it } from 'vitest'
import {
  applyConsentDecision,
  clearStoredConsent,
  CONSENT_CHANGE_EVENT,
  CONSENT_STORAGE_KEY,
  readStoredConsent,
  storeConsentDecision,
} from './consent-mode'

interface MockWindow {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
  localStorage: {
    getItem: (key: string) => string | null
    setItem: (key: string, value: string) => void
    removeItem: (key: string) => void
  }
  dispatchEvent: (event: Event) => boolean
}

function installMockWindow(overrides?: Partial<MockWindow>): MockWindow {
  const store = new Map<string, string>()
  const mockWindow: MockWindow = {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value)
      },
      removeItem: (key) => {
        store.delete(key)
      },
    },
    dispatchEvent: () => true,
    ...overrides,
  }
  ;(globalThis as unknown as { window: MockWindow }).window = mockWindow
  return mockWindow
}

describe('consent-mode', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window
  })

  describe('applyConsentDecision', () => {
    it('should push a Consent Mode update through dataLayer when granting', () => {
      const mockWindow = installMockWindow()

      applyConsentDecision('granted')

      expect(mockWindow.dataLayer).toHaveLength(1)
      expect(mockWindow.dataLayer?.[0]).toEqual(['consent', 'update', { analytics_storage: 'granted' }])
    })

    it('should push a Consent Mode update through dataLayer when denying', () => {
      const mockWindow = installMockWindow()

      applyConsentDecision('denied')

      expect(mockWindow.dataLayer?.[0]).toEqual(['consent', 'update', { analytics_storage: 'denied' }])
    })

    it('should reuse an existing gtag stub instead of overwriting it', () => {
      const calls: unknown[][] = []
      const mockWindow = installMockWindow({
        gtag: (...args: unknown[]) => {
          calls.push(args)
        },
      })

      applyConsentDecision('granted')

      expect(calls).toEqual([['consent', 'update', { analytics_storage: 'granted' }]])
      expect(mockWindow.gtag).toBeDefined()
    })
  })

  describe('storeConsentDecision / readStoredConsent', () => {
    it('should round-trip a stored decision', () => {
      installMockWindow()

      storeConsentDecision('granted')

      expect(readStoredConsent()).toBe('granted')
    })

    it('should return null when nothing has been stored', () => {
      installMockWindow()

      expect(readStoredConsent()).toBeNull()
    })

    it('should return null when localStorage throws', () => {
      installMockWindow({
        localStorage: {
          getItem: () => {
            throw new Error('storage disabled')
          },
          setItem: () => {
            throw new Error('storage disabled')
          },
          removeItem: () => {
            throw new Error('storage disabled')
          },
        },
      })

      expect(() => storeConsentDecision('granted')).not.toThrow()
      expect(readStoredConsent()).toBeNull()
    })

    it('should ignore an unrecognized stored value', () => {
      const mockWindow = installMockWindow()
      mockWindow.localStorage.setItem(CONSENT_STORAGE_KEY, 'not-a-decision')

      expect(readStoredConsent()).toBeNull()
    })

    it('should dispatch CONSENT_CHANGE_EVENT after storing a decision', () => {
      const dispatched: string[] = []
      installMockWindow({
        dispatchEvent: (event) => {
          dispatched.push(event.type)
          return true
        },
      })

      storeConsentDecision('granted')

      expect(dispatched).toEqual([CONSENT_CHANGE_EVENT])
    })
  })

  describe('clearStoredConsent', () => {
    it('should remove the stored decision and deny analytics_storage again', () => {
      const mockWindow = installMockWindow()
      storeConsentDecision('granted')

      clearStoredConsent()

      expect(readStoredConsent()).toBeNull()
      const lastDataLayerEntry = mockWindow.dataLayer?.at(-1)
      expect(lastDataLayerEntry).toEqual(['consent', 'update', { analytics_storage: 'denied' }])
    })

    it('should dispatch CONSENT_CHANGE_EVENT', () => {
      const dispatched: string[] = []
      installMockWindow({
        dispatchEvent: (event) => {
          dispatched.push(event.type)
          return true
        },
      })

      clearStoredConsent()

      expect(dispatched).toEqual([CONSENT_CHANGE_EVENT])
    })
  })
})
