import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { ingestKnowledgeFile } from '@/lib/knowledge/ingest-file'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'
const ACTOR = 'knowledge_file_upload'

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  const { clientId } = await context.params
  // Clients may curate their own knowledge; operators may curate anyone's. This
  // route uses the admin client, so RLS is not the boundary — this check is.
  if (!canManageClient(appUser, clientId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'validation_error', issues: 'file is required' }, { status: 400 })
    }

    const source = await ingestKnowledgeFile(admin, {
      clientId, createdBy: appUser.id, file, actor: ACTOR,
    })

    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.file_uploaded',
      payload: {
        sourceId: source.id, title: file.name, charCount: source.char_count, mimeType: file.type,
      },
    })

    return NextResponse.json({ ok: true, source })
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    // Only the non-validation branch is logged — a rejected file is the
    // uploader's problem to fix, not a fault worth surfacing in the Logs tab.
    await logError({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'knowledge.file_route_failed',
      source: 'app',
      error,
    })
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
