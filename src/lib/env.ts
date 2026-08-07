import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'
import { parseEnv } from '@/lib/env-parse'
import { publicEnvSchema } from '@/lib/env-public'

const nonEmpty = z.string().min(1)
// AES-256-GCM key for mailbox OAuth tokens at rest — exactly 32 bytes, hex-encoded.
// Generate with `openssl rand -hex 32`.
const hexKey32 = z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex string (32 bytes)')

const envSchema = publicEnvSchema.extend({
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  APP_URL: z.string().url(),
  GOOGLE_OAUTH_CLIENT_ID: nonEmpty,
  GOOGLE_OAUTH_CLIENT_SECRET: nonEmpty,
  MICROSOFT_OAUTH_CLIENT_ID: nonEmpty,
  MICROSOFT_OAUTH_CLIENT_SECRET: nonEmpty,
  MAILBOX_ENCRYPTION_KEY: hexKey32,
  QSTASH_TOKEN: nonEmpty,
  QSTASH_CURRENT_SIGNING_KEY: nonEmpty,
  QSTASH_NEXT_SIGNING_KEY: nonEmpty,
  // QStash now runs two fully independent regions (US/EU) with no shared
  // state; the unprefixed https://qstash.upstash.io endpoint resolves
  // ambiguously and does not reliably reach a us-east-1 account (see
  // .claude/roadmap.md 2026-08-07 incident — this cost 3 days of silent
  // cron outage). Optional so tests/local scaffolding without a real
  // QStash account keep working; src/lib/qstash/client.ts falls back to
  // the us-east-1 endpoint (this app's AWS region) when unset.
  QSTASH_URL: z.string().url().optional(),
  BRIGHTDATA_API_KEY: nonEmpty,
  BRIGHTDATA_SCRAPE_ZONE: nonEmpty,
  GEMINI_API_KEY: nonEmpty,
  APOLLO_API_KEY: nonEmpty,
  EMAILABLE_API_KEY: nonEmpty,
  MAILREACH_API_KEY: nonEmpty,
  HUBSPOT_OAUTH_CLIENT_ID: nonEmpty,
  HUBSPOT_OAUTH_CLIENT_SECRET: nonEmpty,
  PIPEDRIVE_OAUTH_CLIENT_ID: nonEmpty,
  PIPEDRIVE_OAUTH_CLIENT_SECRET: nonEmpty,
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>): Env {
  return parseEnv(envSchema, source)
}

// Server secrets are never inlined into the client bundle, so `process.env` is `{}` in the
// browser and every var below would read as undefined. Fail with the real cause instead of a
// list of misleading "expected string, received undefined" issues.
if (typeof window !== 'undefined') {
  throw new AppError(
    'CONFIG_ERROR',
    '@/lib/env is server-only but was imported into a client bundle — import @/lib/env-public instead',
    { module: '@/lib/env' },
  )
}

export const env: Env = loadEnv(process.env)
