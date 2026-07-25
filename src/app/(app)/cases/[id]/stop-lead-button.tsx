'use client'

import { useState, useTransition } from 'react'
import { Prohibit } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { stopLead } from './actions'

interface StopLeadButtonProps {
  leadId: string
  caseId: string
  fullName: string
}

// Two-step on purpose: stopping is externally visible (it suppresses the address
// permanently for this client and kills an in-flight sequence), so it follows
// the same confirm pattern as the client pause/archive controls.
export function StopLeadButton({ leadId, caseId, fullName }: StopLeadButtonProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function confirm(): void {
    setError(null)
    const data = new FormData()
    data.set('leadId', leadId)
    data.set('caseId', caseId)
    startTransition(async () => {
      try {
        await stopLead(data)
        setIsOpen(false)
      } catch {
        setError('Could not stop this contact. Try again.')
      }
    })
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={`Stop outreach to ${fullName}`}>
          <Prohibit size={13} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop outreach to {fullName}?</DialogTitle>
          <DialogDescription>
            Their address is added to your suppression list, any running follow-up sequence stops, and the
            contact is parked. Nothing is deleted, but no further email is ever sent to them.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-[12px]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={isPending}>
            {isPending ? 'Stopping…' : 'Yes, stop outreach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
