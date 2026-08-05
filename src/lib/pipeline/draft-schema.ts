import { z } from 'zod'

// Best-practice target for full display without mobile truncation.
export const SUBJECT_TARGET_CHARS = 40
// Hard ceiling enforced on the model's structured output — a guardrail against
// runaway generation, well above SUBJECT_TARGET_CHARS so normal output never hits it.
export const SUBJECT_HARD_LIMIT = 78

// Shared between write.ts (first-touch generation) and redesign.ts
// (AI-assisted draft rewrites in /inbox) so the two never validate the
// model's structured output against different limits.
export const draftSchema = z.object({
  subject: z.string().min(1).max(SUBJECT_HARD_LIMIT),
  body: z.string().min(1),
})
export type Draft = z.infer<typeof draftSchema>
