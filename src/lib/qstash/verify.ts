import { Receiver } from '@upstash/qstash'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'

const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
})

// Verifies an inbound QStash request. Returns the raw body (needed because the
// signature is over the exact bytes). Throws UNAUTHORIZED on any failure.
export async function verifyQstashSignature(request: Request): Promise<string> {
  const signature = request.headers.get('upstash-signature')
  if (!signature) {
    throw new AppError('UNAUTHORIZED', 'Missing upstash-signature header')
  }
  const body = await request.text()
  let isValid = false
  try {
    isValid = await receiver.verify({ signature, body })
  } catch (cause) {
    throw new AppError('UNAUTHORIZED', 'QStash signature verification threw', {
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
  if (!isValid) {
    throw new AppError('UNAUTHORIZED', 'Invalid QStash signature')
  }
  return body
}
