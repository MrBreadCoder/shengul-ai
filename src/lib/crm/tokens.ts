import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'

export interface CrmOAuthCredentials {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
}

const credentialsSchema = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

const encryptedTokensSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
})

function encryptionKey(): Buffer {
  return Buffer.from(env.MAILBOX_ENCRYPTION_KEY, 'hex')
}

/**
 * Encrypts CRM OAuth tokens for storage in `crm_connections.oauth`. RLS grants
 * a client-role session SELECT on its own connection row, so plaintext here
 * would hand a live refresh token to anyone who can query PostgREST directly.
 * Reuses MAILBOX_ENCRYPTION_KEY — one key, one rotation story.
 */
export function encryptCrmTokens(tokens: CrmOAuthCredentials): Record<string, Json> {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(tokens), 'utf-8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  }
}

/**
 * Validates the stored jsonb into typed credentials. Accepts ONLY the encrypted
 * envelope — unlike mailbox tokens there is no legacy plaintext shape, because
 * these tables were created after encryption existed. Throws on anything else:
 * a connection with unusable credentials is a programming/config error.
 */
export function parseCrmTokens(oauth: Json, connectionId: string): CrmOAuthCredentials {
  const encrypted = encryptedTokensSchema.safeParse(oauth)
  if (!encrypted.success) {
    throw new AppError('INVARIANT_VIOLATION', 'CRM connection oauth is not an encrypted envelope', {
      connectionId,
    })
  }
  // `encrypted.data` is the Zod-parsed envelope; its own ciphertext field is
  // also called `data`, hence `encrypted.data.data` below.
  const envelope = encrypted.data
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ])
    const parsed = credentialsSchema.safeParse(JSON.parse(plaintext.toString('utf-8')))
    if (!parsed.success) throw new Error('decrypted payload failed schema validation')
    return parsed.data
  } catch (cause) {
    throw new AppError('INVARIANT_VIOLATION', 'Failed to decrypt CRM connection oauth tokens', {
      connectionId,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
