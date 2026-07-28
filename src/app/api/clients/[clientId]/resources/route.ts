import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { uploadClientResource, deleteClientResourceObject } from '@/lib/storage/client-resources'
import { insertClientResource } from '@/lib/db/client-resources'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  // Required: an undescribed resource never reaches the AI's menu, so an empty
  // description makes the upload pointless.
  description: z.string().trim().min(1).max(500),
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
