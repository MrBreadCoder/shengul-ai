import { cache } from 'react'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'
import { getAppUser } from '@/lib/db/app-users'
import { getClientById } from '@/lib/db/clients'
import { SUPPORTED_LOCALES, type AppLocale } from '@/types/i18n'

const DEFAULT_LOCALE: AppLocale = 'en'

export function isSupportedLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

// Parses the first acceptable primary language subtag out of an
// Accept-Language header, e.g. "tr-TR,tr;q=0.9,en;q=0.8" -> "tr". Used only
// pre-login, where there is no stored preference yet — ignores quality
// weighting beyond taking the browser's preference order at face value.
export function parseAcceptLanguage(header: string | null): AppLocale {
  if (!header) return DEFAULT_LOCALE
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().split('-')[0]
    if (tag && isSupportedLocale(tag)) return tag
  }
  return DEFAULT_LOCALE
}

async function resolvePreloginLocale(): Promise<AppLocale> {
  const headerList = await headers()
  return parseAcceptLanguage(headerList.get('accept-language'))
}

/**
 * Resolves the locale to render for the current request: the signed-in
 * user's own preference, falling back to their client's default (client
 * role) or 'en' (operator role with no override); falling back further to
 * the browser's Accept-Language header when there is no session at all
 * (pre-login pages).
 *
 * Wrapped in React's `cache()` so every call within one request's render
 * tree — `i18n/request.ts`, plus any Server Component that asks directly —
 * shares a single result and a single DB round trip, no matter how many
 * places call it.
 */
export const resolveLocale = cache(async (): Promise<AppLocale> => {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return resolvePreloginLocale()

  const appUser = await getAppUser(supabase, data.user.id)
  if (!appUser) return DEFAULT_LOCALE
  if (appUser.locale) return appUser.locale

  if (appUser.role === 'client' && appUser.client_id) {
    const client = await getClientById(supabase, appUser.client_id)
    if (client && isSupportedLocale(client.default_locale)) return client.default_locale
  }
  return DEFAULT_LOCALE
})
