'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Database } from '@/types/database'

type EmailStyleValue = Database['public']['Enums']['email_style']

const EMAIL_STYLES: readonly EmailStyleValue[] = ['concise', 'formal_intro']

const LABELS: Record<EmailStyleValue, string> = {
  concise: 'Concise (default)',
  formal_intro: 'Formal introduction',
}

interface EmailStyleSelectProps {
  clientId: string
  value: EmailStyleValue
}

// Operator-only control — plain English strings, no useTranslations. Per
// CLAUDE.md: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES,
// TRANSLATE ONLY IN CLIENT FACING PLACES" — this page 404s for non-operators
// (see page.tsx's `if (appUser.role !== 'operator') notFound()`).
export function EmailStyleSelect({ clientId, value }: EmailStyleSelectProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(style: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailStyle: style }),
    })
    if (!response.ok) {
      setError('Failed to save email style.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`email-style-${clientId}`} className="text-faint text-[11px]">
        First-touch email style
      </label>
      <select
        id={`email-style-${clientId}`}
        value={value}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {EMAIL_STYLES.map((style) => (
          <option key={style} value={style}>
            {LABELS[style]}
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
