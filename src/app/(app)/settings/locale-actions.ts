'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateUserLocale } from '@/lib/db/app-users'
import { localeSchema } from '@/lib/validation/locale'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'
import type { AppLocale } from '@/types/i18n'

// Every signed-in user — operator or client — owns their own language
// preference; there is no role gate here (contrast updateClientDefaultLocale
// in clients/[id]/locale-actions.ts, which is operator-only). Revalidates the
// whole layout, not just /settings, since language affects every page.
export async function updateMyLocale(locale: AppLocale): Promise<void> {
  const { appUser } = await requireUser()

  const parsed = localeSchema.safeParse(locale)
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid locale', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateUserLocale(admin, appUser.id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'user.locale_changed',
    payload: { locale: parsed.data },
  })
  revalidatePath('/', 'layout')
}
