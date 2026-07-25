'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Warning } from '@phosphor-icons/react'
import { createBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const MIN_PASSWORD_LENGTH = 8

export function SetPasswordForm(): React.ReactElement {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setIsSubmitting(true)
    const supabase = createBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError('Could not set your password. Try requesting a new invite link.')
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="password" className="text-xs">
          New password
        </Label>
        <Input
          id="password"
          type="password"
          value={password}
          required
          autoComplete="new-password"
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm" className="text-xs">
          Confirm password
        </Label>
        <Input
          id="confirm"
          type="password"
          value={confirm}
          required
          autoComplete="new-password"
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-xs"
          style={{ background: 'color-mix(in oklch, var(--destructive) 12%, transparent)' }}
        >
          <Warning size={14} weight="fill" className="mt-px shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Saving…' : 'Set password and continue'}
      </Button>
    </form>
  )
}
