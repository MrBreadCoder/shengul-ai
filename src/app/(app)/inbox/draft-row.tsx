'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CheckCircle, Clock, MagicWand, Paperclip, PaperPlaneTilt, PencilSimple, WarningCircle } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import {
  approveDraft, regenerateDraftContent, updateDraftAttachments, updateDraftContent,
  type ApproveDraftResult,
} from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { CompanyMark } from '@/components/company-mark'
import { ResourcePicker } from '@/components/resource-picker'
import type { ResourceSummary } from '@/components/resource-list'
import { formatBytes } from '@/lib/format/bytes'
import { MAX_SUBJECT_CHARS, MAX_BODY_CHARS, MAX_INSTRUCTION_CHARS } from '@/lib/validation/email-limits'

export interface DraftAttachment {
  resourceId: string
  title: string
  byteSize: number
}

interface DraftRowProps {
  emailId: string
  caseId: string | null
  subject: string
  body: string
  companyName: string
  /** Preformatted on the server so no clock runs during hydration. */
  age: string
  /** What the agent chose, as recorded in email_attachments. */
  attachments: readonly DraftAttachment[]
  /** This client's sendable library, for the "Add from library" editor. */
  resources: readonly ResourceSummary[]
}

function assertNever(x: never): never {
  throw new Error('Unhandled case: ' + String(x))
}

// What approveDraft actually resolved to, distinct from the row's original
// draft-editing state (null). Kept as a discriminated value — not a boolean
// — because a 'waiting' approval is a real, distinct outcome from 'sent':
// the content is locked in, but nothing has gone out yet, and the footer
// must say so rather than falsely claiming "Sent".
type ApproveOutcome = ApproveDraftResult['status']

function messageForRegenerateCode(
  t: ReturnType<typeof useTranslations<'inbox'>>,
  code: 'VALIDATION_ERROR' | 'EXTERNAL_ERROR' | 'EXTERNAL_TIMEOUT',
): string {
  if (code === 'VALIDATION_ERROR') return t('draftRow.regenerateValidationError')
  return t('draftRow.regenerateGenericError')
}

// Short footer-chip label per outcome — distinct from the (longer) toast
// copy in onApprove. 'waiting' must never borrow 'sent'\'s label: the
// content is locked in, but nothing has actually gone out yet.
function approveOutcomeLabel(t: ReturnType<typeof useTranslations<'inbox'>>, outcome: ApproveOutcome): string {
  switch (outcome) {
    case 'sent':
      return t('draftRow.sent')
    case 'waiting':
      return t('draftRow.waitingChip')
    case 'failed':
      return t('draftRow.toastSendFailed')
    case 'in_progress':
      return t('draftRow.inProgressChip')
    default:
      return assertNever(outcome)
  }
}

function approveOutcomeIcon(outcome: ApproveOutcome): React.ReactElement {
  switch (outcome) {
    case 'sent':
      return <CheckCircle size={14} weight="fill" />
    case 'waiting':
    case 'in_progress':
      return <Clock size={14} weight="fill" />
    case 'failed':
      return <WarningCircle size={14} weight="fill" />
    default:
      return assertNever(outcome)
  }
}

function approveOutcomeColor(outcome: ApproveOutcome): string {
  switch (outcome) {
    case 'sent':
      return 'var(--status-won)'
    case 'waiting':
      return 'var(--status-waiting)'
    case 'failed':
      return 'var(--destructive)'
    case 'in_progress':
      return 'var(--muted-foreground)'
    default:
      return assertNever(outcome)
  }
}

