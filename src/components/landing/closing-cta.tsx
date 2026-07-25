import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

export function ClosingCta(): React.ReactElement {
  return (
    <section className="px-4 pt-8 pb-28 md:pb-36">
      <div className="mx-auto max-w-[1180px] rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] p-1.5">
        <div className="relative isolate overflow-hidden rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] px-6 py-20 text-center sm:px-12 sm:py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(80%_120%_at_50%_100%,color-mix(in_oklch,var(--l-accent)_20%,transparent),transparent_65%)]"
          />
          <Reveal>
            <h2 className="mx-auto max-w-[18ch] text-[2.25rem] leading-[1.05] font-medium tracking-tight text-balance sm:text-[3rem]">
              Tell us who you want to meet.
            </h2>
            <p className="mx-auto mt-6 max-w-[46ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
              Half an hour is enough. You describe the buyer, we show you what the first month
              would look like, and you decide from there.
            </p>
            <div className="mt-10 flex justify-center">
              <BookMeetingButton size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
