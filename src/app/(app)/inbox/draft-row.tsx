'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CheckCircle, Paperclip, PaperPlaneTilt } from '@phosphor-icons/react'
import { approveDraft, updateDraftAttachments } from './actions'
import { Button } from '@/components/ui/button'
import { CompanyMark } from '@/components/company-mark'
import { ResourcePicker } from '@/components/resource-picker'
import type { ResourceSummary } from '@/components/resource-list'
import { formatBytes } from '@/lib/format/bytes'

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
  const [isPending, startTransition] = useTransition()
  const [isSent, setIsSent] = useState(false)
  const [isEditingAttachments, setIsEditingAttachments] = useState(false)
  const [isSavingAttachments, startAttachmentTransition] = useTransition()
  const reduceMotion = useReducedMotion()

  const onSaveAttachments = (formData: FormData): void => {
    startAttachmentTransition(async () => {
      try {
        await updateDraftAttachments(formData)
        setIsEditingAttachments(false)
        toast.success('Attachments updated')
      } catch (error) {
        toast.error('Could not update the attachments', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
      }
    })
  }

  const onApprove = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    startTransition(async () => {
      try {
        await approveDraft(formData)
        setIsSent(true)
        toast.success('Email sent', { description: `To ${companyName}` })
      } catch (error) {
        // The Server Action already logged the cause; the operator needs to
        // know the send did not happen and the draft is still theirs to retry.
        toast.error('Could not send', {
          description: error instanceof Error ? error.message : 'Please try again.',
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
        <p className="text-[13px] font-medium">{subject}</p>
        <p className="text-muted-foreground mt-2.5 max-w-[75ch] text-sm leading-relaxed whitespace-pre-wrap">
          {body}
        </p>

        {isSent ? null : (
          <div className="mt-4 flex flex-col gap-2">
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
              <p className="text-faint text-[11px]">No files attached.</p>
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
                      {isSavingAttachments ? 'Saving…' : 'Save attachments'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isSavingAttachments}
                      onClick={() => setIsEditingAttachments(false)}
                    >
                      Cancel
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
                  {attachments.length > 0 ? 'Edit attachments' : 'Add from library'}
                </Button>
              )
            ) : null}
          </div>
        )}
      </div>

      <footer className="border-hairline flex flex-wrap items-center gap-3 border-t px-4 py-3">
        <AnimatePresence mode="wait" initial={false}>
          {isSent ? (
            <motion.span
              key="sent"
              role="status"
              className="inline-flex items-center gap-1.5 text-xs font-medium"
              style={{ color: 'var(--status-won)' }}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <CheckCircle size={14} weight="fill" />
              Sent
            </motion.span>
          ) : (
            <motion.div
              key="actions"
              className="flex flex-wrap items-center gap-3"
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button type="button" size="sm" onClick={onApprove} disabled={isPending}>
                <PaperPlaneTilt size={14} weight="fill" />
                {isPending ? 'Sending…' : 'Approve and send'}
              </Button>
              <p className="text-faint text-[11px]">Goes out from the campaign mailbox immediately.</p>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </article>
  )
}
