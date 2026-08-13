'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { initialsFor } from '@/lib/format'
import { LANDING_EASE } from './constants'

export interface BookedMeeting {
  readonly company: string
  readonly kind: string
  readonly when: string
}

export interface OutcomePanelCopy {
  readonly thisMonth: string
  readonly live: string
  readonly exampleFigures: string
  readonly meetingsBookedLine1: string
  readonly meetingsBookedLine2: string
  readonly new: string
  readonly footerNote: string
  readonly meetingPool: readonly BookedMeeting[]
}

const VISIBLE_ROWS = 3
const MEETINGS_BOOKED_BASE = 68
const ROLL_INTERVAL_MS = 4500
/** How long a freshly-arrived row stays highlighted before it settles in. */
const HIGHLIGHT_DURATION_S = 1.4

/**
 * Reads `pool` at a wrapped index. `index` here is always produced by a
 * modulo against `pool.length`, so it is always in range — the throw only
 * fires if that invariant is ever broken by a future edit.
 */
function poolAt(pool: readonly BookedMeeting[], index: number): BookedMeeting {
  const wrapped = ((index % pool.length) + pool.length) % pool.length
  const meeting = pool[wrapped]
  if (!meeting) throw new Error(`meetingPool invariant violated: no entry at index ${wrapped}`)
  return meeting
}

interface RollingMeetingsState {
  readonly visible: readonly BookedMeeting[]
  readonly newestCompany: string
  readonly meetingsBooked: number
  readonly isLive: boolean
}

/**
 * Advances a cursor through `pool` on an interval, exposing the three most
 * recently "arrived" meetings and a monthly count that climbs through
 * `pool.length - VISIBLE_ROWS` ticks and then holds — the visual roll keeps
 * looping so the panel stays alive, but the headline number never runs away.
 *
 * Under `prefers-reduced-motion` the interval never starts: the panel renders
 * the same static first three rows and base count it always has, matching
 * `Reveal`'s reduced-motion contract elsewhere on this page.
 */
function useRollingMeetings(pool: readonly BookedMeeting[]): RollingMeetingsState {
  const prefersReducedMotion = useReducedMotion()
  const [cursor, setCursor] = useState(VISIBLE_ROWS - 1)
  const [tick, setTick] = useState(0)
  const rollIncrements = pool.length - VISIBLE_ROWS

  useEffect(() => {
    if (prefersReducedMotion) return

    const id = setInterval(() => {
      setCursor((current) => (current + 1) % pool.length)
      setTick((current) => current + 1)
    }, ROLL_INTERVAL_MS)

    return () => clearInterval(id)
  }, [prefersReducedMotion, pool.length])

  const visible = Array.from({ length: VISIBLE_ROWS }, (_, offset) =>
    poolAt(pool, cursor - (VISIBLE_ROWS - 1 - offset)),
  )

  return {
    visible,
    newestCompany: poolAt(pool, cursor).company,
    meetingsBooked: MEETINGS_BOOKED_BASE + Math.min(tick, rollIncrements),
    isLive: !prefersReducedMotion,
  }
}

/** Pulsing dot + label. Monochrome, matching this page's zero-chroma palette. */
function LiveBadge({ label, isLive }: { label: string; isLive: boolean }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,white_7%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--l-muted)]">
      <span className="relative flex size-1.5">
        {isLive && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--l-accent)] opacity-75" />
        )}
        <span className="relative inline-flex size-1.5 rounded-full bg-[var(--l-accent)]" />
      </span>
      {label}
    </span>
  )
}

/**
 * The hero's visual. It shows the one number the product is bought for, and
 * the three nearest meetings behind it, rather than a pipeline of statuses:
 * a visitor should be able to tell what they get without reading a legend.
 * The list rolls new illustrative meetings in on a timer so the panel reads
 * as an active pipeline, not a screenshot.
 */
export function OutcomePanel({ copy }: { copy: OutcomePanelCopy }): React.ReactElement {
  const { visible, newestCompany, meetingsBooked, isLive } = useRollingMeetings(copy.meetingPool)

  return (
    <div className="rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] p-1.5">
      <div className="overflow-hidden rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] shadow-[inset_0_1px_0_color-mix(in_oklch,white_8%,transparent)]">
        <div className="flex items-center justify-between border-b border-[var(--l-hairline)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">{copy.thisMonth}</span>
            <LiveBadge label={copy.live} isLive={isLive} />
          </div>
          <span className="rounded-full bg-[color-mix(in_oklch,white_7%,transparent)] px-2.5 py-1 font-mono text-[10px] text-[var(--l-faint)]">
            {copy.exampleFigures}
          </span>
        </div>

        <div className="flex items-end gap-4 px-5 pt-6 pb-6">
          <p className="relative h-[3rem] overflow-hidden font-mono text-[3.5rem] leading-[0.85] tracking-tighter tabular-nums">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={meetingsBooked}
                className="block"
                initial={{ y: 14, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -14, opacity: 0 }}
                transition={{ duration: 0.4, ease: LANDING_EASE }}
              >
                {meetingsBooked}
              </motion.span>
            </AnimatePresence>
          </p>
          <p className="pb-1 text-[15px] leading-snug text-[var(--l-muted)]">
            {copy.meetingsBookedLine1}
            <br />
            {copy.meetingsBookedLine2}
          </p>
        </div>

        <ul className="divide-y divide-[var(--l-hairline)] border-t border-[var(--l-hairline)]">
          <AnimatePresence mode="popLayout" initial={false}>
            {visible.map(({ company, kind, when }) => {
              const isNewest = company === newestCompany && isLive

              return (
                <motion.li
                  key={company}
                  layout
                  initial={{ opacity: 0, y: -18 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 18 }}
                  transition={{ duration: 0.55, ease: LANDING_EASE }}
                  className="relative flex items-center gap-3 px-5 py-3.5"
                >
                  {isNewest && (
                    <motion.span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 bg-[var(--l-accent-soft)]"
                      initial={{ opacity: 1 }}
                      animate={{ opacity: 0 }}
                      transition={{ duration: HIGHLIGHT_DURATION_S, ease: 'easeOut' }}
                    />
                  )}
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_oklch,white_8%,transparent)] text-[10px] font-semibold tracking-tight text-[var(--l-muted)]"
                  >
                    {initialsFor(company)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                      <span className="truncate">{company}</span>
                      {isNewest && (
                        <motion.span
                          initial={{ opacity: 1 }}
                          animate={{ opacity: 0 }}
                          transition={{ duration: HIGHLIGHT_DURATION_S, ease: 'easeOut' }}
                          className="shrink-0 rounded-full bg-[var(--l-accent)] px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-[var(--l-accent-ink)] uppercase"
                        >
                          {copy.new}
                        </motion.span>
                      )}
                    </p>
                    <p className="text-[11px] text-[var(--l-faint)]">{kind}</p>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--l-muted)] tabular-nums">
                    {when}
                  </span>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>

        <div className="border-t border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] px-5 py-3">
          <span className="text-[11px] text-[var(--l-muted)]">{copy.footerNote}</span>
        </div>
      </div>
    </div>
  )
}
