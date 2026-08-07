import type { Icon } from '@phosphor-icons/react'
import { ClockCounterClockwise, LockKey, Plugs, Vault } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

interface Commitment {
  readonly title: string
  readonly detail: string
  readonly Glyph: Icon
}

/**
 * Every claim here is one the product can actually stand behind: AES-256-GCM on
 * mailbox credentials before they are written, row-level security on every
 * table carrying a client id, and the 30/90 day event retention the log sweep
 * enforces. Nothing on this list is a certification we do not hold.
 */
const COMMITMENTS: readonly Commitment[] = [
  {
    title: 'Everything is encrypted.',
    detail:
      "Every connection uses TLS, and your mailbox login gets extra encryption before it's ever saved.",
    Glyph: LockKey,
  },
  {
    title: 'You can disconnect anytime.',
    detail:
      "Your mailbox connects through Google or Microsoft's own sign-in screen. Disconnect it and sending stops immediately.",
    Glyph: Plugs,
  },
  {
    title: 'Your data stays yours.',
    detail:
      "Kept separate at the database level — no query can ever return someone else's information.",
    Glyph: Vault,
  },
  {
    title: 'Nothing is kept forever.',
    detail: 'Regular activity is deleted after 30 days, flagged records after 90, automatically.',
    Glyph: ClockCounterClockwise,
  },
]

export function Privacy(): React.ReactElement {
  return (
    <section id="privacy" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px]">
        <Reveal className="max-w-[40ch]">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            How your data is handled.
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-[var(--l-muted)]">
            Running outbound means sharing your mailbox and your lead list with us. Here&rsquo;s
            exactly what happens to both — and separately, how we protect{' '}
            <InlineLink href="#safeguards">the reputation of the domain you send from</InlineLink>.
          </p>
        </Reveal>

        <ul className="mt-14 grid border-t border-[var(--l-hairline)] sm:grid-cols-2">
          {COMMITMENTS.map(({ title, detail, Glyph }, index) => (
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
          ))}
        </ul>

        <Reveal delay={0.2}>
          <div className="mt-14">
            <BookMeetingButton size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
