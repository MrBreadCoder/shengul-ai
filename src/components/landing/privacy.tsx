import type { Icon } from '@phosphor-icons/react'
import { ClockCounterClockwise, LockKey, Plugs, Vault } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

/** Fixed render order matching `marketing.privacy.commitments` in the messages. */
const COMMITMENT_GLYPHS: readonly Icon[] = [LockKey, Plugs, Vault, ClockCounterClockwise]

interface Commitment {
  readonly title: string
  readonly detail: string
}

/**
 * Every claim here is one the product can actually stand behind: AES-256-GCM on
 * mailbox credentials before they are written, row-level security on every
 * table carrying a client id, and the 30/90 day event retention the log sweep
 * enforces. Nothing on this list is a certification we do not hold.
 */
export async function Privacy({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.privacy' })
  const commitments = t.raw('commitments') as readonly Commitment[]

  return (
    <section id="privacy" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px]">
        <Reveal className="max-w-[40ch]">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('heading')}
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-[var(--l-muted)]">
            {t.rich('description', {
              link: (chunks) => <InlineLink href="#safeguards">{chunks}</InlineLink>,
            })}
          </p>
        </Reveal>

        <ul className="mt-14 grid border-t border-[var(--l-hairline)] sm:grid-cols-2">
          {commitments.map(({ title, detail }, index) => {
            const Glyph = COMMITMENT_GLYPHS[index]
            if (!Glyph) {
              throw new Error(`marketing.privacy.commitments invariant violated: no glyph at index ${index}`)
            }
            return (
              <li
                key={title}
                className="border-b border-[var(--l-hairline)] py-9 sm:odd:pr-9 sm:even:border-l sm:even:pl-9"
              >
                <Reveal delay={index * 0.05}>
                  <div className="flex gap-5">
                    <Glyph
                      weight="light"
                      aria-hidden
                      className="mt-0.5 size-6 shrink-0 text-[var(--l-muted)]"
                    />
                    <div>
                      <p className="text-lg font-medium tracking-tight">{title}</p>
                      <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                        {detail}
                      </p>
                    </div>
                  </div>
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
    </section>
  )
}
