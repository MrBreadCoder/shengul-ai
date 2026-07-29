// Shared between note-actions.ts's Zod schemas (a 'use server' file whose
// exports must all be Server Actions — this constant cannot live there) and
// notes-panel.tsx's maxLength props, so the two never drift apart.
//
// Generous: a note is a human's own writing, not machine output. The ceiling
// exists so a paste accident cannot push an unbounded string into Postgres.
export const MAX_NOTE_CHARS = 4_000
