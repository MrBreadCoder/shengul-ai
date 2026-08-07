import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getClientById,
  updateClientName,
  updateClientWarmupProfile,
  updateClientDomain,
  updateClientSignature,
  deleteClientCascade,
  listClientRoleAppUsers,
} from '@/lib/db/clients'
import { deleteAuthUsers } from '@/lib/supabase/auth-admin'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { domainSchema } from '@/lib/validation/domain'
import { phoneSchema } from '@/lib/validation/phone'

export const runtime = 'nodejs'

// Trimmed, length-capped, empty-clears-to-null — same three-step transform
// chain as domainSchema, for the three signature fields that carry no format
// constraint beyond a sane max length.
function nullableTextSchema(maxLength: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= maxLength, { message: `must be ${maxLength} characters or fewer` })
    .transform((value) => (value.length === 0 ? null : value))
}

// mailreachEnabled is deliberately NOT a field here — that boolean-flag
// mutation goes through the setClientMailreachEnabled Server Action
// (mailreach-actions.ts) instead of a client-side fetch to this route.
const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    warmupProfile: z.enum(['standard', 'slow', 'none']).optional(),
    domain: domainSchema.optional(),
    phone: phoneSchema.optional(),
    address: nullableTextSchema(200).optional(),
    signatureName: nullableTextSchema(120).optional(),
    signatureTitle: nullableTextSchema(120).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.warmupProfile !== undefined ||
      body.domain !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined,
    { message: 'At least one field must be provided' },
  )

const deleteSchema = z.object({
  confirmName: z.string().min(1),
})

export async function PATCH(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = patchSchema.parse(await request.json())
    let updated = client

    if (body.name !== undefined) {
      updated = await updateClientName(admin, clientId, body.name)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.renamed',
          payload: { from: client.name, to: updated.name },
        })
      } catch {
        // Audit logging is best-effort — the rename already succeeded.
      }
    }

    if (body.warmupProfile !== undefined) {
      updated = await updateClientWarmupProfile(admin, clientId, body.warmupProfile)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.warmup_profile_changed',
          payload: { from: client.warmup_profile, to: body.warmupProfile },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }

    if (body.domain !== undefined) {
      updated = await updateClientDomain(admin, clientId, body.domain)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.domain_changed',
          payload: { from: client.domain, to: body.domain },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }

    if (
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined
    ) {
      updated = await updateClientSignature(admin, clientId, {
        phone: body.phone !== undefined ? body.phone : client.phone,
        address: body.address !== undefined ? body.address : client.address,
        signatureName: body.signatureName !== undefined ? body.signatureName : client.signature_name,
        signatureTitle: body.signatureTitle !== undefined ? body.signatureTitle : client.signature_title,
      })
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.signature_changed',
          payload: {
            phone: updated.phone,
            address: updated.address,
            signatureName: updated.signature_name,
            signatureTitle: updated.signature_title,
          },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }

    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}

// Fetches the client and its own linked users first, then deletes the row
// (cascading to every campaign/case/lead/email/sequence/mailbox/suppression/
// event/app_users row for it), then deletes the now-orphaned Supabase Auth
// users — auth.users has no FK to clients, so this last step is the only
// thing that actually removes those logins. This is irreversible.
export async function DELETE(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = deleteSchema.parse(await request.json())
    if (body.confirmName !== client.name) {
      return NextResponse.json({ error: 'name_mismatch' }, { status: 400 })
    }

    const appUsers = await listClientRoleAppUsers(admin)
    const userIds = appUsers.filter((row) => row.client_id === clientId).map((row) => row.id)

    await deleteClientCascade(admin, clientId)
    await deleteAuthUsers(admin, userIds)

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.deleted',
        payload: { name: client.name, deletedUserCount: userIds.length },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded, and
      // clientId no longer references a real row, but events.client_id has
      // no FK (see events table definition), so this insert is still valid.
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
