import { AppError } from '@/lib/errors/app-error'

// A CR or LF inside a header value lets an attacker inject extra headers (or
// end the header block early and forge the body) into the raw RFC 2822
// message. None of these fields ever legitimately contain a line break, and
// In-Reply-To / References are round-tripped from inbound headers the
// counterparty controls, so this is a real injection surface.
export function assertNoHeaderInjection(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'Email header value contains illegal line break characters', { field })
  }
  return value
}
