import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const nonEmpty = z.string().min(1)

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  APP_URL: z.string().url(),
  GOOGLE_OAUTH_CLIENT_ID: nonEmpty,
  GOOGLE_OAUTH_CLIENT_SECRET: nonEmpty,
  MICROSOFT_OAUTH_CLIENT_ID: nonEmpty,
  MICROSOFT_OAUTH_CLIENT_SECRET: nonEmpty,
  QSTASH_TOKEN: nonEmpty,
  QSTASH_CURRENT_SIGNING_KEY: nonEmpty,
  QSTASH_NEXT_SIGNING_KEY: nonEmpty,
  BRIGHTDATA_API_KEY: nonEmpty,
  GEMINI_API_KEY: nonEmpty,
  EMAILABLE_API_KEY: nonEmpty,
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new AppError('CONFIG_ERROR', `Invalid environment configuration: ${issues}`, {
      issues: parsed.error.flatten().fieldErrors,
    })
  }
  return parsed.data
}

export const env: Env = loadEnv(process.env)
