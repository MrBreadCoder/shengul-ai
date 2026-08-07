import { Clock, Eye, Newspaper, User } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

/** The three jobs that stop landing on your desk. */
const RELIEFS: readonly string[] = ['No list building', 'No first drafts', 'No chasing']

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

export function Capabilities(): React.ReactElement {
  return (
    <section id="capabilities" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px]">
        <Reveal className="max-w-[36ch]">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            What a normal week looks like.
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-4 lg:grid-cols-12">
          <Reveal className="h-full lg:col-span-7 lg:row-span-2">
            <Tile isFeature className="h-full">
              <Clock weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="max-w-[16ch] text-xl font-medium tracking-tight sm:text-2xl">
                Get two hours back every day, and meetings on your calendar.
              </h3>
              <p className="mt-4 max-w-[44ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                The time you used to spend on lists and rewritten emails now goes to people who
                already replied and picked a time.
              </p>
              <ul className="mt-9 flex flex-wrap gap-2">
                {RELIEFS.map((relief) => (
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
                3
              </p>
              <h3 className="mt-6 text-lg font-medium tracking-tight">
                Up to 3 follow-ups, then we stop.
              </h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                Nobody is forgotten, and nobody is spammed. The moment someone replies, the
                follow-ups stop.
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-5" delay={0.1}>
            <Tile className="h-full">
              <Newspaper weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">Every email is personal.</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                Each one opens with something real about that company — not a guess, not a
                generic line.
              </p>
              <p className="mt-6 rounded-[14px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] px-4 py-3.5 text-[13px] leading-relaxed text-[var(--l-muted)]">
                Rather than: I hope this email finds you well.
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-4" delay={0.15}>
            <Tile className="h-full">
              <User weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">It sounds like a person.</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                No tracking pixel, no unsubscribe footer, no bulk markers. An email from your own
                address, sent at an hour a human would send it.
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-8" delay={0.2}>
            <Tile className="h-full">
              <Eye weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">You can read every email.</h3>
              <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                Every email we send is there for you to check. If a reply asks something we
                can&rsquo;t answer honestly, we check with you instead of guessing.
              </p>
            </Tile>
          </Reveal>
        </div>

        <Reveal delay={0.25}>
          <div className="mt-14">
            <BookMeetingButton size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
