// One-off: Uniforms Fashion's operator does not want to contact companies in
// the United States. Adds 'united states' to every one of the client's
// campaigns' icp.excludeOrganizationLocations (organization_not_locations[]
// on the Apollo search — see src/lib/apollo/build-search-params.ts), so
// discovery stops surfacing US-based companies for this client going
// forward. Leaves every other icp field untouched. Skips a campaign whose
// exclude list already contains 'united states' (case-insensitive) —
// idempotent, safe to re-run.
//
// Defaults to a dry run — prints what it would change but writes nothing.
// Pass --apply to persist.
//
//   pnpm tsx scripts/exclude-usa-uniforms-fashion-campaigns.ts            # dry run
//   pnpm tsx scripts/exclude-usa-uniforms-fashion-campaigns.ts --apply    # persists
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '../src/types/database'
import { apolloIcpSchema } from '../src/lib/apollo/types'
import { AppError } from '../src/lib/errors/app-error'

const UNIFORMS_FASHION_CLIENT_ID = 'd99edf8f-b185-47b2-9615-1f6e43853001'
const EXCLUDE_LOCATION = 'united states'

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
})

function loadEnv(): z.infer<typeof envSchema> {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new AppError('CONFIG_ERROR', 'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY', {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const env = loadEnv()
  const supabase = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })

  const { data: client, error: clientError } = await supabase
    .from('clients')
    .select('id, name')
    .eq('id', UNIFORMS_FASHION_CLIENT_ID)
    .maybeSingle()
  if (clientError) {
    throw new AppError('DB_ERROR', 'Failed to load Uniforms Fashion client row', { cause: clientError.message })
  }
  if (!client || client.name !== 'Uniforms Fashion') {
    throw new AppError('INVARIANT_VIOLATION', 'Client id no longer resolves to Uniforms Fashion — refusing to run', {
      found: client,
    })
  }

  const { data: campaigns, error: campaignsError } = await supabase
    .from('campaigns')
    .select('id, name, icp')
    .eq('client_id', UNIFORMS_FASHION_CLIENT_ID)
  if (campaignsError) {
    throw new AppError('DB_ERROR', 'Failed to list campaigns for Uniforms Fashion', {
      cause: campaignsError.message,
    })
  }
  if (!campaigns || campaigns.length === 0) {
    console.log('No campaigns found for Uniforms Fashion — nothing to do.')
    return
  }

  console.log(`Mode: ${apply ? 'APPLY (writing to DB)' : 'DRY RUN (preview only — pass --apply to write)'}\n`)

  for (const campaign of campaigns) {
    const parsed = apolloIcpSchema.safeParse(campaign.icp)
    if (!parsed.success) {
      throw new AppError('DB_ERROR', 'Campaign icp does not match apolloIcpSchema — refusing to guess its shape', {
        campaignId: campaign.id,
        campaignName: campaign.name,
        issues: parsed.error.issues,
      })
    }
    const icp = parsed.data
    const alreadyExcluded = icp.excludeOrganizationLocations.some(
      (location) => location.trim().toLowerCase() === EXCLUDE_LOCATION,
    )
    if (alreadyExcluded) {
      console.log(`[skip]   ${campaign.name} — already excludes United States`)
      continue
    }

    const nextIcp = {
      ...icp,
      excludeOrganizationLocations: [...icp.excludeOrganizationLocations, EXCLUDE_LOCATION],
    }
    console.log(`[update] ${campaign.name} — excludeOrganizationLocations: ` +
      `${JSON.stringify(icp.excludeOrganizationLocations)} -> ${JSON.stringify(nextIcp.excludeOrganizationLocations)}`)

    if (!apply) continue

    const { error: updateError } = await supabase.from('campaigns').update({ icp: nextIcp }).eq('id', campaign.id)
    if (updateError) {
      throw new AppError('DB_ERROR', 'Failed to update campaign icp', {
        campaignId: campaign.id,
        campaignName: campaign.name,
        cause: updateError.message,
      })
    }
  }

  console.log(apply ? '\nDone — campaigns updated.' : '\nDry run complete — pass --apply to write these changes.')
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
