import type { Icon } from '@phosphor-icons/react'
import { CalendarCheck, ChatsCircle, Crosshair, PenNib } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
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
      'One call. You tell us what you sell and who should be hearing about it, and we build the campaign and the audience around that answer. That is the whole setup on your side.',
    Glyph: ChatsCircle,
  },
  {
    title: 'The system finds the qualified leads.',
    detail:
      'Every morning it goes out and comes back with people who match the buyer you described, checked against what you actually sell, with the homework already done on each company.',
    Glyph: Crosshair,
  },
  {
    title: 'It writes an email for that one person.',
    detail:
      'Not a template with a name dropped into it. The opening line comes from something true about that company this month, in your voice, from your own address.',
    Glyph: PenNib,
  },
  {
    title: 'You join the meetings.',
    detail:
      'It keeps going while you sleep, follows up on its own, and stops the second somebody replies. Your calendar link goes out, the time gets booked, and you wake up to meetings instead of a list.',
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
                Four steps. Two of them are yours.
              </h2>
              <p className="mt-5 max-w-[38ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                Nothing to learn, nothing to log into every morning. Your part is the first step
                and the last one. Everything between them is handled.
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
