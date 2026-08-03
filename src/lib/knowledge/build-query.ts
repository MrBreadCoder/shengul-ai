export const MAX_SECONDARY_CHARS = 500

export interface BuildKnowledgeQueryTextArgs {
  primary: string
  secondary?: string[]
}

// The most specific available signal (a prospect's actual question, when one
// exists) must dominate the embedding query — a long dossier fact-dump
// concatenated alongside it can pull the embedding's semantic centroid away
// from what the search should actually be about. `secondary` is capped so it
// adds context without drowning `primary`; when `primary` IS the dossier
// (the write.ts case, before any prospect signal exists), no cap applies.
export function buildKnowledgeQueryText(args: BuildKnowledgeQueryTextArgs): string {
  const primary = args.primary.trim()
  const secondaryText = (args.secondary ?? [])
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')

  if (primary.length === 0) return secondaryText

  const cappedSecondary = secondaryText.slice(0, MAX_SECONDARY_CHARS)
  return cappedSecondary.length > 0 ? `${primary} ${cappedSecondary}` : primary
}
