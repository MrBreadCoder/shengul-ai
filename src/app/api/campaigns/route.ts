import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { campaignSettingsSchema } from '@/lib/apollo/campaign-settings-schema'
import { computeNextRunAt } from '@/lib/scheduling/next-run'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createCampaignSchema = campaignSettingsSchema.extend({
  clientId: z.string().uuid(),
})

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const body = createCampaignSchema.parse(await request.json())
    const icp = apolloIcpSchema.parse({
      personTitles: body.personTitles,
      organizationLocations: body.organizationLocations,
      employeeRangeMin: body.employeeRangeMin,
      employeeRangeMax: body.employeeRangeMax,
      keywords: body.keywords,
      excludeOrganizationLocations: body.excludeOrganizationLocations,
      excludeKeywords: body.excludeKeywords,
      personSeniorities: body.personSeniorities,
      contactEmailStatuses: body.contactEmailStatuses,
    })
    const admin = createAdminClient()
    // The campaign inherits the client's current reply-mode preference rather
    // than the column default, so a client already on auto_send doesn't get a
    // new campaign silently created on human_approve.
    const client = await getClientById(admin, body.clientId)
    if (!client) {
      return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
    }
    const effectiveTime = body.discoverTime ?? client.default_discover_time
    const effectiveTimezone = body.discoverTimezone ?? client.timezone
    const nextDiscoverAt = computeNextRunAt(new Date(), effectiveTime, effectiveTimezone)
    const campaign = await insertCampaign(admin, {
      client_id: body.clientId,
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      reply_mode: client.reply_mode,
      icp,
      discover_time: body.discoverTime,
      discover_timezone: body.discoverTimezone,
      next_discover_at: nextDiscoverAt.toISOString(),
    })
    try {
      await logEvent({
        clientId: body.clientId,
        actor: `human:${appUser.id}`,
        type: 'campaign.created',
        payload: { campaignId: campaign.id, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the campaign was created successfully
      // and must not be reported as failed just because the log write failed.
    }
    return NextResponse.json({ ok: true, campaign })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
