'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { motion, useReducedMotion } from 'motion/react'
import { CheckCircle, PaperPlaneTilt, Question } from '@phosphor-icons/react'
import { answerKnowledgeRequest } from './actions'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'

interface KnowledgeRequestRowProps {
  knowledgeRequestId: string
  caseId: string
  question: string
  companyName: string
  /** Preformatted on the server so no clock runs during hydration. */
  age: string
}

export function KnowledgeRequestRow({
  knowledgeRequestId,
  caseId,
  question,
  companyName,
  age,
}: KnowledgeRequestRowProps): React.ReactElement {
  const [isPending, startTransition] = useTransition()
  const [isAnswered, setIsAnswered] = useState(false)
  const [answer, setAnswer] = useState('')
  const reduceMotion = useReducedMotion()

  const isEmpty = answer.trim().length === 0

  const onSubmit = (formData: FormData): void => {
    startTransition(async () => {
      try {
        await answerKnowledgeRequest(formData)
        setIsAnswered(true)
        toast.success('Answer sent', { description: `The agent replied to ${companyName}.` })
      } catch (error) {
        toast.error('Could not send the answer', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
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
          Answered <span className="text-muted-foreground">for {companyName}.</span>
        </p>
      </motion.article>
    )
  }

  return (
    <form
      action={onSubmit}
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
          <p className="text-faint truncate text-[11px]">Agent is blocked · {age}</p>
        </div>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="max-w-[75ch] text-sm leading-relaxed">{question}</p>

        <input type="hidden" name="knowledgeRequestId" value={knowledgeRequestId} />

        <div className="flex flex-col gap-2">
          <Label htmlFor={`answer-${knowledgeRequestId}`} className="text-xs">
            Your answer
          </Label>
          <Textarea
            id={`answer-${knowledgeRequestId}`}
            name="answer"
            required
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="State the fact plainly. The agent rewrites it in its own voice before replying."
            className="max-w-[75ch] resize-y"
          />
          <p className="text-faint text-[11px]">
            Saved as case knowledge, so the agent can reuse it on this company later.
          </p>
        </div>
      </div>

      <footer className="border-hairline border-t px-4 py-3">
        <Button type="submit" size="sm" disabled={isPending || isEmpty}>
          <PaperPlaneTilt size={14} weight="fill" />
          {isPending ? 'Sending…' : 'Answer and send'}
        </Button>
      </footer>
    </form>
  )
}
