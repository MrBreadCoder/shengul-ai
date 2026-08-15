'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { EmailTemplateRow } from '@/lib/db/email-templates'
import { EmailTemplateManagerDialog } from './email-template-manager-dialog'

interface EmailTemplateSelectProps {
  clientId: string
  templates: EmailTemplateRow[]
  selectedTemplateId: string
}

// Operator-only control — plain English strings, no useTranslations. Per
// CLAUDE.md: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES,
// TRANSLATE ONLY IN CLIENT FACING PLACES" — this page 404s for non-operators
// (see page.tsx's `if (appUser.role !== 'operator') notFound()`).
//
// `selectedTemplateId` is always a real row id, resolved by page.tsx from
// `client.email_template_id ?? defaultTemplate.id` — the dropdown never
// renders a synthetic "default" placeholder option.
export function EmailTemplateSelect({
  clientId,
  templates,
  selectedTemplateId,
}: EmailTemplateSelectProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(templateId: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailTemplateId: templateId }),
    })
    if (!response.ok) {
      setError('Failed to save email template.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <label htmlFor={`email-template-${clientId}`} className="text-faint text-[11px]">
          First-touch email template
        </label>
        <EmailTemplateManagerDialog
          clientId={clientId}
          templates={templates}
          selectedTemplateId={selectedTemplateId}
          onChanged={() => router.refresh()}
        />
      </div>
      <select
        id={`email-template-${clientId}`}
        value={selectedTemplateId}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {templates.map((template) => (
          <option key={template.id} value={template.id}>
            {template.name}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
