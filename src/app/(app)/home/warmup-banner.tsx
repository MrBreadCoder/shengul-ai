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
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t('warmupBanner.title')}</p>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('warmupBanner.progress', { gated: gated.length, total: mailboxes.length })}
          </p>
          {closest.reputationScore !== null ? (
            <p className="text-muted-foreground mt-1 text-sm">
              {t('warmupBanner.reputation', { score: closest.reputationScore })}
            </p>
          ) : null}
          <p className="text-muted-foreground mt-1 text-sm">{t('warmupBanner.messagesExchanged', { count: exchanged })}</p>
        </div>
        {/* The day counter is the headline number here — it's the one thing
            a client actually wants to check at a glance ("how much longer
            until outreach starts"), so it gets StatTile-sized digits instead
            of sitting inline with the rest of the copy. */}
        <div className="shrink-0 text-right">
          <p className="text-muted-foreground text-xs">{t('warmupBanner.dayLabel')}</p>
          <p className="tnum text-5xl leading-none font-semibold tracking-tight">{closest.elapsedDays}</p>
          <p className="text-muted-foreground mt-1.5 text-xs">
            {t('warmupBanner.gateDaysCaption', { gate: closest.gateDays })}
          </p>
        </div>
      </div>
      <Link href="/settings" className="text-primary mt-3 inline-block text-xs underline underline-offset-2">
        {t('warmupBanner.viewDetails')}
      </Link>
    </div>
  )
}
