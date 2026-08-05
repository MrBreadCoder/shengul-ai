// Shared between sendManualEmail's Zod schema (send-actions.ts, a 'use server'
// file whose exports must all be Server Actions — these constants cannot live
// there) and compose-form.tsx's maxLength props, so the two never drift apart.
export const MAX_SUBJECT_CHARS = 200
export const MAX_BODY_CHARS = 20_000

// Shared between the inbox redesign Server Action's Zod schema and
// draft-row.tsx's instruction <Input> maxLength, for the same reason.
export const MAX_INSTRUCTION_CHARS = 500
