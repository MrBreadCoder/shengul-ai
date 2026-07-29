'use client'

import { useState } from 'react'
import { EnvelopeSimple, GoogleLogo, MicrosoftOutlookLogo, PaperPlaneTilt } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/status-dot'
import { MAILBOX_HEALTH } from '@/lib/ui/status'
import { effectiveDailyCap, type WarmupProfile } from '@/lib/mailbox/warmup'
import { mailreachElapsedDays, MAILREACH_CAMPAIGN_GATE_DAYS } from '@/lib/mailbox/mailreach-gate'
import type { Database } from '@/types/database'
import { MailboxControls } from './mailbox-controls'
import { MailreachControls } from './mailreach-controls'

type UserRole = Database['public']['Enums']['user_role']
type MailreachStatus = Database['public']['Enums']['mailreach_status']

interface MailboxRowProps {
  id: string
  provider: 'gmail' | 'outlook' | 'smtp'
  emailAddress: string
  displayName: string | null
  health: 'ok' | 'warning' | 'blocked'
  healthReason: string | null
  warmupProfile: WarmupProfile
  warmupStartedAt: string | null
  dailyCap: number
  sentToday: number
  viewerRole: UserRole
  mailreachEnabled: boolean
  mailreachStartedAt: string | null
  mailreachStatus: MailreachStatus
  mailreachReputationScore: number | null
}

function mailreachStatusText(props: {
  enabled: boolean
  startedAt: string | null
  status: MailreachStatus
  reputationScore: number | null
}): string | null {
  if (!props.enabled || props.startedAt === null) return null
  if (props.status !== 'connected') return 'Mailreach: needs reconnect'
  const elapsed = mailreachElapsedDays(props.startedAt, new Date())
  if (elapsed < MAILREACH_CAMPAIGN_GATE_DAYS) {
    return `Mailreach: day ${elapsed}/${MAILREACH_CAMPAIGN_GATE_DAYS} · warming`
  }
  return props.reputationScore !== null ? `Mailreach: warm · reputation ${props.reputationScore}` : 'Mailreach: warm'
}

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; providerMessageId: string }
  | { status: 'error'; message: string }

const PROVIDER_ICON = {
  gmail: GoogleLogo,
  outlook: MicrosoftOutlookLogo,
  smtp: EnvelopeSimple,
} as const

export function MailboxRow(props: MailboxRowProps): React.ReactElement {
  const [state, setState] = useState<SendState>({ status: 'idle' })
  const Icon = PROVIDER_ICON[props.provider]
  const capToday = effectiveDailyCap({
    profile: props.warmupProfile,
    warmupStartedAt: props.warmupStartedAt,
    dailyCap: props.dailyCap,
    now: new Date(),
  })
  const isRamping = capToday < props.dailyCap
  const mailreachText = mailreachStatusText({
    enabled: props.mailreachEnabled,
    startedAt: props.mailreachStartedAt,
    status: props.mailreachStatus,
    reputationScore: props.mailreachReputationScore,
  })

  async function sendTest(): Promise<void> {
    setState({ status: 'sending' })
    try {
      const res = await fetch(`/api/mailboxes/${props.id}/test-email`, { method: 'POST' })
      const json: unknown = await res.json()
      if (!res.ok) {
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'failed'
        setState({ status: 'error', message })
        return
      }
      const providerMessageId =
        typeof json === 'object' && json !== null && 'providerMessageId' in json
          ? String((json as { providerMessageId: unknown }).providerMessageId)
          : ''
      setState({ status: 'sent', providerMessageId })
    } catch {
      setState({ status: 'error', message: 'network' })
    }
  }

  return (
    <div className="border-hairline bg-surface flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border p-4">
      <span className="bg-accent text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
        <Icon size={18} weight="light" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{props.emailAddress}</p>
        <p className="text-faint truncate text-[11px]">
          {props.displayName ?? 'No display name'} · {props.provider} ·{' '}
          <span className="tnum">
            {props.sentToday}/{capToday} today
          </span>
          {isRamping ? ` · warming up (cap ${props.dailyCap})` : null}
          {props.healthReason ? ` · ${props.healthReason.replaceAll('_', ' ')}` : null}
          {mailreachText ? ` · ${mailreachText}` : null}
        </p>
      </div>

      <StatusPill meta={MAILBOX_HEALTH[props.health]} />

      {props.viewerRole === 'operator' ? (
        <>
          <MailboxControls id={props.id} isBlocked={props.health === 'blocked'} warmupProfile={props.warmupProfile} />
          <MailreachControls id={props.id} provider={props.provider} enabled={props.mailreachEnabled} />
        </>
      ) : null}

      <div className="flex items-center gap-2.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={sendTest}
          disabled={state.status === 'sending'}
        >
          <PaperPlaneTilt size={13} weight="light" />
          {state.status === 'sending' ? 'Sending…' : 'Send test'}
        </Button>
        {state.status === 'sent' ? (
          <span role="status" className="text-[11px] font-medium" style={{ color: 'var(--status-won)' }}>
            Test delivered
          </span>
        ) : null}
        {state.status === 'error' ? (
          <span role="alert" className="text-destructive text-[11px] font-medium">
            Failed: {state.message}
          </span>
        ) : null}
      </div>
    </div>
  )
}
