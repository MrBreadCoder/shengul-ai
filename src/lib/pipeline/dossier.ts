import type { Database } from '@/types/database'
import type { KnowledgeRow } from '@/lib/db/case-knowledge'

// Lower number = surfaced first in the dossier text handed to the model. A
// (pain_point) or (news) fact makes a far sharper personalization hook than
// a bare (company) firmographic line (industry/size/founding year/location)
// — putting the sharpest facts first means the model reaches for them before
// it ever gets to the generic ones. Shared by write.ts (first-touch) and
// followup.ts (nudges) so the two prompts that both build a dossier from
// case_knowledge rows never drift apart on ranking.
export const DOSSIER_KIND_PRIORITY: Record<Database['public']['Enums']['knowledge_kind'], number> = {
  pain_point: 0,
  news: 1,
  answer: 2,
  person: 3,
  company: 4,
}

// Sharpest-first, stable otherwise (Array.prototype.sort is stable) so two
// rows of the same kind keep their case_knowledge insertion order.
export function sortDossierByPriority(knowledge: KnowledgeRow[]): KnowledgeRow[] {
  return [...knowledge].sort((a, b) => DOSSIER_KIND_PRIORITY[a.kind] - DOSSIER_KIND_PRIORITY[b.kind])
}
