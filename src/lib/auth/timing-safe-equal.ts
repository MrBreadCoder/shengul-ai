import { timingSafeEqual } from 'node:crypto'

// Constant-time string comparison for security-sensitive equality checks
// (CSRF state nonces, webhook signatures) where `===` would leak how many
// leading bytes matched via response timing.
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
