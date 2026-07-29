'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientMailreachEnabled } from '@/lib/db/clients'
import { bulkDisconnectForClient, bulkReconnectSmtpForClient } from '@/lib/mailreach/enrollment'
import { logEvent, logEventSafe } from '@/lib/events/log-event'
import { AppError, isAppError, type AppErrorCode } from '@/lib/errors/app-error'

export type SetClientMailreachEnabledResult = { ok: true } | { ok: false; code: AppErrorCode }

/**
 * Client-level Mailreach master switch. Turning it off bulk-disconnects every
 * currently connected mailbox under this client (best-effort); turning it
 * back on silently reconnects the SMTP ones. See bulkDisconnectForClient /
 * bulkReconnectSmtpForClient for why gmail/outlook mailboxes are excluded from
 * the reconnect side.
 */
export async function setClientMailreachEnabled(
  clientId: string,
  enabled: boolean,
): Promise<SetClientMailreachEnabledResult> {
  try {
    await setClientMailreachEnabledUnsafe(clientId, enabled)
    return { ok: true }
  } catch (error) {
    if (isAppError(error)) return { ok: false, code: error.code }
    throw error
  }
}

async function setClientMailreachEnabledUnsafe(clientId: string, enabled: boolean): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only an operator can change this', { clientId, userId: appUser.id })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) throw new AppError('NOT_FOUND', 'Client not found', { clientId })

  await updateClientMailreachEnabled(admin, clientId, enabled)

  // Best-effort — the client-level flag flip already succeeded, and a
  // per-mailbox bulk failure (partial or total) must not roll that back or
  // fail the request; the operator can retry individual mailboxes from
  // /settings.
  try {
    const bulkResult = enabled
      ? await bulkReconnectSmtpForClient(admin, clientId, new Date())
      : await bulkDisconnectForClient(admin, clientId)
    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.mailreach_enabled_changed',
        payload: {
          from: client.mailreach_enabled,
          to: enabled,
          attempted: bulkResult.attempted,
          succeeded: bulkResult.succeeded,
          failed: bulkResult.failed,
        },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
  } catch (error) {
    await logEventSafe({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'client.mailreach_bulk_op_failed',
      payload: { to: enabled, cause: error instanceof Error ? error.message : String(error) },
    })
  }

  revalidatePath(`/clients/${clientId}`)
}
