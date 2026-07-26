import type { Metadata } from 'next'
import Link from 'next/link'
import { z } from 'zod'
import { Clock, Warning } from '@phosphor-icons/react/dist/ssr'
import { formatInviteTtl, INVITE_TTL_MINUTES } from '@/lib/auth/invite-ttl'

// Only ever reached from a dead link, so it must never be indexed or given a
// canonical URL of its own.
export const metadata: Metadata = {
  title: 'Link expired',
  robots: { index: false, follow: false },
}

const reasonSchema = z.enum(['expired', 'invalid'])

const COPY = {
  expired: {
    icon: Clock,
    title: 'This link has expired',
    body: `Sign-in links stay valid for ${formatInviteTtl(INVITE_TTL_MINUTES)}. Ask whoever invited you for a new one — it takes them a moment, and the new link will work the same way.`,
  },
  invalid: {
    icon: Warning,
    title: 'This link is not valid',
    body: 'It may have been mistyped, cut short by the app it was sent through, or replaced by a newer invite. Ask whoever invited you to send a fresh link.',
  },
} as const

interface InviteExpiredPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function InviteExpiredPage({
  searchParams,
}: InviteExpiredPageProps): Promise<React.ReactElement> {
  const parsed = reasonSchema.safeParse((await searchParams).reason)
  const { icon: Icon, title, body } = COPY[parsed.success ? parsed.data : 'expired']

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
        </div>

        <div
          className="text-muted-foreground mt-8 flex size-9 items-center justify-center rounded-lg"
          style={{ background: 'color-mix(in oklch, var(--muted-foreground) 10%, transparent)' }}
        >
          <Icon size={17} weight="light" />
        </div>

        <h1 className="mt-5 text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">{body}</p>

        <p className="text-muted-foreground mt-7 text-xs">
          Already set a password?{' '}
          <Link href="/login" className="text-foreground underline underline-offset-4">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  )
}
