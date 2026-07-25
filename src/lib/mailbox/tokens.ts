import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'
import type { MailboxCredentials } from './provider'

const oauthCredentialsSchema = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

const smtpCredentialsSchema = z.object({
  kind: z.literal('smtp'),
  emailAddress: z.string(),
  username: z.string(),
  password: z.string(),
  smtpHost: z.string(),
  smtpPort: z.number(),
  smtpSecure: z.boolean(),
  imapHost: z.string(),
  imapPort: z.number(),
  imapSecure: z.boolean(),
})

const credentialsSchema = z.discriminatedUnion('kind', [oauthCredentialsSchema, smtpCredentialsSchema])

// Tokens persisted before the `kind` discriminator existed. Both plaintext and
// already-encrypted rows can be in this shape, so it is checked on both paths.
const legacyOAuthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

// Accepts current tagged credentials or legacy untagged OAuth tokens,
// normalizing the latter to `kind: 'oauth'`. Returns null when neither matches.
function parseCredentialShape(value: unknown): MailboxCredentials | null {
  const tagged = credentialsSchema.safeParse(value)
  if (tagged.success) return tagged.data

  const legacy = legacyOAuthSchema.safeParse(value)
  if (legacy.success) return { kind: 'oauth', ...legacy.data }

  return null
}

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

// Encrypts mailbox OAuth tokens (AES-256-GCM) for storage in the `mailboxes.oauth`
// jsonb column. RLS grants client-role users SELECT on the mailboxes row, so
// storing tokens in plaintext would hand a live Gmail/Outlook refresh token to
// anyone who can query PostgREST directly — encryption is the defense-in-depth
// layer that survives even an RLS or app-layer field-hiding gap.
export function encryptMailboxTokens(tokens: MailboxCredentials): Record<string, Json> {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(tokens), 'utf-8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  }
}

function decryptMailboxTokens(
  encrypted: z.infer<typeof encryptedTokensSchema>,
  mailboxId: string,
): MailboxCredentials {
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, 'base64')),
      decipher.final(),
    ])
    const parsed = parseCredentialShape(JSON.parse(plaintext.toString('utf-8')))
    if (!parsed) throw new Error('decrypted payload failed schema validation')
    return parsed
  } catch (cause) {
    throw new AppError('INVARIANT_VIOLATION', 'Failed to decrypt mailbox oauth tokens', {
      mailboxId,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

// Validates the mailbox oauth jsonb into typed credentials. Throws on malformed
// input — a mailbox with unusable credentials is a programming/config error,
// not an operational one.
//
// Accepts three shapes: encrypted-at-rest (current), plaintext tagged
// credentials, and legacy untagged plaintext OAuth tokens persisted before
// encryption was added. The legacy paths are backward compatibility only —
// every refresh/reconnect re-persists via encryptMailboxTokens, so old rows
// self-heal over time without a manual backfill.
export function parseMailboxTokens(oauth: Json, mailboxId: string): MailboxCredentials {
  const encrypted = encryptedTokensSchema.safeParse(oauth)
  if (encrypted.success) return decryptMailboxTokens(encrypted.data, mailboxId)

  const parsed = parseCredentialShape(oauth)
  if (!parsed) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox oauth tokens malformed', { mailboxId })
  }
  return parsed
}
