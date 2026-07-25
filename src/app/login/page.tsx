'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Warning } from '@phosphor-icons/react'
import { createBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginPage(): React.ReactElement {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    const supabase = createBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      // Deliberately does not distinguish unknown email from wrong password.
      setError('That email and password combination did not work.')
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="bg-primary/15 text-primary grid size-8 place-items-center rounded-md text-sm font-bold"
          >
            B
          </span>
          <span className="text-sm font-semibold tracking-tight">Beacon</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Your outreach pipeline, mail and case knowledge.
        </p>

        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4" noValidate={false}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-xs">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              required
              autoComplete="email"
              autoFocus
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-xs">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              value={password}
              required
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
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
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </main>
  )
}
