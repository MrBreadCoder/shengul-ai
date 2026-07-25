import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { SetPasswordForm } from './set-password-form'

// Reachable only from an invite link, so it must never appear in an index or
// be attributed a canonical URL of its own.
export const metadata: Metadata = {
  title: 'Set your password',
  robots: { index: false, follow: false },
}

export default async function SetPasswordPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
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
