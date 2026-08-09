'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { EmailStyleRow } from '@/lib/db/email-styles'
import { EmailStyleManagerDialog } from './email-style-manager-dialog'

interface EmailStyleSelectProps {
  clientId: string
  styles: EmailStyleRow[]
  selectedStyleId: string
}

// Operator-only control — plain English strings, no useTranslations. Per
// CLAUDE.md: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES,
// TRANSLATE ONLY IN CLIENT FACING PLACES" — this page 404s for non-operators
// (see page.tsx's `if (appUser.role !== 'operator') notFound()`).
//
// `selectedStyleId` is always a real row id, resolved by page.tsx from
// `client.email_style_id ?? defaultStyle.id` — the dropdown never renders a
// synthetic "default" placeholder option.
export function EmailStyleSelect({ clientId, styles, selectedStyleId }: EmailStyleSelectProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(styleId: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailStyleId: styleId }),
    })
    if (!response.ok) {
      setError('Failed to save email style.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <label htmlFor={`email-style-${clientId}`} className="text-faint text-[11px]">
          First-touch email style
        </label>
        <EmailStyleManagerDialog
          clientId={clientId}
          styles={styles}
          selectedStyleId={selectedStyleId}
          onChanged={() => router.refresh()}
        />
      </div>
      <select
        id={`email-style-${clientId}`}
        value={selectedStyleId}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {styles.map((style) => (
          <option key={style.id} value={style.id}>
            {style.name}
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
