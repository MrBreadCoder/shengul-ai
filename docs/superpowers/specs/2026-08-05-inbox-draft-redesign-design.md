# Inbox draft: AI redesign box + manual editing — design

**Date:** 2026-08-05
**Status:** approved, ready for an implementation plan
**Scope:** `/inbox` → "Drafts awaiting approval" (`DraftRow`) only. The case-page compose
form (`cases/[id]/compose-form.tsx`), which is already a fully manual, non-AI send path,
is untouched.

---

## 1. Purpose

A client on `reply_mode: human_approve` ("Manual" in Settings) gets AI-written drafts —
first-touch outreach from `write.ts`, replies from `reply.ts` — queued in `/inbox` for an
operator to approve. Today `DraftRow` renders the subject/body as **read-only text**; the
only edits available are attachments, and "Approve and send" ships the AI's copy verbatim.

This adds two things to that same card:

1. **Redesign box** — a free-text instruction ("make it shorter", "lead with pricing")
   that has the AI rewrite the draft, re-grounded in the same case dossier (and thread,
   for replies) the original draft used — not a blind rewrite of the current text.
2. **Manual editing** — the subject/body become directly editable, so an operator can
   hand-tweak the AI's copy or clear it and write the email themselves from a blank box.

---

## 2. UX

`DraftRow` gains an "Edit" button next to the existing attachment editor
(`isEditingAttachments`'s sibling: `isEditingContent`), same show/hide pattern. Opening it
replaces the static subject/body block with:

- **Subject** `<Input>`, **Body** `<Textarea>` — pre-filled with the current draft,
  `maxLength` matching `MAX_SUBJECT_CHARS` / `MAX_BODY_CHARS`.
- **"Clear"** text-button — blanks both fields locally (not persisted until Save). This is
  the literal "write it manually" affordance: clear, then type from nothing.
- **Instruction** `<Input>` (placeholder: e.g. "make it shorter", "lead with the pricing
  angle") + **"Redesign"** button. Calling it sends the instruction to the AI; the response
  overwrites the Subject/Body fields in place (not auto-saved) so the operator can keep
  hand-editing before committing.
- **Save** — persists the current Subject/Body to the draft row.
- **Cancel** — discards in-progress edits, closes the form, reverts to the last saved draft.

**"Approve and send" is disabled whenever the edit form is open.** Approve always sends
whatever is currently persisted in the DB; leaving it enabled mid-edit would let an
operator send stale content while believing their edit already went out. Save or Cancel
first, then Approve.

Both Redesign and Save show their own pending state (`isPending`-style, mirroring
`isSavingAttachments`) so the Approve button and the rest of the card stay usable during
either.

---

## 3. Server Actions (`src/app/(app)/inbox/actions.ts`)

Both operator-only, matching the existing guard on `approveDraft` / `updateDraftAttachments`:
```ts
if (appUser.role !== 'operator') {
  throw new AppError('UNAUTHORIZED', 'Only operators can edit drafts', { userId: appUser.id })
}
```

### 3.1 `updateDraftContent`
```ts
const updateContentSchema = z.object({
  emailId: z.string().uuid(),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_CHARS),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
})

export async function updateDraftContent(formData: FormData): Promise<void>
```
Parses, calls the DB layer (§4), throws `AppError('VALIDATION_ERROR', 'Draft was already
sent', { emailId })` if the DB call returns `null` (lost the race to an approval),
`revalidatePath('/inbox')`.

### 3.2 `regenerateDraftContent`
```ts
const regenerateSchema = z.object({
  emailId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
})

export interface RegenerateDraftResult {
  ok: true
  subject: string
  body: string
} | {
  ok: false
  code: 'VALIDATION_ERROR' | 'EXTERNAL_ERROR' | 'EXTERNAL_TIMEOUT'
}

export async function regenerateDraftContent(formData: FormData): Promise<RegenerateDraftResult>
```
Loads the email (must be `status: 'draft'`, `direction: 'outbound'` — same check
`approveDraft` uses), calls `regenerateDraftContent` from the new pipeline module (§5),
writes the result via the same DB function as manual Save, `revalidatePath('/inbox')`,
returns the new subject/body so the client updates the edit fields without a full reload.
Returns a typed `ok: false` (not a thrown error) for the LLM-failure case specifically,
mirroring `SendManualEmailResult`'s pattern in `compose-form.tsx` — a redesign failure is
an expected, user-facing outcome the operator retries, not a crash.

---

## 4. DB layer (`src/lib/db/emails.ts`)

```ts
// Same atomic-claim shape as claimDraftForSend: the `.eq('status','draft')` guard
// means a concurrent approval (double-click, two tabs, an approval that landed while
// this edit was in flight) makes this a no-op that returns null instead of silently
// overwriting a row that has already gone out.
export async function updateDraftContent(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: { subject: string; body: string },
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .update({ subject: patch.subject, body: patch.body })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update draft content', { id, cause: error.message })
  }
  return data && data.length > 0 ? data[0]! : null
}
```

Used by both `updateDraftContent` (manual Save) and `regenerateDraftContent` (AI Redesign)
Server Actions — one DB write path for both.

---

## 5. Pipeline (`src/lib/pipeline/redesign.ts`, new)

```ts
export interface RegenerateInput {
  emailId: string
  instruction: string
}

export async function regenerateDraftContent(
  supabase: SupabaseClient<Database>,
  input: RegenerateInput,
): Promise<{ subject: string; body: string }>
```

1. `getEmailById` — throws `AppError('NOT_FOUND', …)` if missing, `AppError('VALIDATION_ERROR', 'Draft is missing required fields', …)` if `case_id`/`lead_id` is null (mirrors `approveDraft`'s guard).
2. `listKnowledgeForCase` (dossier) + `retrieveClientKnowledge` — identical calls to
   `write.ts`/`reply.ts`.
3. **Branch on `email.in_reply_to_email_id`:**
   - Set → this is a reply draft. Also `listThreadEmails(lead_id)` for prior-thread context,
     same as `reply.ts`.
   - Null → first-touch draft. No thread to load.
4. Build the prompt: current subject/body, dossier, thread (if branch 3a), the operator's
   instruction, and an explicit constraint: *"Use ONLY the facts already present in the
   dossier/thread below. Never invent a new fact, even if the instruction implies one —
   if the instruction asks for something not supported by the dossier, do the best you
   can within it and leave that part out rather than inventing it."*
5. Call `generateJson` with the **shared** system prompt + schema (§5.1) —
   `MAX_OUTPUT_TOKENS = 1_400`, `actor: 'email_redesign_agent'`.
6. `logEventSafe({ clientId, caseId, actor: 'email_redesign_agent', type: 'inbox.draft_regenerated', payload: { emailId, instruction } })` — audit trail of what was asked for, separate from the `llm.completed` token-usage log `generateJson` already emits.
7. Returns `{ subject, body }`. Does **not** write to the DB itself — the calling Server
   Action does that through the same `updateDraftContent` DB function as manual Save, so
   there is exactly one write path for draft content.

### 5.1 Shared schema (`src/lib/pipeline/draft-schema.ts`, new)

`write.ts` currently defines `draftSchema` / `SUBJECT_TARGET_CHARS` / `SUBJECT_HARD_LIMIT`
locally. Pulled out so `redesign.ts` uses the exact same shape instead of a second,
possibly-drifting copy:

```ts
export const SUBJECT_TARGET_CHARS = 40
export const SUBJECT_HARD_LIMIT = 78
export const draftSchema = z.object({
  subject: z.string().min(1).max(SUBJECT_HARD_LIMIT),
  body: z.string().min(1),
})
```

`write.ts` is updated to import these instead of defining them, no behavior change there.

### 5.2 System prompt

Reuses `HUMAN_VOICE_INSTRUCTION` (already shared between `write.ts`/`followup.ts`) plus the
same tone/format rules `write.ts`'s `SYSTEM_PROMPT` carries (length, no spam words, subject
constraints), with one addition specific to redesign: *"If the draft is a reply within an
existing thread, keep the subject prefixed with 'Re: ' unless the instruction explicitly
asks to change it."*

---

## 6. Validation (`src/lib/validation/email-limits.ts`)

```ts
export const MAX_INSTRUCTION_CHARS = 500
```
Added alongside the existing `MAX_SUBJECT_CHARS`/`MAX_BODY_CHARS`, same reasoning
(shared between the Server Action's Zod schema and the instruction `<Input>`'s
`maxLength`).

---

## 7. Error handling surfaced in `draft-row.tsx`

- `updateDraftContent` (Save) failure → toast, same pattern as `onSaveAttachments`'s
  `toast.error`. A `VALIDATION_ERROR` with message "Draft was already sent" is shown
  verbatim; anything else falls back to "Could not save that change."
- `regenerateDraftContent` (Redesign) `ok: false` → inline message under the instruction
  box (not a toast — the operator is mid-edit and the instruction text should stay visible
  to retry), keyed off `code`:
  - `EXTERNAL_TIMEOUT` / `EXTERNAL_ERROR` → "Could not redesign that draft. Try again."
  - `VALIDATION_ERROR` → "This draft was already sent, so it can no longer be redesigned."
- The operator's typed instruction and any unsaved manual edits are never cleared on a
  Redesign failure — only a successful Redesign overwrites the fields.

---

## 8. Testing

Per `QUALITY.md` coverage targets.

**`emails.test.ts`** — `updateDraftContent`: happy path returns the updated row; returns
`null` when the row is no longer `status: 'draft'`; Supabase error maps to `AppError`.

**`redesign.test.ts`** (new, mirrors `write.test.ts`/`reply.test.ts` mocking style) —
missing email → `NOT_FOUND`; missing `case_id`/`lead_id` → `VALIDATION_ERROR`; first-touch
branch (`in_reply_to_email_id` null) does not call `listThreadEmails`; reply branch
(`in_reply_to_email_id` set) does; happy path returns `{ subject, body }` from the mocked
`generateJson` and does not itself call the DB write; `logEventSafe` fires with
`{ emailId, instruction }`.

**`actions.test.ts`** — `updateDraftContent` action: non-operator → `UNAUTHORIZED`;
oversized subject/body → Zod rejection; happy path calls the DB function and
`revalidatePath`; DB returning `null` → thrown `VALIDATION_ERROR`.
`regenerateDraftContent` action: non-operator → `UNAUTHORIZED`; oversized instruction →
Zod rejection; pipeline throw → mapped to `ok: false` with the right `code`; happy path
returns `ok: true` with the new content and calls `updateDraftContent` (DB) +
`revalidatePath`.

**Component (`draft-row.test.tsx` if one doesn't exist, else extend)** — Edit button
reveals editable fields pre-filled with props; Approve is disabled while editing; Clear
blanks both fields; Save success closes the form and shows updated text; Save failure
toasts and keeps the form open; Redesign success repopulates the fields without closing
the form; Redesign failure shows the inline error and preserves the instruction text and
any unsaved manual edits.

---

## 9. Out of scope

- No history of prior redesign attempts or drafts — Redesign overwrites in place; the only
  way back to an earlier version is Cancel (before Save) or reloading (after Save, there is
  no undo).
- No cap on how many times Redesign can be clicked on one draft beyond the existing
  operator-only auth boundary — no new rate limiting.
- Case-page compose form (`cases/[id]/compose-form.tsx`) is unchanged; it remains a fully
  manual, non-AI send path with no redesign box.
- No change to `reply_mode` semantics, `write.ts`'s or `reply.ts`'s send/draft disposition
  logic, or attachment editing — this only adds an edit surface to an existing draft row.

---

## 10. Implementation order

1. `MAX_INSTRUCTION_CHARS` in `email-limits.ts`.
2. Extract `draft-schema.ts`; update `write.ts` to import from it (no behavior change),
   with existing `write.test.ts` still passing.
3. `updateDraftContent` in `lib/db/emails.ts`, with tests.
4. `src/lib/pipeline/redesign.ts` (`regenerateDraftContent`), with tests.
5. `updateDraftContent` + `regenerateDraftContent` Server Actions in
   `app/(app)/inbox/actions.ts`, with tests.
6. `draft-row.tsx` UI: edit mode, Clear, instruction box, Redesign button, Save/Cancel,
   Approve disabled while editing, error/pending states.
7. Manual verification: as an operator, open a queued draft, Redesign with an instruction,
   confirm the rewrite reflects the dossier and the instruction; hand-edit and Save; clear
   and write one from scratch; confirm Approve is disabled mid-edit and sends the saved
   content afterward.
