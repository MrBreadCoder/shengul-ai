import { Clock, Eye, Newspaper, User } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import { cn } from '@/lib/utils'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

interface TileProps {
  className?: string
  children: React.ReactNode
  /** Adds the accent wash. Reserved for the one tile that leads the grid. */
  isFeature?: boolean
}

/**
 * Nested enclosure shared by every tile: an outer tray with a hairline, and an
 * inner core with its own top highlight. Radii are concentric by calculation,
 * not by eye.
 */
function Tile({ className, children, isFeature = false }: TileProps): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] p-1.5',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-[22px] border border-[var(--l-hairline)] p-7 sm:p-8',
          'shadow-[inset_0_1px_0_color-mix(in_oklch,white_7%,transparent)]',
          isFeature
            ? 'bg-[var(--l-surface)] bg-[radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklch,var(--l-accent)_18%,transparent),transparent_62%)]'
            : 'bg-[var(--l-surface)]',
        )}
      >
        {children}
      </div>
    </div>
  )
}

export async function Capabilities({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.capabilities' })
  const reliefs = t.raw('reliefs') as readonly string[]

  return (
    <section id="capabilities" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px]">
        <Reveal className="max-w-[36ch]">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('heading')}
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-4 lg:grid-cols-12">
          <Reveal className="h-full lg:col-span-7 lg:row-span-2">
            <Tile isFeature className="h-full">
              <Clock weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="max-w-[16ch] text-xl font-medium tracking-tight sm:text-2xl">
                {t('tile1Prefix')}
                <Highlighter
                  action="underline"
                  color={LANDING_HIGHLIGHT_COLOR}
                  strokeWidth={2.5}
                  padding={3}
                  startDelay={REVEAL_DURATION_MS}
                >
                  {t('tile1Highlight')}
                </Highlighter>
                {t('tile1Suffix')}
              </h3>
              <p className="mt-4 max-w-[44ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile1Body')}
              </p>
              <ul className="mt-9 flex flex-wrap gap-2">
                {reliefs.map((relief) => (
                  <li
                    key={relief}
                    className="rounded-full border border-[var(--l-hairline-strong)] px-3.5 py-1.5 text-[12px] text-[var(--l-muted)]"
                  >
                    {relief}
                  </li>
                ))}
              </ul>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-5" delay={0.05}>
            <Tile className="h-full">
              <p className="font-mono text-[3.25rem] leading-none tracking-tighter tabular-nums">
                {t('tile2Number')}
              </p>
              <h3 className="mt-6 text-lg font-medium tracking-tight">{t('tile2Title')}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile2Body')}
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-5" delay={0.1}>
            <Tile className="h-full">
              <Newspaper weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">{t('tile3Title')}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile3Body')}
              </p>
              <p className="mt-6 rounded-[14px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] px-4 py-3.5 text-[13px] leading-relaxed text-[var(--l-muted)]">
                {t('tile3Callout')}
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-4" delay={0.15}>
            <Tile className="h-full">
              <User weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">{t('tile4Title')}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile4Body')}
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-8" delay={0.2}>
            <Tile className="h-full">
              <Eye weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">{t('tile5Title')}</h3>
              <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile5Body')}
              </p>
            </Tile>
          </Reveal>
        </div>

        <Reveal delay={0.25}>
          <div className="mt-14">
            <BookMeetingButton locale={locale} size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
