import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { SetPasswordForm } from './set-password-form'

export const metadata: Metadata = { title: 'Set your password' }

export default async function SetPasswordPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')

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

        <h1 className="mt-8 text-xl font-semibold tracking-tight">Set your password</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Signed in as {data.user.email}. Choose a password to finish setting up your account.
        </p>

        <SetPasswordForm />
      </div>
    </main>
  )
}
