import { X } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

/** What the four numbers cost when you produce them by hand. */
const COSTS: readonly string[] = [
  'Two hours of every morning spent building the list.',
  'Openers rewritten at midnight because the last batch read like a template.',
  'Follow-ups nobody remembered to send, on the people most likely to answer.',
  'A quarter of that, and a handful of meetings to show for it.',
]

export function TheGrind(): React.ReactElement {
  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            Doing it yourself is a second job that pays in maybes.
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
            That is the part we take.
          </p>
          <div className="mt-8">
            <BookMeetingButton size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
