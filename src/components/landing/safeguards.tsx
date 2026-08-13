import type { Icon } from '@phosphor-icons/react'
import { ChartLineUp, Power, ShieldCheck } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

/** Fixed render order matching `marketing.safeguards.promises` in the messages. */
const PROMISE_GLYPHS: readonly Icon[] = [ChartLineUp, ShieldCheck, Power]

interface Reassurance {
  readonly title: string
  readonly detail: string
}

export async function Safeguards({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.safeguards' })
  const promises = t.raw('promises') as readonly Reassurance[]

  return (
    <section id="safeguards" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px] rounded-[28px] border border-[var(--l-hairline)] bg-[var(--l-bg-deep)] p-1.5">
        <div className="rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-bg)] px-6 py-14 sm:px-12 sm:py-16">
          <Reveal>
            <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
              {t('headlinePrefix')}
              <Highlighter
                action="box"
                color={LANDING_HIGHLIGHT_COLOR}
                strokeWidth={2}
                padding={6}
                startDelay={REVEAL_DURATION_MS}
              >
                {t('headlineHighlight')}
              </Highlighter>
              {t('headlineSuffix')}
            </h2>
            <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
              {t.rich('description', {
                link: (chunks) => <InlineLink href="#privacy">{chunks}</InlineLink>,
              })}
            </p>
          </Reveal>

          <ul className="mt-14 grid gap-y-10 sm:grid-cols-3 sm:gap-x-0">
            {promises.map(({ title, detail }, index) => {
              const Glyph = PROMISE_GLYPHS[index]
              if (!Glyph) {
                throw new Error(`marketing.safeguards.promises invariant violated: no glyph at index ${index}`)
              }
              return (
                <li
                  key={title}
                  className="sm:border-l sm:border-[var(--l-hairline)] sm:px-8 sm:first:border-l-0 sm:first:pl-0 sm:last:pr-0"
                >
                  <Reveal delay={index * 0.05}>
                    <Glyph weight="light" aria-hidden className="mb-5 size-6 text-[var(--l-muted)]" />
                    <p className="text-lg font-medium tracking-tight">{title}</p>
                    <p className="mt-3 max-w-[34ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                      {detail}
                    </p>
                  </Reveal>
                </li>
              )
            })}
          </ul>

          <Reveal delay={0.2}>
            <div className="mt-14">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
