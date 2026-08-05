'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'motion/react'
import { CheckCircle, PaperPlaneTilt, Question } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { answerKnowledgeRequest } from './actions'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { ResourcePicker } from '@/components/resource-picker'
import type { ResourceSummary } from '@/components/resource-list'

interface KnowledgeRequestRowProps {
  knowledgeRequestId: string
  caseId: string
  /** Needed to address the knowledge-file upload route. */
  clientId: string
  question: string
  companyName: string
  /** Preformatted on the server so no clock runs during hydration. */
  age: string
  /** This client's sendable library; empty renders no picker at all. */
  resources: readonly ResourceSummary[]
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  const json: unknown = await res.json().catch(() => ({}))
  if (typeof json === 'object' && json !== null && 'issues' in json) {
    const issues = (json as { issues: unknown }).issues
    if (typeof issues === 'string') return issues
  }
  return fallback
}

export function KnowledgeRequestRow({
  knowledgeRequestId,
  caseId,
  clientId,
  question,
  companyName,
  age,
  resources,
}: KnowledgeRequestRowProps): React.ReactElement {
  const t = useTranslations('inbox')
  const [isPending, startTransition] = useTransition()
  const [isAnswered, setIsAnswered] = useState(false)
  const [answer, setAnswer] = useState('')
  const reduceMotion = useReducedMotion()

  const isEmpty = answer.trim().length === 0

  /**
   * The knowledge file goes to the upload Route Handler, never through the
   * Server Action below: Server Actions cap request bodies at 1MB by default,
   * which almost every real PDF exceeds, and a file too large would otherwise
   * take the whole answer down with it.
   *
   * Best-effort by design — a failed ingest must not block the reply the
   * prospect is waiting on, because the operator's typed answer already carries
   * the fact. So this warns and returns rather than throwing.
   */
  async function uploadKnowledgeFile(file: File): Promise<void> {
    try {
      const body = new FormData()
      body.set('file', file)
      const res = await fetch(`/api/clients/${clientId}/knowledge/file`, { method: 'POST', body })
      if (!res.ok) {
        toast.warning(t('knowledgeRequestRow.toastFileWarningTitle'), {
          description: await extractErrorMessage(res, t('knowledgeRequestRow.toastFileReadError')),
        })
      }
    } catch {
      toast.warning(t('knowledgeRequestRow.toastFileWarningTitle'), {
        description: t('knowledgeRequestRow.toastFileNetworkError'),
      })
    }
  }

  const onSubmit = (formData: FormData): void => {
    const knowledgeFile = formData.get('knowledgeFile')
    // Always removed, empty or not: a File in the payload is exactly what the
    // Server Action body limit rejects.
    formData.delete('knowledgeFile')

    startTransition(async () => {
      try {
        await answerKnowledgeRequest(formData)
        setIsAnswered(true)
        toast.success(t('knowledgeRequestRow.toastAnswerSent'), {
          description: t('knowledgeRequestRow.toastAnswerSentDescription', { companyName }),
        })
      } catch (error) {
        toast.error(t('knowledgeRequestRow.toastAnswerFailed'), {
          description: error instanceof Error ? error.message : t('knowledgeRequestRow.toastPleaseRetry'),
        })
        return
      }
      // After the answer, so a slow upload never delays the reply and a rejected
      // file never prevents it.
      if (knowledgeFile instanceof File && knowledgeFile.size > 0) {
        await uploadKnowledgeFile(knowledgeFile)
      }
    })
  }

  if (isAnswered) {
    return (
      <motion.article
        className="border-hairline bg-surface flex items-center gap-2.5 rounded-lg border px-4 py-4"
        initial={reduceMotion ? false : { opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      >
        <CheckCircle size={16} weight="fill" className="shrink-0" style={{ color: 'var(--status-won)' }} />
        <p className="text-sm">
          {t('knowledgeRequestRow.answeredPrefix')}{' '}
          <span className="text-muted-foreground">{t('knowledgeRequestRow.answeredSuffix', { companyName })}</span>
        </p>
      </motion.article>
    )
  }

  return (
    <form
      action={onSubmit}
      // Declarative WebMCP: an agent may draft the answer, but the operator
      // presses the button — submitting this sends mail to the prospect. No
      // `toolautosubmit` — see `@/types/webmcp`.
      toolname="answerKnowledgeRequest"
      tooldescription={t('knowledgeRequestRow.toolDescription')}
      className="bg-surface rounded-lg border"
      // Open questions block the agent mid-conversation, so this row carries a
      // warmer edge than a draft: it is the thing to deal with first.
      style={{ borderColor: 'color-mix(in oklch, var(--status-hot-handoff) 40%, transparent)' }}
    >
      <header className="border-hairline flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <span
          aria-hidden
          className="grid size-8 shrink-0 place-items-center rounded-md"
          style={{
            color: 'var(--status-hot-handoff)',
            background: 'color-mix(in oklch, var(--status-hot-handoff) 14%, transparent)',
          }}
        >
          <Question size={15} weight="bold" />
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/cases/${caseId}`}
            className="hover:text-primary block truncate text-[13px] font-medium transition-colors duration-200"
          >
            {companyName}
          </Link>
          <p className="text-faint truncate text-[11px]">{t('knowledgeRequestRow.agentBlocked', { age })}</p>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="max-w-[75ch] text-sm leading-relaxed">{question}</p>

        <input
          type="hidden"
          name="knowledgeRequestId"
          value={knowledgeRequestId}
          toolparamdescription={t('knowledgeRequestRow.knowledgeRequestIdToolParamDescription')}
        />

        <div className="flex flex-col gap-2">
          <Label htmlFor={`answer-${knowledgeRequestId}`} className="text-xs">
            {t('knowledgeRequestRow.yourAnswerLabel')}
          </Label>
          <Textarea
            id={`answer-${knowledgeRequestId}`}
            name="answer"
            required
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={t('knowledgeRequestRow.answerPlaceholder')}
            className="max-w-[75ch] resize-y"
            toolparamdescription={t('knowledgeRequestRow.answerToolParamDescription')}
          />
          <p className="text-faint text-[11px]">
            {t('knowledgeRequestRow.answerHint')}
          </p>
        </div>

        <ResourcePicker resources={resources} name="resourceIds" />

        <div className="flex flex-col gap-2">
          <Label htmlFor={`knowledge-file-${knowledgeRequestId}`} className="text-xs">
            {t('knowledgeRequestRow.addKnowledgeLabel')}
          </Label>
          <Input
            id={`knowledge-file-${knowledgeRequestId}`}
            name="knowledgeFile"
            type="file"
            accept="application/pdf,text/plain,text/markdown,.md"
            className="max-w-[45ch]"
            toolparamdescription={t('knowledgeRequestRow.knowledgeFileToolParamDescription')}
          />
          <p className="text-faint text-[11px]">
            {t('knowledgeRequestRow.knowledgeFileHint')}
          </p>
        </div>
      </div>

      <footer className="border-hairline border-t px-4 py-3">
        <Button type="submit" size="sm" disabled={isPending || isEmpty}>
          <PaperPlaneTilt size={14} weight="fill" />
          {isPending ? t('knowledgeRequestRow.sending') : t('knowledgeRequestRow.answerAndSend')}
        </Button>
      </footer>
    </form>
  )
}
