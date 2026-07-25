import { initialsFor } from '@/lib/format'

interface BookedMeeting {
  readonly company: string
  readonly kind: string
  readonly when: string
}

/**
 * Illustrative meetings, labelled as such in the frame header. Deliberately not
 * fetched: the marketing page is public, and no real client's calendar may
 * appear on it. Company names are invented.
 */
const MEETINGS: readonly BookedMeeting[] = [
  { company: 'Halvorsen Logistik', kind: 'Intro call', when: 'Tue 09:30' },
  { company: 'Nordkap Fertigung', kind: 'Second call', when: 'Wed 14:00' },
  { company: 'Vantera Diagnostics', kind: 'Intro call', when: 'Thu 11:15' },
]

const MEETINGS_BOOKED = 68

/**
 * The hero's visual. It shows the one number the product is bought for, and
 * the three nearest meetings behind it, rather than a pipeline of statuses:
 * a visitor should be able to tell what they get without reading a legend.
 */
export function OutcomePanel(): React.ReactElement {
  return (
    <div className="rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] p-1.5">
      <div className="overflow-hidden rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] shadow-[inset_0_1px_0_color-mix(in_oklch,white_8%,transparent)]">
        <div className="flex items-center justify-between border-b border-[var(--l-hairline)] px-5 py-3.5">
          <span className="text-[13px] font-medium">This month</span>
          <span className="rounded-full bg-[color-mix(in_oklch,white_7%,transparent)] px-2.5 py-1 font-mono text-[10px] text-[var(--l-faint)]">
            Example figures
          </span>
        </div>

        <div className="flex items-end gap-4 px-5 pt-6 pb-6">
          <p className="font-mono text-[3.5rem] leading-[0.85] tracking-tighter tabular-nums">
            {MEETINGS_BOOKED}
          </p>
          <p className="pb-1 text-[15px] leading-snug text-[var(--l-muted)]">
            meetings booked
            <br />
            from your own mailbox
          </p>
        </div>

        <ul className="divide-y divide-[var(--l-hairline)] border-t border-[var(--l-hairline)]">
          {MEETINGS.map(({ company, kind, when }) => (
            <li key={company} className="flex items-center gap-3 px-5 py-3.5">
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_oklch,white_8%,transparent)] text-[10px] font-semibold tracking-tight text-[var(--l-muted)]"
              >
                {initialsFor(company)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{company}</p>
                <p className="text-[11px] text-[var(--l-faint)]">{kind}</p>
              </div>
              <span className="font-mono text-[11px] text-[var(--l-muted)] tabular-nums">
                {when}
              </span>
            </li>
          ))}
        </ul>

        <div className="border-t border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] px-5 py-3">
          <span className="text-[11px] text-[var(--l-muted)]">
            Each one asked for the time themselves.
          </span>
        </div>
      </div>
    </div>
  )
}