export function DraftRow({
  emailId,
  caseId,
  subject,
  body,
  companyName,
  age,
  attachments,
  resources,
}: DraftRowProps): React.ReactElement {
  const t = useTranslations('inbox')
  const tCommon = useTranslations('common')
  const [isPending, startTransition] = useTransition()
  // null = still an approvable draft; any other value = approveDraft
  // resolved and the row is no longer a draft.
  const [approveOutcome, setApproveOutcome] = useState<ApproveOutcome | null>(null)
  const [isEditingAttachments, setIsEditingAttachments] = useState(false)
  const [isSavingAttachments, startAttachmentTransition] = useTransition()
  const [isEditingContent, setIsEditingContent] = useState(false)
  const [draftSubject, setDraftSubject] = useState(subject)
  const [draftBody, setDraftBody] = useState(body)
  const [instruction, setInstruction] = useState('')
  const [isSavingContent, startContentTransition] = useTransition()
  const [isRedesigning, startRedesignTransition] = useTransition()
  const [redesignError, setRedesignError] = useState<string | null>(null)
  const reduceMotion = useReducedMotion()

  const onSaveAttachments = (formData: FormData): void => {
    startAttachmentTransition(async () => {
      try {
        await updateDraftAttachments(formData)
        setIsEditingAttachments(false)
        toast.success(t('draftRow.toastAttachmentsUpdated'))
      } catch (error) {
        toast.error(t('draftRow.toastAttachmentsUpdateFailed'), {
          description: error instanceof Error ? error.message : t('draftRow.toastPleaseRetry'),
        })
      }
    })
  }

  const onOpenEditor = (): void => {
    setDraftSubject(subject)
    setDraftBody(body)
    setInstruction('')
    setRedesignError(null)
    setIsEditingContent(true)
  }

  const onCancelEdit = (): void => {
    setIsEditingContent(false)
    setRedesignError(null)
  }

  const onClear = (): void => {
    setDraftSubject('')
    setDraftBody('')
  }

  const onSaveContent = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    formData.set('subject', draftSubject)
    formData.set('body', draftBody)
    startContentTransition(async () => {
      try {
        await updateDraftContent(formData)
        setIsEditingContent(false)
        toast.success(t('draftRow.toastDraftUpdated'))
      } catch (error) {
        toast.error(t('draftRow.toastSaveFailed'), {
          description: error instanceof Error ? error.message : t('draftRow.toastPleaseRetry'),
        })
      }
    })
  }

  const onRedesign = (): void => {
    setRedesignError(null)
    const formData = new FormData()
    formData.set('emailId', emailId)
    formData.set('instruction', instruction)
    startRedesignTransition(async () => {
      const result = await regenerateDraftContent(formData)
      if (!result.ok) {
        setRedesignError(messageForRegenerateCode(t, result.code))
        return
      }
      setDraftSubject(result.subject)
      setDraftBody(result.body)
    })
  }

  const onApprove = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    startTransition(async () => {
      try {
        const { status } = await approveDraft(formData)
        // Every branch here means the row is no longer an approvable draft
        // (it lost the claim to, or completed via, a concurrent approval) —
        // hide the actions either way. The footer text and toast both then
        // differ by the actual outcome — 'waiting' must never read as 'sent'.
        setApproveOutcome(status)
        switch (status) {
          case 'waiting':
            // The approval succeeded — content is locked in and will be
            // resent as-is once today's cap resets. Not an error: no retry
            // needed from the client, nothing to redo.
            toast.success(t('draftRow.toastApprovedWaiting'))
            break
          case 'sent':
            toast.success(t('draftRow.toastEmailSent'), { description: t('draftRow.toastSentToPrefix', { companyName }) })
            break
          case 'failed':
            toast.error(t('draftRow.toastSendFailed'), { description: t('draftRow.toastPleaseRetry') })
            break
          case 'in_progress':
            toast(t('draftRow.toastApprovalInProgress'))
            break
          default:
            assertNever(status)
        }
      } catch (error) {
        // The Server Action already logged the cause; the operator needs to
        // know the send did not happen and the draft is still theirs to retry.
        toast.error(t('draftRow.toastSendFailed'), {
          description: error instanceof Error ? error.message : t('draftRow.toastPleaseRetry'),
        })
      }
    })
  }

  return (
    <article className="border-hairline bg-surface rounded-lg border">
      <header className="border-hairline flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <CompanyMark name={companyName} />
        <div className="min-w-0 flex-1">
          {caseId ? (
            <Link
              href={`/cases/${caseId}`}
              className="hover:text-primary block truncate text-[13px] font-medium transition-colors duration-200"
            >
              {companyName}
            </Link>
          ) : (
            <p className="truncate text-[13px] font-medium">{companyName}</p>
          )}
          <p className="text-faint truncate text-[11px]">{age}</p>
        </div>
      </header>

      <div className="px-4 py-4">
        {isEditingContent ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`draft-subject-${emailId}`}>{t('draftRow.subjectLabel')}</Label>
              <Input
                id={`draft-subject-${emailId}`}
                value={draftSubject}
                onChange={(event) => setDraftSubject(event.target.value)}
                maxLength={MAX_SUBJECT_CHARS}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`draft-body-${emailId}`}>{t('draftRow.bodyLabel')}</Label>
              <Textarea
                id={`draft-body-${emailId}`}
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                rows={8}
                maxLength={MAX_BODY_CHARS}
              />
            </div>

            <div className="border-hairline flex flex-col gap-2 rounded-md border border-dashed p-3">
              <Label htmlFor={`draft-instruction-${emailId}`}>{t('draftRow.redesignLabel')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`draft-instruction-${emailId}`}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder={t('draftRow.redesignPlaceholder')}
                  maxLength={MAX_INSTRUCTION_CHARS}
                  className="min-w-56 flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={isRedesigning || instruction.trim().length === 0}
                  onClick={onRedesign}
                >
                  <MagicWand size={13} weight="light" />
                  {isRedesigning ? t('draftRow.redesigning') : t('draftRow.redesign')}
                </Button>
              </div>
              {redesignError ? (
                <p role="alert" className="text-destructive text-[12px]">
                  {redesignError}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={isSavingContent || draftSubject.trim().length === 0 || draftBody.trim().length === 0}
                onClick={onSaveContent}
              >
                {isSavingContent ? t('draftRow.saving') : tCommon('save')}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={isSavingContent} onClick={onClear}>
                {t('draftRow.clear')}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={isSavingContent} onClick={onCancelEdit}>
                {tCommon('cancel')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[13px] font-medium">{subject}</p>
            <p className="text-muted-foreground mt-2.5 max-w-[75ch] text-sm leading-relaxed whitespace-pre-wrap">
              {body}
            </p>
          </>
        )}

        {approveOutcome !== null ? null : (
          <div className="mt-4 flex flex-col gap-2">
            {!isEditingContent ? (
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onOpenEditor}>
                <PencilSimple size={14} weight="light" />
                {tCommon('edit')}
              </Button>
            ) : null}

            {attachments.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {attachments.map((attachment) => (
                  <li
                    key={attachment.resourceId}
                    className="border-hairline text-muted-foreground flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
                  >
                    <Paperclip size={12} weight="light" />
                    <span className="max-w-[28ch] truncate">{attachment.title}</span>
                    <span className="text-faint tnum">{formatBytes(attachment.byteSize)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-faint text-[11px]">{t('draftRow.noFilesAttached')}</p>
            )}

            {/* Its own form, so editing attachments can never submit the send.
                Offered whenever there is something to add OR something already
                attached: a draft can outlive the resource it carries, and
                hiding the editor on an empty library would leave that stale
                attachment permanently stuck to an email that cannot send. */}
            {resources.length > 0 || attachments.length > 0 ? (
              isEditingAttachments ? (
                <form action={onSaveAttachments} className="flex flex-col gap-2">
                  <input type="hidden" name="emailId" value={emailId} />
                  <ResourcePicker
                    resources={resources}
                    name="resourceIds"
                    defaultSelectedIds={attachments.map((attachment) => attachment.resourceId)}
                  />
                  <div className="flex items-center gap-2">
                    <Button type="submit" variant="secondary" size="sm" disabled={isSavingAttachments}>
                      {isSavingAttachments ? t('draftRow.saving') : t('draftRow.saveAttachments')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isSavingAttachments}
                      onClick={() => setIsEditingAttachments(false)}
                    >
                      {tCommon('cancel')}
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setIsEditingAttachments(true)}
                >
                  <Paperclip size={14} weight="light" />
                  {attachments.length > 0 ? t('draftRow.editAttachments') : t('draftRow.addFromLibrary')}
                </Button>
              )
            ) : null}
          </div>
        )}
      </div>

      <footer className="border-hairline flex flex-wrap items-center gap-3 border-t px-4 py-3">
        <AnimatePresence mode="wait" initial={false}>
          {approveOutcome !== null ? (
            <motion.span
              key={approveOutcome}
              role="status"
              className="inline-flex items-center gap-1.5 text-xs font-medium"
              style={{ color: approveOutcomeColor(approveOutcome) }}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              {approveOutcomeIcon(approveOutcome)}
              {approveOutcomeLabel(t, approveOutcome)}
            </motion.span>
          ) : (
            <motion.div
              key="actions"
              className="flex flex-wrap items-center gap-3"
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button type="button" size="sm" onClick={onApprove} disabled={isPending || isEditingContent}>
                <PaperPlaneTilt size={14} weight="fill" />
                {isPending ? t('draftRow.sending') : t('draftRow.approveAndSend')}
              </Button>
              <p className="text-faint text-[11px]">
                {isEditingContent ? t('draftRow.editHint') : t('draftRow.sendHint')}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </article>
  )
}
