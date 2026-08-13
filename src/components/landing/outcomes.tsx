import type { Icon } from '@phosphor-icons/react'
import {
  CalendarCheck,
  ChatCircle,
  MagnifyingGlass,
  PaperPlaneTilt,
} from '@phosphor-icons/react/dist/ssr'
import { Highlighter } from '@/components/ui/highlighter'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

/** These headlines sit in `Reveal` blocks with no extra stagger delay — wait
 *  out the reveal transition before the highlighter snapshots its position. */
const HEADLINE_HIGHLIGHT_DELAY_MS = REVEAL_DURATION_MS

interface Outcome {
  readonly value: string
  readonly label: string
  readonly detail: string
  readonly Glyph: Icon
}

/**
 * The four things that get counted, in the order they happen. Figures are one
 * illustrative month and are labelled as such in the section body: nothing here
 * is a result we are promising, and no client's real numbers appear in public.
 */
const OUTCOMES: readonly Outcome[] = [
  {
    value: '1,284',
    label: 'Leads found',
    detail: 'People who match the buyer you described.',
    Glyph: MagnifyingGlass,
  },
  {
    value: '3,146',
    label: 'Emails sent',
    detail: 'Sent from your own mailbox, in small batches, at normal hours.',
    Glyph: PaperPlaneTilt,
  },
  {
    value: '184',
    label: 'Replies',
    detail: 'Answered in your voice. Follow-ups stop the moment someone replies.',
    Glyph: ChatCircle,
  },
  {
    value: '68',
    label: 'Meetings booked',
    detail: 'Booked straight into your calendar, with notes on the company attached.',
    Glyph: CalendarCheck,
  },
]

/** Worked example under the grid. Every input is stated so the arithmetic is checkable. */
const REVENUE_EXAMPLE = {
  meetings: 68,
  averageDeal: '$10,000',
  closeRate: '30%',
  newBusiness: '$204,000',
} as const

export function Outcomes(): React.ReactElement {
  return (
    <section id="outcomes" className="scroll-mt-28 px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[20ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            Four numbers we track.{' '}
            <Highlighter
              action="circle"
              color={LANDING_HIGHLIGHT_COLOR}
              strokeWidth={2}
              padding={6}
              startDelay={HEADLINE_HIGHLIGHT_DELAY_MS}
            >
              One you close.
            </Highlighter>
          </h2>
          <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
            Everything here is meant to grow that fourth number. These are example figures for one
            month, just to show how the numbers connect — not a promise of your results.
          </p>
        </Reveal>

        <div className="mt-14 grid gap-x-8 gap-y-12 border-t border-[var(--l-hairline-strong)] pt-12 sm:grid-cols-2 lg:grid-cols-4">
          {OUTCOMES.map(({ value, label, detail, Glyph }, index) => (
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
          ))}
        </div>

        <Reveal delay={0.2}>
          <div className="mt-16 rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] p-1.5">
            <div className="rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] px-6 py-8 sm:px-10 sm:py-10">
              <p className="text-lg font-medium tracking-tight">
                The fifth number is{' '}
                <Highlighter
                  action="highlight"
                  color={LANDING_HIGHLIGHT_COLOR}
                  padding={2}
                  startDelay={REVEAL_DURATION_MS + 200}
                >
                  yours
                </Highlighter>
                .
              </p>
              <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {REVENUE_EXAMPLE.meetings} meetings, a {REVENUE_EXAMPLE.averageDeal} average deal,
                and a {REVENUE_EXAMPLE.closeRate} close rate adds up to{' '}
                {REVENUE_EXAMPLE.newBusiness} in new business from one month. Use your own numbers
                to see what a month could be worth to you.
              </p>
              <div className="mt-8">
                <BookMeetingButton size="lg" />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
