import type { Database } from '@/types/database'

export type LeadStage = Database['public']['Enums']['lead_stage']

// Mirrors the active-stage ranking in
// supabase/migrations/0054_recompute_case_status.sql -- keep both in sync.
const ACTIVE_STAGE_RANK: readonly LeadStage[] = ['hot_handoff', 'in_conversation', 'contacted', 'waiting']

// Turns the distinct stages present among a case's contacts into the
// ordered badge list for its row: most-positive first, and lost/dead
// suppressed unless every contact on the case is terminal (matches
// recompute_case_status's own all-terminal rule).
export function buildStageBadges(stages: readonly LeadStage[]): LeadStage[] {
  const distinct = new Set(stages)
  const active = ACTIVE_STAGE_RANK.filter((stage) => distinct.has(stage))
  if (active.length > 0) return active
  if (distinct.has('lost')) return ['lost']
  if (distinct.has('dead')) return ['dead']
  return []
}
