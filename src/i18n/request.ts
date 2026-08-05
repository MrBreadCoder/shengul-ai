import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/resolve-locale'

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
