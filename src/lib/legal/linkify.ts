import { LEGAL_PATH_PREFIX } from '@/lib/legal/registry'

/**
 * These documents cite each other constantly, and a policy that names a sibling
 * document without linking to it makes the reader hunt. Rather than fragment the
 * copy into React nodes — which would make it unreadable in source and
 * ungreppable — the copy stays plain prose and the paths inside it are turned
 * into links at render time.
 */

export type TextSegment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'link'; readonly value: string; readonly href: string }

/**
 * Matches `/legal/<slug>` where the slug is lowercase hyphen-joined words. The
 * shape matters: it stops the match before a trailing period or comma, so
 * "see /legal/privacy-policy." links the path and leaves the sentence intact.
 */
const LEGAL_PATH_PATTERN = new RegExp(`${LEGAL_PATH_PREFIX}/[a-z0-9]+(?:-[a-z0-9]+)*`, 'g')

export function splitLegalReferences(text: string): readonly TextSegment[] {
  const segments: TextSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(LEGAL_PATH_PATTERN)) {
    // `matchAll` on a global regex always sets index; the guard is for the type.
    const start = match.index ?? 0
    if (start > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, start) })
    }
    segments.push({ kind: 'link', value: match[0], href: match[0] })
    cursor = start + match[0].length
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) })
  }

  return segments
}
