import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { discoverSitemapPages } from '@/lib/knowledge/sitemap'
import { brightdataResearch } from '@/lib/research/brightdata'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ websiteUrl: z.string().url() })

// Operator-only, no clientId scoping needed for the discovery step itself —
// it doesn't write anything, just returns candidate urls for the picker.
export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const rawBody: unknown = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error', issues: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const urls = await discoverSitemapPages(brightdataResearch, parsed.data.websiteUrl)
    return NextResponse.json({ ok: true, urls })
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
