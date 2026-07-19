import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { outlookProvider } from '@/lib/mailbox/outlook-provider'

export const runtime = 'nodejs'

export async function GET() {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return NextResponse.redirect(outlookProvider.buildAuthUrl(appUser.id))
}
