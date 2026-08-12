'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Warning } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { createBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export default function LoginPage(): React.ReactElement {
  const t = useTranslations('auth')
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
      setError(t('signInError'))
      setIsSubmitting(false)
      return
    }
    router.push('/home')
    router.refresh()
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">{t('brand')}</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">{t('signInTitle')}</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {t('signInSubtitle')}
        </p>

        {/*
          Deliberately carries no WebMCP `toolname`/`tooldescription`. Lighthouse
          reports it under `webmcp-form-coverage`; that is the intended state. An
          annotated sign-in form advertises a credential sink to any agent
          driving the browser, and no agent should be typing a password.
        */}
        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4" noValidate={false}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-xs">
              {t('emailLabel')}
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
              {t('passwordLabel')}
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
            {isSubmitting ? t('signingIn') : t('signInButton')}
          </Button>
        </form>
      </div>
    </main>
  )
}
