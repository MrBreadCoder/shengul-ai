import type { ImageResponse } from 'next/og'
import { OG_ALT, OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from '@/components/seo/og-image'

export const alt = OG_ALT
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

/** Site-wide Open Graph card. Every route inherits it unless it defines its own. */
export default function OpengraphImage(): ImageResponse {
  return renderOgImage()
}
