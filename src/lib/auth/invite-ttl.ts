/**
 * The invite window and how it is described.
 *
 * Deliberately separate from `invite-token.ts`, which reaches for `node:crypto`
 * and therefore cannot be imported by a Client Component. The operator-facing
 * invite dialog needs to quote the window, so the value and its wording have
 * to live somewhere that runs on both sides.
 */

/**
 * How long an invite link stays usable.
 *
 * Wide enough to survive email: a recipient who doesn't read their mail the
 * same day still gets in, which a couple of hours would not have allowed.
 * The cost is that within the window the link is a bearer credential —
 * anyone holding it can open the account repeatedly — so this trades
 * exposure for the invite actually working. This is the only place the
 * duration is defined.
 */
const INVITE_TTL_DAYS = 3
export const INVITE_TTL_MINUTES = INVITE_TTL_DAYS * 24 * 60

/**
 * The window as a person would say it. Copy reads "3 days", never
 * "4320 minutes", and the two must not be able to drift apart.
 */
export function formatInviteTtl(minutes: number): string {
  if (minutes >= 1440 && minutes % 1440 === 0) {
    const days = minutes / 1440
    return `${days} day${days === 1 ? '' : 's'}`
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MINUTES * 60 * 1000)
}
