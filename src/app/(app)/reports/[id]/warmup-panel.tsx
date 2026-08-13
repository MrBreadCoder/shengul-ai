import { getTranslations } from 'next-intl/server'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

interface WarmupPanelProps {
  mailboxes: MailboxWarmupInfo[]
}

export async function WarmupPanel({ mailboxes }: WarmupPanelProps): Promise<React.ReactElement> {
  const t = await getTranslations('reports')
  const gated = mailboxes.filter((m) => m.isGated)
  return (
    <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
      <p className="text-sm font-medium">{t('warmupPanel.title')}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupPanel.description', { gated: gated.length, total: mailboxes.length })}
      </p>
      <div className="divide-hairline mt-3 flex flex-col divide-y">
        {mailboxes.map((mailbox) => (
          <div key={mailbox.mailboxId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="truncate">{mailbox.emailAddress}</span>
            <span className="text-muted-foreground tnum shrink-0">
              {mailbox.isGated
                ? t('warmupPanel.statusWarming', { elapsed: mailbox.elapsedDays, gate: mailbox.gateDays })
                : t('warmupPanel.statusWarm')}
              {mailbox.reputationScore !== null ? ` · ${t('warmupPanel.reputation')}: ${mailbox.reputationScore}` : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
