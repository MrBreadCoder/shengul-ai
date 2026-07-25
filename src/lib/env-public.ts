import { z } from 'zod'
import { parseEnv } from '@/lib/env-parse'

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
})

export type PublicEnv = z.infer<typeof publicEnvSchema>

export function loadPublicEnv(source: Record<string, string | undefined>): PublicEnv {
  return parseEnv(publicEnvSchema, source)
}

// Next.js inlines NEXT_PUBLIC_* vars into the client bundle only for literal
// `process.env.X` member access. Reading `process.env` as an object yields `{}` in the
// browser, so every public var must be listed explicitly below.
export const publicEnv: PublicEnv = loadPublicEnv({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
})
