import type { Icon } from '@phosphor-icons/react'
import { ChartLineUp, Power, ShieldCheck } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

interface Reassurance {
  readonly title: string
  readonly detail: string
  readonly Glyph: Icon
}

const PROMISES: readonly Reassurance[] = [
  {
    title: 'It starts slow.',
    detail:
      'A mailbox sends a handful the first day and builds from there. Nothing about it looks like a machine that just woke up.',
    Glyph: ChartLineUp,
  },
  {
    title: 'It backs off by itself.',
    detail:
      'If the wrong things start coming back, that mailbox steps out of rotation and you hear about it before anyone else notices.',
    Glyph: ShieldCheck,
  },
  {
    title: 'One switch stops it.',
    detail:
      'Pull a single person out of the queue, quiet one mailbox, or stop everything at once. It takes effect immediately.',
    Glyph: Power,
  },
]

export function Safeguards(): React.ReactElement {
  return (
    <section id="safeguards" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px] rounded-[28px] border border-[var(--l-hairline)] bg-[var(--l-bg-deep)] p-1.5">
        <div className="rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-bg)] px-6 py-14 sm:px-12 sm:py-16">
          <Reveal>
            <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
              Protect and increase your email reputation.
            </h2>
            <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
              Your emails do not deserve to sit in a spam folder. The quickest way to put them
              there is to blast a domain, so this does the opposite: small numbers, human hours,
              your own mailbox. Every month it runs, the reputation you spent years earning is
              worth more, not less. The mailbox itself is handled just as carefully:{' '}
              <InlineLink href="#privacy">how your data is stored and deleted</InlineLink>.
            </p>
          </Reveal>

          <ul className="mt-14 grid gap-y-10 sm:grid-cols-3 sm:gap-x-0">
            {PROMISES.map(({ title, detail, Glyph }, index) => (
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
            ))}
          </ul>

          <Reveal delay={0.2}>
            <div className="mt-14">
              <BookMeetingButton size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
