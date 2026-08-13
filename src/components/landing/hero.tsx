import { ArrowDown } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { OutcomePanel, type BookedMeeting, type OutcomePanelCopy } from './outcome-panel'
import { Reveal } from './reveal'

/** Reveal on this block has a 0.06s stagger delay — wait for that plus the
 *  reveal transition itself before the highlighter snapshots its position. */
const HEADLINE_HIGHLIGHT_DELAY_MS = REVEAL_DURATION_MS + 60

async function buildOutcomePanelCopy(locale: AppLocale): Promise<OutcomePanelCopy> {
  const t = await getTranslations({ locale, namespace: 'marketing.outcomePanel' })
  return {
    thisMonth: t('thisMonth'),
    live: t('live'),
    exampleFigures: t('exampleFigures'),
    meetingsBookedLine1: t('meetingsBookedLine1'),
    meetingsBookedLine2: t('meetingsBookedLine2'),
    new: t('new'),
    footerNote: t('footerNote'),
    // `t.raw()` returns the JSON message value with no static typing — safe
    // here because `messages.test.ts` enforces every leaf under
    // `marketing.outcomePanel.meetingPool` is a non-empty string, and this
    // shape is fixed by us, not external input.
    meetingPool: t.raw('meetingPool') as readonly BookedMeeting[],
  }
}

/**
 * Asymmetric split hero: the promise on the left, the morning it produces on
 * the right. Four text elements only (eyebrow, headline, subtext, actions) so
 * the whole thing clears the fold on a laptop.
 */
export async function Hero({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const [t, outcomePanelCopy] = await Promise.all([
    getTranslations({ locale, namespace: 'marketing.hero' }),
    buildOutcomePanelCopy(locale),
  ])

  return (
    <section className="relative isolate overflow-hidden px-4 pt-24 pb-20 md:flex md:min-h-[100dvh] md:items-center md:pb-28">
      {/* Ambient wash. One static gradient, no blur filter, so it costs one
          paint. Monochrome, so it lifts the panel off the page without
          introducing a hue the rest of the composition does not use. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(65%_55%_at_74%_14%,color-mix(in_oklch,white_9%,transparent),transparent_68%)]"
      />

      <div className="mx-auto grid w-full max-w-[1180px] items-center gap-14 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-6 xl:col-span-6">
          <Reveal>
            <span className="inline-flex rounded-full border border-[var(--l-hairline-strong)] px-3 py-1 text-[10px] font-medium tracking-[0.2em] text-[var(--l-muted)] uppercase">
              {t('eyebrow')}
            </span>
          </Reveal>

          <Reveal delay={0.06}>
            <h1 className="mt-7 text-[2.75rem] leading-[1.02] font-medium tracking-tighter text-balance sm:text-6xl lg:text-[4.25rem]">
              {t('headlinePrefix')}
              <Highlighter
                action="underline"
                color={LANDING_HIGHLIGHT_COLOR}
                strokeWidth={3}
                padding={4}
                startDelay={HEADLINE_HIGHLIGHT_DELAY_MS}
              >
                {t('headlineHighlight')}
              </Highlighter>
              {t('headlineSuffix')}
            </h1>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-6 max-w-[50ch] text-[15px] leading-relaxed text-[var(--l-muted)] sm:text-base">
              {t('subtext')}
            </p>
          </Reveal>

          <Reveal delay={0.18}>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <BookMeetingButton locale={locale} size="lg" />
              <a
                href="#how"
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--l-hairline-strong)] py-2.5 pr-5 pl-5 text-[15px] text-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
              >
                {t('secondaryCta')}
                <ArrowDown
                  weight="light"
                  aria-hidden
                  className="size-4 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-y-0.5"
                />
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.24} className="lg:col-span-6 xl:col-start-7">
          <OutcomePanel copy={outcomePanelCopy} />
        </Reveal>
      </div>
    </section>
  )
}
