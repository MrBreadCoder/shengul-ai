import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { uploadClientResource, deleteClientResourceObject } from '@/lib/storage/client-resources'
import { insertClientResource } from '@/lib/db/client-resources'
import { publishJson } from '@/lib/qstash/client'
import { markResourceContentFailed } from '@/lib/db/resource-content'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  // Optional since 0019: the agent reads the file itself, so this is a steering
  // hint about when to send rather than a description of the contents. A blank
  // field and an absent field mean the same thing and are both stored as null.
  description: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((value) => (value && value.length > 0 ? value : null)),
})

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  const { clientId } = await context.params
  // This route writes with the service-role client, which bypasses RLS — this
  // check is the authorization boundary, not the policy.
  if (!canManageClient(appUser, clientId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  let storagePath: string | null = null
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'validation_error', issues: 'file is required' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse({
      title: formData.get('title'),
      description: formData.get('description'),
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', issues: parsed.error.issues[0]?.message ?? 'invalid input' },
        { status: 400 },
      )
    }

    const uploaded = await uploadClientResource(admin, clientId, file)
    storagePath = uploaded.storagePath

    const resource = await insertClientResource(admin, {
      clientId,
      createdBy: appUser.id,
      title: parsed.data.title,
      description: parsed.data.description,
      fileName: uploaded.fileName,
      mimeType: file.type,
      byteSize: file.size,
      storagePath: uploaded.storagePath,
    })

    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'resource.uploaded',
      payload: { resourceId: resource.id, title: resource.title, byteSize: resource.byte_size },
    })

    // Reading the file needs Gemini, so it is deferred rather than made part of
    // the upload request. A publish failure is not an upload failure: the file
    // is stored and already sendable, so the row is marked failed and the UI
    // offers a re-read instead of spinning on 'pending' forever.
    try {
      await publishJson('/api/pipeline/resource-read', { resourceId: resource.id })
    } catch (publishError) {
      await markResourceContentFailed(admin, resource.id, 'Could not start reading this file')
      await logError({
        clientId, actor: `human:${appUser.id}`, type: 'resource.read_enqueue_failed',
        source: 'qstash', error: publishError, payload: { resourceId: resource.id },
      })
    }

    return NextResponse.json({ ok: true, resource })
  } catch (error) {
    // The object is already in the bucket but has no row pointing at it, so
    // nothing will ever reference or clean it up. Remove it best-effort.
    if (storagePath) await deleteClientResourceObject(admin, storagePath)

    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    // Only the non-validation branch is logged — a rejected file is the
    // uploader's problem to fix, not a fault worth surfacing in the Logs tab.
    await logError({
      clientId, actor: `human:${appUser.id}`, type: 'resource.upload_route_failed',
      source: 'app', error,
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
