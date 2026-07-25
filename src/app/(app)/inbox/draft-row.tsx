'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CheckCircle, PaperPlaneTilt } from '@phosphor-icons/react'
import { approveDraft } from './actions'
import { Button } from '@/components/ui/button'
import { CompanyMark } from '@/components/company-mark'

interface DraftRowProps {
  emailId: string
  caseId: string | null
  subject: string
  body: string
  companyName: string
  /** Preformatted on the server so no clock runs during hydration. */
  age: string
}

export function DraftRow({
  emailId,
  caseId,
  subject,
  body,
  companyName,
  age,
}: DraftRowProps): React.ReactElement {
  const [isPending, startTransition] = useTransition()
  const [isSent, setIsSent] = useState(false)
  const reduceMotion = useReducedMotion()

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
