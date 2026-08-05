'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientDefaultLocale as updateClientDefaultLocaleRow } from '@/lib/db/clients'
import { localeSchema } from '@/lib/validation/locale'
import { logEvent } from '@/lib/events/log-event'
import { AppError, isAppError, type AppErrorCode } from '@/lib/errors/app-error'
import type { AppLocale } from '@/types/i18n'

export type SetClientDefaultLocaleResult = { ok: true } | { ok: false; code: AppErrorCode }

export async function updateClientDefaultLocale(
  clientId: string,
  locale: AppLocale,
): Promise<SetClientDefaultLocaleResult> {
  try {
    await updateClientDefaultLocaleUnsafe(clientId, locale)
    return { ok: true }
  } catch (error) {
    if (isAppError(error)) return { ok: false, code: error.code }
    throw error
  }
}

async function updateClientDefaultLocaleUnsafe(clientId: string, locale: AppLocale): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', "Only an operator can change a client's default language", {
      clientId,
      userId: appUser.id,
    })
  }

  const parsed = localeSchema.safeParse(locale)
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid locale', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) throw new AppError('NOT_FOUND', 'Client not found', { clientId })

  await updateClientDefaultLocaleRow(admin, clientId, parsed.data)
  await logEvent({
    clientId,
    actor: `human:${appUser.id}`,
    type: 'client.default_locale_changed',
    payload: { from: client.default_locale, to: parsed.data },
  })
  // Every (app) page is `dynamic = 'force-dynamic'`, so this isn't strictly
  // required for correctness (every request re-resolves the locale fresh) —
  // kept for consistency with the sibling actions in this file's directory.
  revalidatePath(`/clients/${clientId}`)
}
