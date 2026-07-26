import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// 32 bytes of CSPRNG output. Base64url so the token survives a URL untouched
// and no escaping can alter it in transit.
const TOKEN_BYTES = 32

export function generateInviteToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Hex SHA-256 of the raw token.
 *
 * Only the hash is stored. The link is a bearer credential, so keeping the raw
 * value in the database would make a leaked dump directly replayable into
 * every outstanding invite. SHA-256 without a salt is right here, unlike for
 * passwords: the input is 32 random bytes, so there is no dictionary to attack
 * and per-row salting would only prevent the by-hash lookup this relies on.
 */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Constant-time comparison of two hex token hashes.
 *
 * The database lookup is by primary key, which is not constant-time, so this
 * is defence in depth rather than the only guard. Lengths are compared first
 * because `timingSafeEqual` throws on a mismatch.
 */
export function inviteTokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
