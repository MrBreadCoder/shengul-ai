'use client'

import { useState } from 'react'

interface MailboxRowProps {
  id: string
  provider: 'gmail' | 'outlook'
  emailAddress: string
  displayName: string | null
  health: 'ok' | 'warning' | 'blocked'
}

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; providerMessageId: string }
  | { status: 'error'; message: string }

export function MailboxRow(props: MailboxRowProps) {
  const [state, setState] = useState<SendState>({ status: 'idle' })

  async function sendTest() {
    setState({ status: 'sending' })
    try {
      const res = await fetch(`/api/mailboxes/${props.id}/test-email`, { method: 'POST' })
      const json: unknown = await res.json()
      if (!res.ok) {
        const message = typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'failed'
        setState({ status: 'error', message })
        return
      }
      const providerMessageId = typeof json === 'object' && json !== null && 'providerMessageId' in json
        ? String((json as { providerMessageId: unknown }).providerMessageId) : ''
      setState({ status: 'sent', providerMessageId })
    } catch {
      setState({ status: 'error', message: 'network' })
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong>{props.provider}</strong> — {props.emailAddress}
        {props.displayName ? ` (${props.displayName})` : ''} · health: {props.health}
      </div>
      <div>
        <button type="button" onClick={sendTest} disabled={state.status === 'sending'}>
          {state.status === 'sending' ? 'Sending…' : 'Send test email'}
        </button>
        {state.status === 'sent' && <span role="status" style={{ color: 'green', marginLeft: 8 }}>Sent ✓</span>}
        {state.status === 'error' && <span role="alert" style={{ color: 'crimson', marginLeft: 8 }}>Error: {state.message}</span>}
      </div>
    </div>
  )
}
