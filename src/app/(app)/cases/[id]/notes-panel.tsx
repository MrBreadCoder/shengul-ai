'use client'

import { useState, useTransition } from 'react'
import { NotePencil, Trash, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { formatAbsolute, formatRelative } from '@/lib/format'
import { MAX_NOTE_CHARS } from '@/lib/validation/note-limits'
import { createNote, editNote, removeNote } from './note-actions'

export interface NoteContact {
  id: string
  fullName: string
}

export interface NotePanelItem {
  id: string
  body: string
  /** Null = the note is about the company. */
  leadId: string | null
  authorLabel: string
  /** Whether the viewing user may edit or delete this note. */
  canManage: boolean
  createdAt: string
}

interface NotesPanelProps {
  caseId: string
  contacts: readonly NoteContact[]
  notes: readonly NotePanelItem[]
  /** Preselects the About field when a contact card asked for a note. */
  initialLeadId?: string | null
}

const COMPANY_VALUE = 'company'

export function NotesPanel({
  caseId,
  contacts,
  notes,
  initialLeadId = null,
}: NotesPanelProps): React.ReactElement {
  const t = useTranslations('cases')
  const tCommon = useTranslations('common')
  const [target, setTarget] = useState<string>(initialLeadId ?? COMPANY_VALUE)
  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const nameByLeadId = new Map(contacts.map((contact) => [contact.id, contact.fullName]))
  const now = new Date()

  function submitNew(): void {
    setError(null)
    const data = new FormData()
    data.set('caseId', caseId)
    data.set('leadId', target === COMPANY_VALUE ? '' : target)
    data.set('body', body)
    startTransition(async () => {
      try {
        await createNote(data)
        setBody('')
      } catch {
        setError(t('notesPanel.createFailed'))
      }
    })
  }

  function submitEdit(noteId: string): void {
    setError(null)
    const data = new FormData()
    data.set('noteId', noteId)
    data.set('caseId', caseId)
    data.set('body', editingBody)
    startTransition(async () => {
      try {
        await editNote(data)
        setEditingId(null)
      } catch {
        setError(t('notesPanel.editFailed'))
      }
    })
  }

  function submitRemove(noteId: string): void {
    setError(null)
    const data = new FormData()
    data.set('noteId', noteId)
    data.set('caseId', caseId)
    startTransition(async () => {
      try {
        await removeNote(data)
      } catch {
        setError(t('notesPanel.removeFailed'))
      }
    })
  }

  return (
    <section
      id="notes"
      aria-label={t('notesPanel.title')}
      className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">
          {t('notesPanel.title')} <span className="text-faint tnum font-normal">{notes.length}</span>
        </h2>
        <p className="text-faint ml-auto text-[11px]">{t('notesPanel.privacyHint')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder={t('notesPanel.newNotePlaceholder')}
          rows={3}
          maxLength={MAX_NOTE_CHARS}
          aria-label={t('notesPanel.newNoteLabel')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-56" aria-label={t('notesPanel.aboutLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={COMPANY_VALUE}>{t('notesPanel.aboutCompany')}</SelectItem>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  {t('notesPanel.aboutContact', { fullName: contact.fullName })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={submitNew}
            disabled={isPending || body.trim().length === 0}
            className="ml-auto"
          >
            {isPending ? t('notesPanel.saving') : t('notesPanel.addNote')}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}

      {notes.length === 0 ? (
        <p className="border-hairline text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-sm">
          {t('notesPanel.empty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id} className="border-hairline bg-surface-sunken rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {note.leadId ? (
                  <span className="bg-accent text-muted-foreground rounded-full px-2 py-0.5 text-[11px]">
                    {nameByLeadId.get(note.leadId) ?? t('notesPanel.contactFallback')}
                  </span>
                ) : (
                  <span className="text-faint text-[11px]">{t('notesPanel.company')}</span>
                )}
                <span className="text-faint text-[11px]">{note.authorLabel}</span>
                <time
                  dateTime={note.createdAt}
                  title={formatAbsolute(note.createdAt)}
                  className="text-faint ml-auto text-[11px]"
                >
                  {formatRelative(note.createdAt, now)}
                </time>
                {note.canManage && editingId !== note.id ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('notesPanel.editNote')}
                      disabled={isPending}
                      onClick={() => {
                        setEditingId(note.id)
                        setEditingBody(note.body)
                      }}
                    >
                      <NotePencil size={13} weight="light" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t('notesPanel.deleteNote')}
                      disabled={isPending}
                      onClick={() => submitRemove(note.id)}
                    >
                      <Trash size={13} weight="light" />
                    </Button>
                  </>
                ) : null}
                {editingId === note.id ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={t('notesPanel.cancelEditing')}
                    onClick={() => setEditingId(null)}
                  >
                    <X size={13} weight="light" />
                  </Button>
                ) : null}
              </div>

              {editingId === note.id ? (
                <div className="mt-2 flex flex-col gap-2">
                  <Textarea
                    value={editingBody}
                    onChange={(event) => setEditingBody(event.target.value)}
                    rows={3}
                    maxLength={MAX_NOTE_CHARS}
                    aria-label={t('notesPanel.editNote')}
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="w-fit"
                    disabled={isPending || editingBody.trim().length === 0}
                    onClick={() => submitEdit(note.id)}
                  >
                    {isPending ? t('notesPanel.saving') : tCommon('save')}
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
