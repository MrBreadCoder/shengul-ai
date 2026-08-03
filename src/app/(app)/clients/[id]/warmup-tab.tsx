import { Thermometer } from '@phosphor-icons/react/dist/ssr'
import { EmptyState } from '@/components/empty-state'
import type { MailboxRow } from '@/lib/db/mailboxes'
import { WarmupMailboxRow } from './warmup-mailbox-row'

interface WarmupTabProps {
  mailboxes: readonly MailboxRow[]
}

export function WarmupTab({ mailboxes }: WarmupTabProps): React.ReactElement {
  if (mailboxes.length === 0) {
    return (
      <EmptyState
        icon={Thermometer}
        title="No mailboxes connected"
        description="Connect a mailbox for this client from their own /settings page, then configure its warmup here."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {mailboxes.map((mailbox) => (
        <li key={mailbox.id}>
          <WarmupMailboxRow
            id={mailbox.id}
            emailAddress={mailbox.email_address}
            profile={mailbox.warmup_profile}
            warmupStartedAt={mailbox.warmup_started_at}
            warmupStartCap={mailbox.warmup_start_cap}
            warmupIncrement={mailbox.warmup_increment}
            warmupTargetCap={mailbox.warmup_target_cap}
            dailyCap={mailbox.daily_cap}
            sentToday={mailbox.sent_today}
          />
        </li>
      ))}
    </ul>
  )
}
