import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { assertMailboxesBelongToClient } from '@/lib/db/mailboxes'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { campaignSettingsSchema } from '@/lib/apollo/campaign-settings-schema'
import { computeNextRunAt } from '@/lib/scheduling/next-run'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { formatZodMessage } from '@/lib/errors/format-zod-message'

export const runtime = 'nodejs'

// Unlike PATCH, create requires at least one mailbox: a brand-new campaign
// has no legacy state to preserve, so there is no reason to let one come into
// existence already unable to send (see .claude/roadmap.md 2026-08-13 —
// every campaign in one client's account had shipped with mailbox_ids: []
// and sat drafting mail nothing could ever deliver).
const createCampaignSchema = campaignSettingsSchema
  .extend({ clientId: z.string().uuid() })
  .refine((data) => data.mailboxIds.length > 0, {
    message: 'Select at least one mailbox for this campaign to send from',
    path: ['mailboxIds'],
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
    // Rejects a mailbox id from another client (or one that never existed)
    // while the operator can still correct the form — the alternative is a
    // campaign silently pointed at mail it can never actually send from.
    await assertMailboxesBelongToClient(admin, body.clientId, body.mailboxIds)
    const effectiveTime = body.discoverTime ?? client.default_discover_time
    const effectiveTimezone = body.discoverTimezone ?? client.timezone
    const nextDiscoverAt = computeNextRunAt(new Date(), effectiveTime, effectiveTimezone)
    const campaign = await insertCampaign(admin, {
      client_id: body.clientId,
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      contacts_per_company: body.contactsPerCompany,
      reply_mode: client.reply_mode,
      icp,
      discover_time: body.discoverTime,
      discover_timezone: body.discoverTimezone,
      next_discover_at: nextDiscoverAt.toISOString(),
      mailbox_ids: body.mailboxIds,
      signature_name: body.signatureName,
      signature_title: body.signatureTitle,
      phone: body.phone,
      address: body.address,
      email_template_id: body.emailTemplateId,
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
      return NextResponse.json({ error: formatZodMessage(error), issues: error.flatten() }, { status: 400 })
    }
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
