import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listAllMailboxes, mailboxSendStats, setMailboxHealth } from '@/lib/db/mailboxes'
import { evaluateBounceHealth, HEALTH_WINDOW_DAYS } from '@/lib/mailbox/health'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'mailbox_health_sweep'
const MS_PER_DAY = 86_400_000

export interface HealthSweepSummary {
  evaluated: number
  changed: number
}

/**
 * Re-evaluates every mailbox's health from its recent hard-bounce rate.
 *
 * Runs on a cron rather than on every bounce so a single bad address cannot
 * flip a mailbox, and so recovery from 'warning' happens on its own once the
 * bad sends age out of the window. A blocked mailbox is never touched — see
 * evaluateBounceHealth.
 */
export async function runMailboxHealthSweep(
  supabase: SupabaseClient<Database>,
  { now }: { now: Date },
): Promise<HealthSweepSummary> {
  const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * MS_PER_DAY)
  const [mailboxes, stats] = await Promise.all([
    listAllMailboxes(supabase),
    mailboxSendStats(supabase, since),
  ])

  let changed = 0
  for (const mailbox of mailboxes) {
    const { sentCount, bouncedCount } = stats.get(mailbox.id) ?? { sentCount: 0, bouncedCount: 0 }
    const verdict = evaluateBounceHealth({ current: mailbox.health, sentCount, bouncedCount })
    if (!verdict || verdict.health === mailbox.health) continue

    await setMailboxHealth(supabase, mailbox.id, verdict.health, verdict.reason)
    changed += 1
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: ACTOR,
      type: 'mailbox.health_changed',
      source: 'mailbox',
      severity: verdict.health === 'ok' ? 'info' : 'warn',
      payload: {
        mailboxId: mailbox.id,
        emailAddress: mailbox.email_address,
        from: mailbox.health,
        to: verdict.health,
        reason: verdict.reason,
        sentCount,
        bouncedCount,
      },
    })
  }

  return { evaluated: mailboxes.length, changed }
}
