import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, deleteCampaign, updateCampaignSettings, recomputeCampaignNextDiscoverAt } from '@/lib/db/campaigns'
import { assertMailboxesBelongToClient } from '@/lib/db/mailboxes'
import { campaignSettingsSchema } from '@/lib/apollo/campaign-settings-schema'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { formatZodMessage } from '@/lib/errors/format-zod-message'

export const runtime = 'nodejs'

const deleteSchema = z.object({
  confirmName: z.string().min(1),
})

// Deletes the campaign row, cascading (via FK) to every case, lead, email,
// and sequence under it. Irreversible.
export async function DELETE(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = deleteSchema.parse(await request.json())
    if (body.confirmName !== campaign.name) {
      return NextResponse.json({ error: 'name_mismatch' }, { status: 400 })
    }

    await deleteCampaign(admin, campaignId)

    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.deleted',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded, and
      // campaignId no longer references a real row, but events.client_id
      // still references a real client, so this insert is still valid.
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: formatZodMessage(error), issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}

// Updates a campaign's editable settings (name, value prop, booking link,
// daily target, contacts per company, ICP filters). client_id and status
// are not editable here — status has its own stop/resume/delete actions,
// client_id is immutable.
export async function PATCH(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = campaignSettingsSchema.parse(await request.json())
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
    // Unlike create, an edit may save with zero mailboxes: an already-broken
    // campaign (mailbox_ids: []) must still be openable and saveable so an
    // operator can fix an unrelated field, or fix the mailbox itself, without
    // the form refusing to submit on some other pre-existing gap.
    await assertMailboxesBelongToClient(admin, campaign.client_id, body.mailboxIds)

    await updateCampaignSettings(admin, campaignId, {
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      contacts_per_company: body.contactsPerCompany,
      icp,
      discover_time: body.discoverTime,
      discover_timezone: body.discoverTimezone,
      mailbox_ids: body.mailboxIds,
      signature_name: body.signatureName,
      signature_title: body.signatureTitle,
      phone: body.phone,
      address: body.address,
    })
    // Recompute unconditionally rather than diffing old vs. new — cheap,
    // and correctly handles every case: an override changed, an override
    // was cleared back to null (reverts to inheriting the client's current
    // default), or neither changed (recomputes to the same instant).
    const rescheduled = await recomputeCampaignNextDiscoverAt(admin, campaignId)

    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.updated',
        payload: { campaignId, name: rescheduled.name },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: rescheduled })
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
