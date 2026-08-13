import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

export async function ClosingCta({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.closingCta' })

  return (
    <section className="px-4 pt-8 pb-28 md:pb-36">
      <div className="mx-auto max-w-[1180px] rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] p-1.5">
        <div className="relative isolate overflow-hidden rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] px-6 py-20 text-center sm:px-12 sm:py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(80%_120%_at_50%_100%,color-mix(in_oklch,var(--l-accent)_20%,transparent),transparent_65%)]"
          />
          <Reveal>
            <h2 className="mx-auto max-w-[18ch] text-[2.25rem] leading-[1.05] font-medium tracking-tight text-balance sm:text-[3rem]">
              {t('headlinePrefix')}
              <Highlighter
                action="underline"
                color={LANDING_HIGHLIGHT_COLOR}
                strokeWidth={3}
                padding={4}
                startDelay={REVEAL_DURATION_MS}
              >
                {t('headlineHighlight')}
              </Highlighter>
              {t('headlineSuffix')}
            </h2>
            <p className="mx-auto mt-6 max-w-[46ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
              {t('description')}
            </p>
            <div className="mt-10 flex justify-center">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
            <p className="mt-7 text-[13px] text-[var(--l-faint)]">
              {t.rich('footerNote', {
                link: (chunks) => <InlineLink href="/login">{chunks}</InlineLink>,
              })}
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
