import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/resolve-locale'

/**
 * `locale` here is next-intl's override channel: any imperative call like
 * `getTranslations({ locale: 'tr', namespace })` — the pattern every
 * marketing/landing component uses to render an explicit `/tr` vs `/` — passes
 * its locale through this parameter instead of the `[locale]` segment this
 * app doesn't have. Falling back to `resolveLocale()` (the signed-in-user /
 * pre-login Accept-Language resolver) preserves the dashboard's existing
 * per-session behavior for every call site that does *not* pass an explicit
 * locale. Ignoring `locale` here silently made every explicit-locale call
 * resolve to whichever locale `resolveLocale()` picked for the request
 * instead — the messages object never actually varied by page.
 */
export default getRequestConfig(async ({ locale: overrideLocale }) => {
  const locale = overrideLocale ?? (await resolveLocale())
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
