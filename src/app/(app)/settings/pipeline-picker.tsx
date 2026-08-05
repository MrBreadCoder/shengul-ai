'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { CrmPipeline } from '@/lib/crm/provider'
import { selectCrmPipeline } from './crm-actions'

interface PipelinePickerProps {
  pipelines: readonly CrmPipeline[]
}

export function PipelinePicker({ pipelines }: PipelinePickerProps): React.ReactElement {
  const t = useTranslations('settings')
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '')
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const selected = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null
  const stages = selected?.stages ?? []

  if (pipelines.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        {t('pipelinePicker.noPipelines')}
      </p>
    )
  }

  function onSubmit(formData: FormData): void {
    setError(null)
    startTransition(async () => {
      try {
        await selectCrmPipeline(formData)
      } catch {
        setError(t('pipelinePicker.saveFailed'))
      }
    })
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="pipelineLabel" value={selected?.label ?? ''} />
      <input
        type="hidden"
        name="wonStageId"
        value={stages.find((stage) => stage.closedOutcome === 'won')?.id ?? ''}
      />
      <input
        type="hidden"
        name="lostStageId"
        value={stages.find((stage) => stage.closedOutcome === 'lost')?.id ?? ''}
      />

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{t('pipelinePicker.pipelineLabel')}</span>
        <select
          name="pipelineId"
          value={pipelineId}
          onChange={(event) => setPipelineId(event.target.value)}
          className="border-hairline bg-surface rounded-md border px-3 py-2 text-[13px]"
        >
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>{pipeline.label}</option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">{t('pipelinePicker.initialStageLabel')}</span>
        <select
          name="initialStageId"
          defaultValue={stages[0]?.id ?? ''}
          key={pipelineId}
          className="border-hairline bg-surface rounded-md border px-3 py-2 text-[13px]"
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>{stage.label}</option>
          ))}
        </select>
      </label>

      {error ? <p className="text-[12px] text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={isPending || stages.length === 0}
        className="border-hairline bg-surface hover:border-hairline-strong self-start rounded-md border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
      >
        {isPending ? t('pipelinePicker.saving') : t('pipelinePicker.saveAndSync')}
      </button>
    </form>
  )
}
