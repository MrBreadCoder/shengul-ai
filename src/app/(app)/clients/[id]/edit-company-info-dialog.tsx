'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Buildings } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

type EditState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface EditCompanyInfoDialogProps {
  clientId: string
  currentCompanyInfo: string | null
}

// Operator-only page (see clients/[id]/page.tsx's `if (appUser.role !==
// 'operator') notFound()`) — no i18n here per .claude/roadmap.md's
// "translate only client-facing places" rule, unlike the neighboring dialogs
// that predate that rule.
//
// Free text, injected verbatim as "About our company" by every outbound
// pipeline stage (write.ts, followup.ts, redesign.ts, reply.ts,
// knowledge-answer.ts) in place of the website-crawled RAG retrieval those
// stages used before — see updateClientCompanyInfo in lib/db/clients.ts and
// docs/superpowers/specs/2026-08-09-manual-company-info-design.md. Submitting
// it empty clears it, same convention as EditSignatureDialog.
export function EditCompanyInfoDialog({
  clientId,
  currentCompanyInfo,
}: EditCompanyInfoDialogProps): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [companyInfo, setCompanyInfo] = useState(currentCompanyInfo ?? '')
  const [state, setState] = useState<EditState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyInfo }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not update the company info.'
        setState({ status: 'error', message })
        toast.error('Update failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success('Company info updated')
      router.refresh()
    } catch {
      setState({ status: 'error', message: 'Network error — please try again.' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setCompanyInfo(currentCompanyInfo ?? '')
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Edit company info">
          <Buildings size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Company info</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          // Declarative WebMCP: an agent may fill this in, but the operator
          // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
          toolname="setClientCompanyInfo"
          tooldescription="Records the free-text company description injected as 'About our company' into every outbound email prompt (first-touch, follow-up, redesign, reply, and knowledge-answer). Submitting it empty clears it."
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="companyInfo" className="text-xs">
              About the company
            </Label>
            <Textarea
              id="companyInfo"
              name="companyInfo"
              value={companyInfo}
              onChange={(event) => setCompanyInfo(event.target.value)}
              placeholder="What the company does, who it serves, what makes it different — the AI writes every outbound email from this."
              rows={8}
              toolparamdescription="The company description used in every outbound email prompt, e.g. 'Acme builds inventory software for mid-size retailers...'. Optional; leave blank to clear it."
            />
            <p className="text-faint text-[11px]">
              This is the only source of company background the email-writing AI sees — it no longer reads the
              client&apos;s website automatically.
            </p>
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting'}>
              {state.status === 'submitting' ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
