import { z } from 'zod'
import { parseEnv } from '@/lib/env-parse'

export const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  // Optional: GTM is not required for local dev/tests, and its absence must
  // not break app startup — the layout simply skips rendering the snippet.
  NEXT_PUBLIC_GTM_ID: z.string().regex(/^GTM-[A-Z0-9]+$/, 'must look like GTM-XXXXXXX').optional(),
  // Optional: search-engine ownership verification tokens. Absence just means
  // the corresponding <meta> tag is omitted from the page head.
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: z.string().min(1).optional(),
  NEXT_PUBLIC_BING_SITE_VERIFICATION: z.string().min(1).optional(),
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
  NEXT_PUBLIC_GTM_ID: process.env.NEXT_PUBLIC_GTM_ID,
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION: process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION,
  NEXT_PUBLIC_BING_SITE_VERIFICATION: process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION,
})
