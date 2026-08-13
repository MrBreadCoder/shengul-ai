import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { closestToReady, totalMessagesExchanged, type MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

interface WarmupBannerProps {
  mailboxes: MailboxWarmupInfo[]
  gated: MailboxWarmupInfo[]
}

export async function WarmupBanner({ mailboxes, gated }: WarmupBannerProps): Promise<React.ReactElement | null> {
  const t = await getTranslations('home')
  // Only null when gated is empty — the caller in page.tsx never renders this
  // component unless gated.length > 0, so this guard is what keeps the rest
  // of the function assertion-free, not dead code.
  const closest = closestToReady(gated)
  if (!closest) return null
  const exchanged = totalMessagesExchanged(gated)
  return (
    <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
      <p className="text-sm font-medium">{t('warmupBanner.title')}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupBanner.progress', { gated: gated.length, total: mailboxes.length })}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupBanner.closest', { elapsed: closest.elapsedDays, gate: closest.gateDays })}
        {closest.reputationScore !== null ? ' · ' + t('warmupBanner.reputation', { score: closest.reputationScore }) : null}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{t('warmupBanner.messagesExchanged', { count: exchanged })}</p>
      <Link href="/settings" className="text-primary mt-3 inline-block text-xs underline underline-offset-2">
        {t('warmupBanner.viewDetails')}
      </Link>
    </div>
  )
}
