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
 * Wide enough to survive email: a recipient who reads their mail an hour later
 * still gets in, which a few minutes would not have allowed. The cost is that
 * within the window the link is a bearer credential — anyone holding it can
 * open the account repeatedly — so this trades exposure for the invite
 * actually working. This is the only place the duration is defined.
 */
export const INVITE_TTL_MINUTES = 120

/**
 * The window as a person would say it. Copy reads "2 hours", never
 * "120 minutes", and the two must not be able to drift apart.
 */
export function formatInviteTtl(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

export function inviteExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + INVITE_TTL_MINUTES * 60 * 1000)
}
