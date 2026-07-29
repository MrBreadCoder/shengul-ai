'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getCaseById } from '@/lib/db/cases'
import { getLeadById } from '@/lib/db/leads'
import { insertNote, getNoteById, updateNote, deleteNote } from '@/lib/db/notes'
import { canManageClient, canManageOwnRow } from '@/lib/auth/can-manage-client'
import { AppError } from '@/lib/errors/app-error'
import { MAX_NOTE_CHARS } from '@/lib/validation/note-limits'

// A <select> always submits a string; the Company option submits ''.
const optionalLeadId = z
  .union([z.string().uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))

const createSchema = z.object({
  caseId: z.string().uuid(),
  leadId: optionalLeadId,
  body: z.string().trim().min(1).max(MAX_NOTE_CHARS),
})

const editSchema = z.object({
  noteId: z.string().uuid(),
  caseId: z.string().uuid(),
  body: z.string().trim().min(1).max(MAX_NOTE_CHARS),
})

const removeSchema = z.object({
  noteId: z.string().uuid(),
  caseId: z.string().uuid(),
})

/**
 * Notes are written through the session-scoped client, so the RLS policies in
 * 0020 are the wall. The checks here exist to turn a silent policy refusal into
 * a precise error the UI can show, not to replace the policy.
 */
export async function createNote(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { caseId, leadId, body } = createSchema.parse({
    caseId: formData.get('caseId'),
    leadId: formData.get('leadId'),
    body: formData.get('body'),
  })

  const supabase = await createServerClient()
  const kase = await getCaseById(supabase, caseId)
  // RLS makes an out-of-scope case indistinguishable from a missing one, which
  // is what we want: no existence leak across clients.
  if (!kase) throw new AppError('NOT_FOUND', 'Case not found', { caseId })
  if (!canManageClient(appUser, kase.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Case belongs to another client', { caseId, userId: appUser.id })
  }

  // A note pinned to a person must be pinned to a person on this case —
  // otherwise the note renders on a page its subject never appears on.
  if (leadId !== null) {
    const lead = await getLeadById(supabase, leadId)
    if (!lead || lead.case_id !== caseId) {
      throw new AppError('VALIDATION_ERROR', 'Contact does not belong to this case', { caseId, leadId })
    }
  }

  await insertNote(supabase, {
    clientId: kase.client_id,
    caseId,
    leadId,
    body,
    createdBy: appUser.id,
  })

  revalidatePath(`/cases/${caseId}`)
}

export async function editNote(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { noteId, caseId, body } = editSchema.parse({
    noteId: formData.get('noteId'),
    caseId: formData.get('caseId'),
    body: formData.get('body'),
  })

  const supabase = await createServerClient()
  const note = await getNoteById(supabase, noteId)
  if (!note) throw new AppError('NOT_FOUND', 'Note not found', { noteId })
  // Guards against a stale tab or tampered hidden field submitting a caseId
  // that doesn't match the note's real case — without this, the edit would
  // still succeed (authorization is scoped to note ownership, not caseId) but
  // revalidatePath below would refresh the wrong case page.
  if (note.case_id !== caseId) {
    throw new AppError('VALIDATION_ERROR', 'Note does not belong to this case', { noteId, caseId })
  }
  if (!canManageOwnRow(appUser, note)) {
    throw new AppError('FORBIDDEN', 'You can only edit your own notes', { noteId, userId: appUser.id })
  }

  const updated = await updateNote(supabase, noteId, body)
  // The read succeeded and authorization passed, so an empty update means the
  // row was deleted in between. Reporting it beats a silent no-op.
  if (!updated) throw new AppError('NOT_FOUND', 'Note no longer exists', { noteId })

  revalidatePath(`/cases/${caseId}`)
}

export async function removeNote(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { noteId, caseId } = removeSchema.parse({
    noteId: formData.get('noteId'),
    caseId: formData.get('caseId'),
  })

  const supabase = await createServerClient()
  const note = await getNoteById(supabase, noteId)
  // Already gone (or never visible): deleting is idempotent, so this is a
  // success, not an error to show the user.
  if (!note) {
    revalidatePath(`/cases/${caseId}`)
    return
  }
  // Same cross-check as editNote: a note that exists but belongs to a
  // different case must not be deleted (or its wrong case revalidated) just
  // because a stale/tampered caseId was submitted alongside a valid noteId.
  if (note.case_id !== caseId) {
    throw new AppError('VALIDATION_ERROR', 'Note does not belong to this case', { noteId, caseId })
  }
  if (!canManageOwnRow(appUser, note)) {
    throw new AppError('FORBIDDEN', 'You can only delete your own notes', { noteId, userId: appUser.id })
  }

  await deleteNote(supabase, noteId)
  revalidatePath(`/cases/${caseId}`)
}
