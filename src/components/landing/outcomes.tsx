import type { Icon } from '@phosphor-icons/react'
import {
  CalendarCheck,
  ChatCircle,
  MagnifyingGlass,
  PaperPlaneTilt,
} from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

/** These headlines sit in `Reveal` blocks with no extra stagger delay — wait
 *  out the reveal transition before the highlighter snapshots its position. */
const HEADLINE_HIGHLIGHT_DELAY_MS = REVEAL_DURATION_MS

/** Fixed render order matching `marketing.outcomes.items` in the messages. */
const OUTCOME_GLYPHS: readonly Icon[] = [MagnifyingGlass, PaperPlaneTilt, ChatCircle, CalendarCheck]

interface OutcomeItem {
  readonly value: string
  readonly label: string
  readonly detail: string
}

/**
 * The four things that get counted, in the order they happen. Figures are one
 * illustrative month and are labelled as such in the section body: nothing here
 * is a result we are promising, and no client's real numbers appear in public.
 */
export async function Outcomes({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.outcomes' })
  // Safe per the same reasoning as `hero.tsx`'s `t.raw()` call — see there.
  const items = t.raw('items') as readonly OutcomeItem[]

  return (
    <section id="outcomes" className="scroll-mt-28 px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[20ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('headlinePrefix')}
            <Highlighter
              action="circle"
              color={LANDING_HIGHLIGHT_COLOR}
              strokeWidth={2}
              padding={6}
              startDelay={HEADLINE_HIGHLIGHT_DELAY_MS}
            >
              {t('headlineHighlight')}
            </Highlighter>
          </h2>
          <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
            {t('description')}
          </p>
        </Reveal>

        <div className="mt-14 grid gap-x-8 gap-y-12 border-t border-[var(--l-hairline-strong)] pt-12 sm:grid-cols-2 lg:grid-cols-4">
          {items.map(({ value, label, detail }, index) => {
            const Glyph = OUTCOME_GLYPHS[index]
            if (!Glyph) {
              throw new Error(`marketing.outcomes.items invariant violated: no glyph at index ${index}`)
            }
            return (
              <Reveal key={label} delay={index * 0.05}>
                <Glyph weight="light" aria-hidden className="size-6 text-[var(--l-faint)]" />
                <p className="mt-6 font-mono text-[2.75rem] leading-none tracking-tighter tabular-nums sm:text-[3.25rem]">
                  {value}
                </p>
                <p className="mt-4 text-lg font-medium tracking-tight">{label}</p>
                <p className="mt-2 max-w-[30ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                  {detail}
                </p>
              </Reveal>
            )
          })}
        </div>

        <Reveal delay={0.2}>
          <div className="mt-16 rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] p-1.5">
            <div className="rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] px-6 py-8 sm:px-10 sm:py-10">
              <p className="text-lg font-medium tracking-tight">
                {t('revenueFifthPrefix')}
                <Highlighter
                  action="highlight"
                  color={LANDING_HIGHLIGHT_COLOR}
                  padding={2}
                  startDelay={REVEAL_DURATION_MS + 200}
                >
                  {t('revenueFifthHighlight')}
                </Highlighter>
                {t('revenueFifthSuffix')}
              </p>
              <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('revenueBody', {
                  meetings: t('revenueMeetings'),
                  averageDeal: t('revenueAverageDeal'),
                  closeRate: t('revenueCloseRate'),
                  newBusiness: t('revenueNewBusiness'),
                })}
              </p>
              <div className="mt-8">
                <BookMeetingButton locale={locale} size="lg" />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
