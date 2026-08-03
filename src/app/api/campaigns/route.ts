import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createCampaignSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1),
  valueProp: z.string().min(1),
  bookingLink: z.string().url().nullable().default(null),
  dailyTarget: z.number().int().min(1).max(100).default(50),
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nullable().default(null),
  employeeRangeMax: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  excludeOrganizationLocations: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
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
    })
    const admin = createAdminClient()
    // The campaign inherits the client's current reply-mode preference rather
    // than the column default, so a client already on auto_send doesn't get a
    // new campaign silently created on human_approve.
    const client = await getClientById(admin, body.clientId)
    if (!client) {
      return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
    }
    const campaign = await insertCampaign(admin, {
      client_id: body.clientId,
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      reply_mode: client.reply_mode,
      icp,
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
