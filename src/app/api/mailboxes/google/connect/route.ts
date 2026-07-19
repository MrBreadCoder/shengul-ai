import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { gmailProvider } from '@/lib/mailbox/gmail-provider'

export const runtime = 'nodejs'

export async function GET() {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // state carries the initiating user id; validated on callback via session.
  return NextResponse.redirect(gmailProvider.buildAuthUrl(appUser.id))
}
