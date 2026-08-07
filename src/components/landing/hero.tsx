import { ArrowDown } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
import { OutcomePanel } from './outcome-panel'
import { Reveal } from './reveal'

/**
 * Asymmetric split hero: the promise on the left, the morning it produces on
 * the right. Four text elements only (eyebrow, headline, subtext, actions) so
 * the whole thing clears the fold on a laptop.
 */
export function Hero(): React.ReactElement {
  return (
    <section className="relative isolate overflow-hidden px-4 pt-24 pb-20 md:flex md:min-h-[100dvh] md:items-center md:pb-28">
      {/* Ambient wash. One static gradient, no blur filter, so it costs one
          paint. Monochrome, so it lifts the panel off the page without
          introducing a hue the rest of the composition does not use. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(65%_55%_at_74%_14%,color-mix(in_oklch,white_9%,transparent),transparent_68%)]"
      />

      <div className="mx-auto grid w-full max-w-[1180px] items-center gap-14 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-6 xl:col-span-6">
          <Reveal>
            <span className="inline-flex rounded-full border border-[var(--l-hairline-strong)] px-3 py-1 text-[10px] font-medium tracking-[0.2em] text-[var(--l-muted)] uppercase">
              Outbound, handled
            </span>
          </Reveal>

          <Reveal delay={0.06}>
            <h1 className="mt-7 text-[2.75rem] leading-[1.02] font-medium tracking-tighter text-balance sm:text-6xl lg:text-[4.25rem]">
              We book your meetings. You skip the outbound work.
            </h1>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-6 max-w-[46ch] text-[15px] leading-relaxed text-[var(--l-muted)] sm:text-base">
              Tell us who you want to reach. We find them, email them, and pass you the ones who
              book a call.
            </p>
          </Reveal>

          <Reveal delay={0.18}>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <BookMeetingButton size="lg" />
              <a
                href="#how"
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--l-hairline-strong)] py-2.5 pr-5 pl-5 text-[15px] text-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
              >
                See how it works
                <ArrowDown
                  weight="light"
                  aria-hidden
                  className="size-4 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-y-0.5"
                />
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.24} className="lg:col-span-6 xl:col-start-7">
          <OutcomePanel />
        </Reveal>
      </div>
    </section>
  )
}
