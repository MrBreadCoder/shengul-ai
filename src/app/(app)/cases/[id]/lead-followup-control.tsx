'use client'

import { useState, useTransition } from 'react'
import { PencilSimple } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { FollowupDelaysEditor } from '@/components/followup-delays-editor'
import { Button } from '@/components/ui/button'
import { formatFollowupStatus } from '@/lib/format'
import { updateLeadFollowupDelays } from './actions'

interface LeadFollowupControlProps {
  leadId: string
  caseId: string
  delaysDays: readonly number[]
  currentStep: number
  /** Preformatted on the server so no clock runs during hydration (see formatFollowupCountdown). */
  countdownLabel: string | null
}

export function LeadFollowupControl({
  leadId,
  caseId,
  delaysDays,
  currentStep,
  countdownLabel,
}: LeadFollowupControlProps): React.ReactElement {
  const t = useTranslations('cases')
  const tCommon = useTranslations('common')
  const [isEditing, setIsEditing] = useState(false)
  const [draftDelays, setDraftDelays] = useState<number[]>([...delaysDays])
  const [isSaving, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onOpen(): void {
    setDraftDelays([...delaysDays])
    setError(null)
    setIsEditing(true)
  }

  function onSave(): void {
    const formData = new FormData()
    formData.set('leadId', leadId)
    formData.set('caseId', caseId)
    for (const day of draftDelays) formData.append('delaysDays', String(day))
    startTransition(async () => {
      try {
        await updateLeadFollowupDelays(formData)
        setIsEditing(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('leadFollowupControl.saveFailed'))
      }
    })
  }

  if (!isEditing) {
    return (
      <div className="mt-2 flex items-center gap-1.5">
        <p className="text-faint text-[11px]">{formatFollowupStatus(currentStep, delaysDays.length, countdownLabel)}</p>
        <button
          type="button"
          onClick={onOpen}
          aria-label={t('leadFollowupControl.editLabel')}
          className="text-faint hover:text-foreground transition-colors duration-200"
        >
          <PencilSimple size={12} weight="light" />
        </button>
      </div>
    )
  }

  return (
    <div className="border-hairline mt-2 flex flex-col gap-2 rounded-md border border-dashed p-2">
      <FollowupDelaysEditor
        idPrefix={`lead-${leadId}`}
        delaysDays={draftDelays}
        onChange={setDraftDelays}
        disabled={isSaving}
      />
      {error ? (
        <p role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={isSaving} onClick={onSave}>
          {isSaving ? tCommon('saving') : tCommon('save')}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={() => setIsEditing(false)}>
          {tCommon('cancel')}
        </Button>
      </div>
    </div>
  )
}
