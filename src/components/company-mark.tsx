'use client'

import { useState } from 'react'
import Image from 'next/image'
import { hueFor, initialsFor } from '@/lib/format'
import { cn } from '@/lib/utils'

interface CompanyMarkProps {
  name: string
  /** An explicitly uploaded logo. Takes priority over `domain`'s favicon when set. */
  logoUrl?: string | null
  /** The company's website domain, when known. Renders the real favicon in place of the initials tile. */
  domain?: string | null
  className?: string
}

const FAVICON_PX = 64
const LOGO_PX = 128

/**
 * Company avatar. Priority: explicit `logoUrl` > favicon fetched for `domain`
 * > a monogram tile — hue derived from the name, so the same company always
 * looks the same even before (or without) a logo/favicon load. The fallback
 * also covers the load failing: a site can 404 a favicon request, redirect
 * oddly, or block hotlinking outright, and an uploaded logo URL can go stale.
 */
export function CompanyMark({ name, logoUrl, domain, className }: CompanyMarkProps): React.ReactElement {
  const [hasImageError, setHasImageError] = useState(false)
  const showLogo = Boolean(logoUrl) && !hasImageError
  const showFavicon = !showLogo && Boolean(domain) && !hasImageError
  const showImage = showLogo || showFavicon
  const hue = hueFor(name)

  const imageSrc = showLogo
    ? (logoUrl as string)
    : `https://www.google.com/s2/favicons?sz=${FAVICON_PX}&domain=${encodeURIComponent(domain as string)}`

  return (
    <span
      aria-hidden
      className={cn(
        'grid size-8 shrink-0 place-items-center overflow-hidden rounded-md',
        !showImage && 'text-[11px] font-semibold tracking-tight',
        className,
      )}
      style={
        showImage
          ? undefined
          : {
              color: `oklch(0.78 0.11 ${hue})`,
              background: `oklch(0.78 0.11 ${hue} / 0.14)`,
              boxShadow: `inset 0 0 0 1px oklch(0.78 0.11 ${hue} / 0.2)`,
            }
      }
    >
      {showImage ? (
        <Image
          src={imageSrc}
          alt=""
          width={showLogo ? LOGO_PX : FAVICON_PX}
          height={showLogo ? LOGO_PX : FAVICON_PX}
          className="size-full object-contain p-1"
          onError={() => setHasImageError(true)}
        />
      ) : (
        initialsFor(name)
      )}
    </span>
  )
}
