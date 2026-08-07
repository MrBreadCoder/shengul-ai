import { X } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

/** What the four numbers cost when you produce them by hand. */
const COSTS: readonly string[] = [
  'Hours every morning spent building lead lists.',
  'Late nights rewriting emails that still sound like a template.',
  'Follow-ups that never get sent, even to your best leads.',
  'Days of work for just a few meetings booked.',
]

export function TheGrind(): React.ReactElement {
  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            Doing this yourself takes hours and rarely pays off.
          </h2>
        </Reveal>

        <ul className="mt-14 grid gap-x-10 gap-y-8 md:grid-cols-2">
          {COSTS.map((cost, index) => (
            <li key={cost}>
              <Reveal delay={index * 0.05}>
                <div className="flex gap-4 border-t border-[var(--l-hairline)] pt-6">
                  {/* Marks the item as a cost, not decoration: every line in this
                      list is something the product removes. */}
                  <X
                    weight="light"
                    aria-hidden
                    className="mt-1 size-[18px] shrink-0 text-[var(--l-faint)]"
                  />
                  <p className="text-lg leading-snug text-[var(--l-muted)]">{cost}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>

        <Reveal delay={0.24}>
          <p className="mt-14 text-lg leading-snug text-[var(--l-text)] sm:text-xl">
            We take all of that off your plate.
          </p>
          <div className="mt-8">
            <BookMeetingButton size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
