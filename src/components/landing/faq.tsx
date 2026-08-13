import { Plus } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

interface FaqItem {
  readonly question: string
  readonly answer: string
}

export async function Faq({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.faq' })
  // Safe per the same reasoning as `hero.tsx`'s `t.raw()` call — see there.
  const items = t.raw('items') as readonly FaqItem[]

  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto grid max-w-[1180px] gap-12 lg:grid-cols-12">
        <Reveal className="lg:col-span-4">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.4rem]">
            {t('heading')}
          </h2>
        </Reveal>

        <div className="lg:col-span-7 lg:col-start-6">
          {items.map(({ question, answer }, index) => (
            <Reveal key={question} delay={index * 0.04}>
              <details className="group border-b border-[var(--l-hairline)] py-6 last:border-b-0">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[17px] font-medium tracking-tight [&::-webkit-details-marker]:hidden">
                  {question}
                  <Plus
                    weight="light"
                    aria-hidden
                    className="mt-1 size-4 shrink-0 text-[var(--l-muted)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-open:rotate-45"
                  />
                </summary>
                <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                  {answer}
                </p>
              </details>
            </Reveal>
          ))}

          <Reveal delay={0.2}>
            <div className="mt-12">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
