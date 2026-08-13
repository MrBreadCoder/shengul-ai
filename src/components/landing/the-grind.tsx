import { X } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

export async function TheGrind({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.theGrind' })
  const costs = t.raw('costs') as readonly string[]

  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
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
        </Reveal>

        <ul className="mt-14 grid gap-x-10 gap-y-8 md:grid-cols-2">
          {costs.map((cost, index) => (
            <li key={cost}>
              <Reveal delay={index * 0.05}>
                <div className="flex gap-4 border-t border-[var(--l-hairline)] pt-6">
                  {/* Marks the item as a cost, not decoration: every line in this
                      list is something the product removes. */}
                  <X
                    weight="light"
                    aria-hidden
                    className="mt-1 size-[18px] shrink-0 text-[var(--l-faint)]"
                  />
                  <p className="text-lg leading-snug text-[var(--l-muted)]">{cost}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>

        <Reveal delay={0.24}>
          <p className="mt-14 text-lg leading-snug text-[var(--l-text)] sm:text-xl">
            {t('closingLine')}
          </p>
          <div className="mt-8">
            <BookMeetingButton locale={locale} size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
