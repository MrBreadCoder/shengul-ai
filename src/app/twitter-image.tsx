import type { ImageResponse } from 'next/og'
import { OG_ALT, OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from '@/components/seo/og-image'

export const alt = OG_ALT
export const size = OG_SIZE
export const contentType = OG_CONTENT_TYPE

/**
 * Same artwork as the Open Graph card. X/Twitter does not fall back to
 * `og:image` when a `summary_large_image` card is declared without one.
 */
export default function TwitterImage(): ImageResponse {
  return renderOgImage()
}
