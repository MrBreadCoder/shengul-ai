import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { uploadClientKnowledgePdf } from '@/lib/storage/client-knowledge-pdfs'
import { extractPdfText } from '@/lib/knowledge/pdf-extract'
import { insertPdfSourceReady, embedAndStoreChunks } from '@/lib/db/client-knowledge'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'
const ACTOR = 'knowledge_pdf_upload'

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'validation_error', issues: 'file is required' }, { status: 400 })
    }

    // No network call — extraction, chunking, and embedding all happen inline
    // (no QStash needed, unlike a website page's Brightdata scrape).
    const storagePath = await uploadClientKnowledgePdf(admin, clientId, file)
    const buffer = await file.arrayBuffer()
    const content = await extractPdfText(buffer)

    const source = await insertPdfSourceReady(admin, {
      clientId, createdBy: appUser.id, title: file.name, storagePath, content, charCount: content.length,
    })
    await embedAndStoreChunks(admin, { clientId, sourceId: source.id, content, actor: ACTOR })

    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.pdf_uploaded',
      payload: { sourceId: source.id, title: file.name, charCount: content.length },
    })

    return NextResponse.json({ ok: true, source })
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
