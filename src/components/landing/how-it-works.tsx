import type { Icon } from '@phosphor-icons/react'
import { CalendarCheck, ChatsCircle, Crosshair, PenNib } from '@phosphor-icons/react/dist/ssr'
import { Highlighter } from '@/components/ui/highlighter'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

interface Movement {
  readonly title: string
  readonly detail: string
  readonly Glyph: Icon
}

const MOVEMENTS: readonly Movement[] = [
  {
    title: 'Talk with us.',
    detail:
      "One call. Tell us what you sell and who you want to reach. That's the whole setup.",
    Glyph: ChatsCircle,
  },
  {
    title: 'We find your leads.',
    detail:
      "Every day, we find people who match the buyer you described, and check they're a real fit for what you sell.",
    Glyph: Crosshair,
  },
  {
    title: 'We write a real email.',
    detail:
      'Not a template with a name dropped in. Each email mentions something real about that company, written in your voice, sent from your own inbox.',
    Glyph: PenNib,
  },
  {
    title: 'You take the meetings.',
    detail:
      'We follow up until someone replies, then stop right away. The meeting lands on your calendar, waiting for you in the morning.',
    Glyph: CalendarCheck,
  },
]

export function HowItWorks(): React.ReactElement {
  return (
    <section id="how" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto grid max-w-[1180px] gap-14 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-4">
          <div className="lg:sticky lg:top-32">
            <Reveal>
              <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
                Four steps. You only do{' '}
                <Highlighter
                  action="circle"
                  color={LANDING_HIGHLIGHT_COLOR}
                  strokeWidth={2}
                  padding={5}
                  startDelay={REVEAL_DURATION_MS}
                >
                  two of them
                </Highlighter>
                .
              </h2>
              <p className="mt-5 max-w-[38ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                Nothing to learn, nothing to check every morning. You start it and show up to the
                meetings — we handle everything in between, and report back as{' '}
                <InlineLink href="#outcomes">four numbers</InlineLink>.
              </p>
            </Reveal>
          </div>
        </div>

        <div className="lg:col-span-7 lg:col-start-6">
          <ol className="border-l border-[var(--l-hairline)] pl-8 lg:pl-12">
            {MOVEMENTS.map(({ title, detail, Glyph }, index) => (
              <li key={title} className="relative pb-14 last:pb-0">
                <Reveal delay={index * 0.05}>
                  {/* From `lg` the tile straddles the rule: half its width plus
                      the 1px rule itself, pulled back out of the list's padding.
                      Below that the container is too narrow to hang anything
                      outside it, so the tile sits in flow above the heading
                      instead of being clipped by the page gutter. */}
                  <span
                    aria-hidden
                    className="mb-5 grid size-10 place-items-center rounded-full border border-[var(--l-hairline-strong)] bg-[var(--l-bg)] text-[var(--l-muted)] lg:absolute lg:-left-[calc(3rem+1.25rem+0.5px)] lg:mb-0"
                  >
                    <Glyph weight="light" className="size-5" />
                  </span>
                  <h3 className="max-w-[20ch] text-2xl font-medium tracking-tight sm:text-3xl">
                    {title}
                  </h3>
                  <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                    {detail}
                  </p>
                </Reveal>
              </li>
            ))}
          </ol>

          <Reveal delay={0.2}>
            <div className="mt-14 pl-8 lg:pl-12">
              <BookMeetingButton size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
