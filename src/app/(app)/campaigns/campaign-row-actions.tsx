'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pause, Play } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { Database } from '@/types/database'
import { DeleteCampaignDialog } from './delete-campaign-dialog'

type CampaignStatus = Database['public']['Enums']['campaign_status']

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

async function postAction(
  campaignId: string,
  action: 'stop' | 'resume',
  t: ReturnType<typeof useTranslations<'campaigns'>>,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/campaigns/${campaignId}/${action}`, { method: 'POST' })
  if (res.ok) return { ok: true }
  const json: unknown = await res.json().catch(() => ({}))
  const message =
    typeof json === 'object' && json !== null && 'error' in json
      ? String((json as { error: unknown }).error)
      : t('rowActions.requestFailed')
  return { ok: false, message }
}

interface StopCampaignDialogProps {
  campaignId: string
  campaignName: string
  onDone: () => void
}

// Two-step by design, same as ClientLifecycleActions' pause/archive dialog:
// stopping changes externally-visible behaviour (discovery/research/writing/
// follow-ups halt), so it never fires on a single click. Resume, below, only
// ever restores a safer prior state, so it stays a single click.
function StopCampaignDialog({ campaignId, campaignName, onDone }: StopCampaignDialogProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onConfirm(): Promise<void> {
    setState({ status: 'submitting' })
    const result = await postAction(campaignId, 'stop', t)
    if (!result.ok) {
      const message = result.message ?? t('rowActions.requestFailed')
      setState({ status: 'error', message })
      toast.error(t('rowActions.stopFailedToast'), { description: message })
      return
    }
    setState({ status: 'idle' })
    setOpen(false)
    toast.success(t('rowActions.stoppedToast', { campaignName }))
    onDone()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setState({ status: 'idle' })
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Pause size={13} weight="light" />
          {t('rowActions.stopTrigger')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('rowActions.stopTitle', { campaignName })}</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">{t('rowActions.stopDescription')}</p>
        {state.status === 'error' ? (
          <p role="alert" className="text-destructive text-xs">
            {state.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" size="sm" disabled={state.status === 'submitting'} onClick={onConfirm}>
            {state.status === 'submitting' ? t('rowActions.stopping') : t('rowActions.stopConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CampaignRowActionsProps {
  campaignId: string
  campaignName: string
  status: CampaignStatus
}

// Archived campaigns show only Delete: there is no per-campaign archive
// action in this product yet (only the client-level archive path exists),
// so an already-archived campaign is already considered halted — a
// redundant Stop button there would be confusing.
export function CampaignRowActions({ campaignId, campaignName, status }: CampaignRowActionsProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [resumeState, setResumeState] = useState<SubmitState>({ status: 'idle' })

  async function runResume(): Promise<void> {
    setResumeState({ status: 'submitting' })
    const result = await postAction(campaignId, 'resume', t)
    if (!result.ok) {
      toast.error(t('rowActions.resumeFailedToast'), { description: result.message })
      setResumeState({ status: 'idle' })
      return
    }
    toast.success(t('rowActions.resumedToast', { campaignName }))
    setResumeState({ status: 'idle' })
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'active' ? (
        <StopCampaignDialog campaignId={campaignId} campaignName={campaignName} onDone={() => router.refresh()} />
      ) : null}

      {status === 'paused' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resumeState.status === 'submitting'}
          onClick={() => void runResume()}
        >
          <Play size={13} weight="light" />
          {resumeState.status === 'submitting' ? t('rowActions.resuming') : t('rowActions.resumeTrigger')}
        </Button>
      ) : null}

      <DeleteCampaignDialog campaignId={campaignId} campaignName={campaignName} />
    </div>
  )
}
