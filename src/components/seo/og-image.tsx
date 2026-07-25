import { ImageResponse } from 'next/og'
import {
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  SITE_NAME,
  SITE_SUMMARY,
  SITE_TITLE,
} from '@/lib/seo/site'

/**
 * The 1200×630 social card, generated at build time by Satori.
 *
 * Shared by `opengraph-image` and `twitter-image` so both cards are the same
 * artwork. Every element declares `display: flex` — Satori has no block
 * layout and throws on a multi-child element without it.
 */

export const OG_ALT = OG_IMAGE_ALT
export const OG_SIZE = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT } as const
export const OG_CONTENT_TYPE = 'image/png'

/** Matches `--l-bg` / `--l-text` / `--l-muted` on the landing page. */
const BACKGROUND = '#08080a'
const FOREGROUND = '#f5f5f6'
const MUTED = '#9a9aa1'
const HAIRLINE = '#26262b'

export function renderOgImage(): ImageResponse {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          backgroundColor: BACKGROUND,
          backgroundImage: `radial-gradient(65% 55% at 74% 14%, #17171c 0%, ${BACKGROUND} 68%)`,
          padding: '72px 80px',
          color: FOREGROUND,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', fontSize: 30, fontWeight: 600 }}>
          {SITE_NAME}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 82,
              fontWeight: 600,
              letterSpacing: '-0.035em',
              lineHeight: 1.05,
              maxWidth: 940,
            }}
          >
            {SITE_TITLE}.
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 32,
              fontSize: 30,
              lineHeight: 1.4,
              color: MUTED,
              maxWidth: 880,
            }}
          >
            {SITE_SUMMARY}
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 40,
            paddingTop: 32,
            borderTop: `1px solid ${HAIRLINE}`,
            fontSize: 24,
            color: MUTED,
          }}
        >
          <div style={{ display: 'flex' }}>Leads found</div>
          <div style={{ display: 'flex' }}>Emails sent</div>
          <div style={{ display: 'flex' }}>Replies</div>
          <div style={{ display: 'flex' }}>Meetings booked</div>
        </div>
      </div>
    ),
    OG_SIZE,
  )
}
