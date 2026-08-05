# Inbox Draft Redesign + Manual Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On `/inbox` → "Drafts awaiting approval", let an operator (1) type an instruction and have the AI rewrite a queued draft, re-grounded in the same case dossier/thread the original draft used, and (2) hand-edit or fully rewrite the subject/body themselves before approving.

**Architecture:** Extract the existing `write.ts` draft schema into a shared `draft-schema.ts` so a new `redesign.ts` pipeline function can validate AI rewrites against the same shape. `redesign.ts` re-fetches the case dossier (and, for reply drafts, the prior thread) and asks the LLM to rewrite per the operator's instruction — it does not write to the DB itself. A new `updateDraftContent` DB function (atomic `.eq('status','draft')` guard, mirroring `claimDraftForSend`) is the single write path for both a manual save and a redesign result, wired through two new operator-only Server Actions. `draft-row.tsx` gains an edit mode: editable Subject/Body, an instruction box + "Redesign" button, Save/Clear/Cancel, and "Approve and send" disabled while the form is open.

**Tech Stack:** Next.js Server Actions, Supabase/Postgres, Zod, Vitest, `ai` SDK (`generateObject` via `generateJson`), React/Tailwind.

## Global Constraints

- Scope is `/inbox` → `DraftRow` only. `cases/[id]/compose-form.tsx` (the fully manual, non-AI send path) is not touched.
- Both new Server Actions are operator-only: `appUser.role !== 'operator'` throws `AppError('UNAUTHORIZED', …)`, matching `approveDraft`/`updateDraftAttachments` exactly.
- `updateDraftContent` (DB layer) only ever mutates a row still in `status: 'draft'` — same atomic-claim shape as `claimDraftForSend` — so a draft approved mid-edit cannot be silently overwritten.
- The AI redesign call must be grounded in the case's dossier (`case_knowledge`) and, for reply drafts (`in_reply_to_email_id` set), the prior thread — never a blind rewrite of just the current text — and must never invent a fact not already present in that context.
- "Approve and send" is disabled whenever the edit form is open, so an operator can never send stale DB content while believing an in-progress edit already went out.
- Reuses `MAX_SUBJECT_CHARS`/`MAX_BODY_CHARS` from `src/lib/validation/email-limits.ts`; adds `MAX_INSTRUCTION_CHARS = 500` to the same file.
- No `any`, no bare `Error` — `AppError` with a typed `code` on every failure path; every Supabase call destructures `{ data, error }` and handles both.
- One function per DB operation in `src/lib/db/`. Follow `.claude/QUALITY.md`.
- Design doc: `docs/superpowers/specs/2026-08-05-inbox-draft-redesign-design.md`.

---

### Task 1: Extract shared `draftSchema` into `draft-schema.ts`

**Files:**
- Create: `src/lib/pipeline/draft-schema.ts`
- Test: `src/lib/pipeline/draft-schema.test.ts`
- Modify: `src/lib/pipeline/write.ts:1-32`

**Interfaces:**
- Consumes: nothing new.
- Produces: `draftSchema: z.ZodObject<{ subject: z.ZodString; body: z.ZodString }>`, `type Draft = z.infer<typeof draftSchema>`, `SUBJECT_TARGET_CHARS = 40`, `SUBJECT_HARD_LIMIT = 78` — all from `src/lib/pipeline/draft-schema.ts`. Used by `write.ts` (this task) and `redesign.ts` (Task 3).

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipeline/draft-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { draftSchema, SUBJECT_HARD_LIMIT } from './draft-schema'

describe('draftSchema', () => {
  it('should accept a valid subject and body', () => {
    const result = draftSchema.safeParse({ subject: 'Quick idea for Acme', body: 'Hi Jane, saw you just...' })
    expect(result.success).toBe(true)
  })

  it('should reject an empty subject', () => {
    const result = draftSchema.safeParse({ subject: '', body: 'Hi Jane...' })
    expect(result.success).toBe(false)
  })

  it('should reject a subject over the hard limit', () => {
    const result = draftSchema.safeParse({ subject: 'x'.repeat(SUBJECT_HARD_LIMIT + 1), body: 'Hi Jane...' })
    expect(result.success).toBe(false)
  })

  it('should reject an empty body', () => {
    const result = draftSchema.safeParse({ subject: 'Quick idea', body: '' })
    expect(result.success).toBe(false)
  })

  it('should reject a payload missing the body field', () => {
    const result = draftSchema.safeParse({ subject: 'Quick idea' })
    expect(result.success).toBe(false)
  })

  it('should reject a non-string subject', () => {
    const result = draftSchema.safeParse({ subject: 123, body: 'Hi Jane...' })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/pipeline/draft-schema.test.ts`
Expected: FAIL — `./draft-schema` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/draft-schema.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/pipeline/draft-schema.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Point `write.ts` at the shared schema**

In `src/lib/pipeline/write.ts`, replace lines 1-32:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { listActiveLeadsForCase, type LeadRow } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { claimOutboundEmail, markEmailSent, markEmailFailed } from '@/lib/db/emails'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from './followup'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'

const MAX_OUTPUT_TOKENS = 1_400
const ACTOR = 'email_writer_agent'
// Best-practice target for full display without mobile truncation.
const SUBJECT_TARGET_CHARS = 40
// Hard ceiling enforced on the model's structured output — a guardrail against
// runaway generation, well above SUBJECT_TARGET_CHARS so normal output never hits it.
const SUBJECT_HARD_LIMIT = 78

export type ReplyMode = Database['public']['Enums']['reply_mode']

const draftSchema = z.object({
  subject: z.string().min(1).max(SUBJECT_HARD_LIMIT),
  body: z.string().min(1),
})
```

with:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { listActiveLeadsForCase, type LeadRow } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { claimOutboundEmail, markEmailSent, markEmailFailed } from '@/lib/db/emails'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from './followup'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
import { draftSchema, SUBJECT_TARGET_CHARS } from './draft-schema'

const MAX_OUTPUT_TOKENS = 1_400
const ACTOR = 'email_writer_agent'

export type ReplyMode = Database['public']['Enums']['reply_mode']
```

(The `z` import is dropped — `write.ts` no longer uses `z` directly once `draftSchema` moves out. Everything below line 32 in the original file — `SYSTEM_PROMPT`, `buildPrompt`, `processLead`, `runWriteForCase`, etc. — is unchanged.)

- [ ] **Step 6: Verify `write.ts`'s existing tests and the whole project still typecheck**

Run: `pnpm exec vitest run src/lib/pipeline/write.test.ts && pnpm typecheck`
Expected: all of `write.test.ts`'s existing tests still PASS; no typecheck errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/draft-schema.ts src/lib/pipeline/draft-schema.test.ts src/lib/pipeline/write.ts
git commit -m "feat: extract shared draftSchema from write.ts"
```

---

### Task 2: `updateDraftContent` in `lib/db/emails.ts`

**Files:**
- Modify: `src/lib/db/emails.ts:162` (insert after `claimDraftForSend`, before `markEmailSent`)
- Test: `src/lib/db/emails.test.ts` (add after the `claimDraftForSend` describe block, currently ending at line 192)

**Interfaces:**
- Consumes: `EmailRow` (already exported from this file).
- Produces: `updateDraftContent(supabase: SupabaseClient<Database>, id: string, patch: { subject: string; body: string }): Promise<EmailRow | null>` — used by both Server Actions in Task 4.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/emails.test.ts`, add `updateDraftContent` to the top-of-file import from `./emails` (alongside `claimDraftForSend`), then add this block immediately after the `describe('claimDraftForSend', ...)` block (after line 192):

```ts
describe('updateDraftContent', () => {
  it('should persist the subject and body and return the updated row', async () => {
    const row = { id: 'e1', status: 'draft', subject: 'New subject', body: 'New body' }
    const result = await updateDraftContent(
      mockClaimDraft({ data: [row], error: null }), 'e1', { subject: 'New subject', body: 'New body' },
    )
    expect(result).toEqual(row)
  })

  it('should return null when the row is no longer a draft', async () => {
    const result = await updateDraftContent(
      mockClaimDraft({ data: [], error: null }), 'e1', { subject: 'New subject', body: 'New body' },
    )
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateDraftContent(
        mockClaimDraft({ data: null, error: { message: 'boom' } }), 'e1', { subject: 'x', body: 'y' },
      ),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

(`mockClaimDraft` already exists in this file — it builds `.update().eq().eq().select()`, the exact same chain shape `updateDraftContent` uses, so no new mock helper is needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/emails.test.ts -t "updateDraftContent"`
Expected: FAIL — `updateDraftContent` is not exported from `./emails`.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/emails.ts`, insert after `claimDraftForSend` (after line 162, before `markEmailSent`):

```ts
// Same atomic-claim shape as claimDraftForSend: the `.eq('status','draft')`
// guard means a concurrent approval (double-click, two tabs, an approval that
// landed while this edit was in flight) makes this a no-op that returns null
// instead of silently overwriting a row that has already gone out. Used by
// both a manual Save and an AI Redesign in /inbox — one write path for both.
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
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/db/emails.test.ts -t "updateDraftContent"`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts
git commit -m "feat: add updateDraftContent to lib/db/emails"
```

---

### Task 3: `regenerateDraftContent` pipeline function

**Files:**
- Create: `src/lib/pipeline/redesign.ts`
- Test: `src/lib/pipeline/redesign.test.ts`

**Interfaces:**
- Consumes: `getEmailById`, `listThreadEmails`, `type EmailRow` (`@/lib/db/emails`); `listKnowledgeForCase`, `type KnowledgeRow` (`@/lib/db/case-knowledge`); `generateJson`, `type LlmCallContext` (`@/lib/llm/client`); `logEventSafe` (`@/lib/events/log-event`); `retrieveClientKnowledge` (`@/lib/knowledge/client-context`); `buildKnowledgeQueryText` (`@/lib/knowledge/build-query`); `draftSchema`, `type Draft` (`./draft-schema`, Task 1); `HUMAN_VOICE_INSTRUCTION` (`./email-voice`); `AppError` (`@/lib/errors/app-error`).
- Produces: `regenerateDraftContent(supabase: SupabaseClient<Database>, input: { emailId: string; instruction: string }): Promise<Draft>` (`Draft = { subject: string; body: string }`) — used by the Server Action in Task 4. Throws `AppError('VALIDATION_ERROR', …)` when the email is missing, not a draft, not outbound, or missing `case_id`/`lead_id`; propagates whatever `AppError` `generateJson` throws on an LLM failure.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pipeline/redesign.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const getEmailByIdMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const listKnowledgeMock = vi.fn()
const generateJsonMock = vi.fn()
const logEventMock = vi.fn()
const retrieveClientKnowledgeMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
}))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/knowledge/client-context', () => ({
  retrieveClientKnowledge: (...a: unknown[]) => retrieveClientKnowledgeMock(...a),
}))

import { regenerateDraftContent } from './redesign'

function draftEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
    subject: 'Old subject', body: 'Old body', status: 'draft', direction: 'outbound',
    in_reply_to_email_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  for (const m of [
    getEmailByIdMock, listThreadEmailsMock, listKnowledgeMock,
    generateJsonMock, logEventMock, retrieveClientKnowledgeMock,
  ]) m.mockReset()
  listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])
  retrieveClientKnowledgeMock.mockResolvedValue('')
  generateJsonMock.mockResolvedValue({ subject: 'New subject', body: 'New body' })
})

describe('regenerateDraftContent', () => {
  it('should throw VALIDATION_ERROR when the email is missing', async () => {
    getEmailByIdMock.mockResolvedValue(null)
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should throw VALIDATION_ERROR when the email is not a draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ status: 'sent' }))
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should throw VALIDATION_ERROR when the draft is missing case_id or lead_id', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ case_id: null }))
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should not load a thread for a first-touch draft and should return the rewrite', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    const result = await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(result).toEqual({ subject: 'New subject', body: 'New body' })
    expect(listThreadEmailsMock).not.toHaveBeenCalled()
  })

  it('should load the thread for a reply draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ in_reply_to_email_id: 'inbound1' }))
    listThreadEmailsMock.mockResolvedValue([{ direction: 'inbound', subject: 'Re: hi', body: 'thanks' }])
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'be more direct' })
    expect(listThreadEmailsMock).toHaveBeenCalledWith({}, 'lead1')
  })

  it('should log the redesign request with the instruction', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'inbox.draft_regenerated',
      payload: { emailId: 'e1', instruction: 'make it shorter' },
    }))
  })

  it('should propagate an LLM failure', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    generateJsonMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'LLM generateObject failed'))
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/pipeline/redesign.test.ts`
Expected: FAIL — `./redesign` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/redesign.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { getEmailById, listThreadEmails, type EmailRow } from '@/lib/db/emails'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
import { draftSchema, type Draft } from './draft-schema'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'

const MAX_OUTPUT_TOKENS = 1_400
const ACTOR = 'email_redesign_agent'

const SYSTEM_PROMPT = [
  'You are revising an existing B2B cold email draft per an operator instruction.',
  'Always write in English, even if the dossier, thread, or instruction below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language. One clear idea.',
  '90 words or fewer.',
  'Use ONLY facts present in the dossier/thread below. Never invent a new fact, even',
  'if the instruction implies one — if the instruction asks for something the dossier',
  'does not support, do the best you can within it and leave that part out rather',
  'than inventing it.',
  HUMAN_VOICE_INSTRUCTION,
  'If the draft is a reply within an existing thread, keep the subject prefixed with',
  '"Re: " unless the instruction explicitly asks to change it.',
  'Return the full revised subject and body — not a diff, not commentary about the change.',
].join(' ')

export interface RegenerateDraftInput {
  emailId: string
  instruction: string
}

function buildPrompt(
  email: EmailRow,
  instruction: string,
  knowledge: KnowledgeRow[],
  clientKnowledge: string,
  thread: EmailRow[] | null,
): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const threadText = thread
    ? thread.map((e) => `[${e.direction}] ${e.subject ?? ''}\n${e.body ?? ''}`).join('\n---\n')
    : ''
  return [
    `Current subject: ${email.subject ?? '(none)'}`,
    `Current body:\n${email.body ?? '(none)'}`,
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    threadText ? `Prior thread:\n${threadText}` : '',
    `Operator instruction: ${instruction}`,
    'Rewrite the subject and body following the instruction.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Rewrites a queued draft per an operator's freeform instruction, re-grounded
// in the same case dossier (and, for a reply draft, the prior thread) the
// original draft used — never a blind rewrite of just the current text. Does
// NOT write to the DB; the caller (inbox actions.ts) persists the result
// through updateDraftContent, the same write path a manual Save uses.
export async function regenerateDraftContent(
  supabase: SupabaseClient<Database>,
  input: RegenerateDraftInput,
): Promise<Draft> {
  const email = await getEmailById(supabase, input.emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not a redesignable draft', { emailId: input.emailId })
  }
  if (!email.case_id || !email.lead_id) {
    throw new AppError('VALIDATION_ERROR', 'Draft is missing required fields', { emailId: input.emailId })
  }

  const isReply = email.in_reply_to_email_id !== null
  const [knowledge, thread] = await Promise.all([
    listKnowledgeForCase(supabase, email.case_id),
    isReply ? listThreadEmails(supabase, email.lead_id) : Promise.resolve(null),
  ])

  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: email.client_id,
    queryText: buildKnowledgeQueryText({ primary: dossierText, secondary: [input.instruction] }),
  })

  const context: LlmCallContext = { clientId: email.client_id, caseId: email.case_id, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildPrompt(email, input.instruction, knowledge, clientKnowledge, thread),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  await logEventSafe({
    clientId: email.client_id,
    caseId: email.case_id,
    actor: ACTOR,
    type: 'inbox.draft_regenerated',
    payload: { emailId: input.emailId, instruction: input.instruction },
  })

  return draft
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/pipeline/redesign.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/redesign.ts src/lib/pipeline/redesign.test.ts
git commit -m "feat: add regenerateDraftContent pipeline function"
```

---

### Task 4: `updateDraftContent` and `regenerateDraftContent` Server Actions

**Files:**
- Modify: `src/lib/validation/email-limits.ts`
- Modify: `src/app/(app)/inbox/actions.ts` (add imports; insert both actions after `updateDraftAttachments`, currently ending at line 172, before the `answerKnowledgeRequest` section)
- Test: `src/app/(app)/inbox/actions.test.ts` (extend the `@/lib/db/emails` mock; add a new `@/lib/pipeline/redesign` mock; add two new `describe` blocks after `updateDraftAttachments`)

**Interfaces:**
- Consumes: `updateDraftContent` from `@/lib/db/emails` (Task 2, aliased on import to avoid colliding with this file's own export of the same name); `regenerateDraftContent` from `@/lib/pipeline/redesign` (Task 3, aliased the same way); `MAX_SUBJECT_CHARS`, `MAX_BODY_CHARS`, `MAX_INSTRUCTION_CHARS` from `@/lib/validation/email-limits`; `requireUser`, `createAdminClient`, `AppError`, `revalidatePath` (all already imported in this file).
- Produces: `updateDraftContent(formData: FormData): Promise<void>`; `regenerateDraftContent(formData: FormData): Promise<RegenerateDraftResult>` where `RegenerateDraftResult = { ok: true; subject: string; body: string } | { ok: false; code: 'VALIDATION_ERROR' | 'EXTERNAL_ERROR' | 'EXTERNAL_TIMEOUT' }` — both used by `draft-row.tsx` in Task 5.

- [ ] **Step 1: Add the instruction length constant**

In `src/lib/validation/email-limits.ts`, replace the whole file:

```ts
// Shared between sendManualEmail's Zod schema (send-actions.ts, a 'use server'
// file whose exports must all be Server Actions — these constants cannot live
// there) and compose-form.tsx's maxLength props, so the two never drift apart.
export const MAX_SUBJECT_CHARS = 200
export const MAX_BODY_CHARS = 20_000

// Shared between the inbox redesign Server Action's Zod schema and
// draft-row.tsx's instruction <Input> maxLength, for the same reason.
export const MAX_INSTRUCTION_CHARS = 500
```

- [ ] **Step 2: Write the failing tests**

In `src/app/(app)/inbox/actions.test.ts`:

1. Add two new mock functions near the top, alongside the existing ones:

```ts
const updateDraftContentRowMock = vi.fn()
const regenerateDraftContentPipelineMock = vi.fn()
```

2. Add `updateDraftContent: (...a: unknown[]) => updateDraftContentRowMock(...a)` to the existing `vi.mock('@/lib/db/emails', ...)` factory, so it reads:

```ts
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  claimDraftForSend: (...a: unknown[]) => claimDraftForSendMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  hasReplyForInbound: (...a: unknown[]) => hasReplyForInboundMock(...a),
  updateDraftContent: (...a: unknown[]) => updateDraftContentRowMock(...a),
}))
```

3. Add a new mock module, next to the other `vi.mock` calls:

```ts
vi.mock('@/lib/pipeline/redesign', () => ({
  regenerateDraftContent: (...a: unknown[]) => regenerateDraftContentPipelineMock(...a),
}))
```

4. Add both new mocks to the `beforeEach` reset array (the `for (const m of [...])` list).

5. Add `updateDraftContent, regenerateDraftContent` to the top-of-file import from `./actions`, so it reads:

```ts
import { approveDraft, answerKnowledgeRequest, updateDraftAttachments, updateDraftContent, regenerateDraftContent } from './actions'
```

6. Add these two `describe` blocks at the end of the file (after `describe('approveDraft attachments', ...)`):

```ts
describe('updateDraftContent', () => {
  it('should persist the manually edited subject and body', async () => {
    updateDraftContentRowMock.mockResolvedValue(draftEmail({ subject: 'New subject', body: 'New body' }))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', 'New subject')
    formData.set('body', 'New body')

    await updateDraftContent(formData)

    expect(updateDraftContentRowMock).toHaveBeenCalledWith(
      {}, EMAIL_ID, { subject: 'New subject', body: 'New body' },
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should reject a non-operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', 'New subject')
    formData.set('body', 'New body')

    await expect(updateDraftContent(formData)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(updateDraftContentRowMock).not.toHaveBeenCalled()
  })

  it('should reject an empty subject before touching the database', async () => {
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', '')
    formData.set('body', 'New body')

    await expect(updateDraftContent(formData)).rejects.toBeTruthy()
    expect(updateDraftContentRowMock).not.toHaveBeenCalled()
  })

  it('should throw VALIDATION_ERROR when the draft was already sent', async () => {
    updateDraftContentRowMock.mockResolvedValue(null)
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('subject', 'New subject')
    formData.set('body', 'New body')

    await expect(updateDraftContent(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})

describe('regenerateDraftContent', () => {
  it('should redesign the draft and persist the result', async () => {
    regenerateDraftContentPipelineMock.mockResolvedValue({ subject: 'AI subject', body: 'AI body' })
    updateDraftContentRowMock.mockResolvedValue(draftEmail({ subject: 'AI subject', body: 'AI body' }))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    const result = await regenerateDraftContent(formData)

    expect(regenerateDraftContentPipelineMock).toHaveBeenCalledWith(
      {}, { emailId: EMAIL_ID, instruction: 'make it shorter' },
    )
    expect(updateDraftContentRowMock).toHaveBeenCalledWith({}, EMAIL_ID, { subject: 'AI subject', body: 'AI body' })
    expect(result).toEqual({ ok: true, subject: 'AI subject', body: 'AI body' })
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should reject a non-operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    await expect(regenerateDraftContent(formData)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(regenerateDraftContentPipelineMock).not.toHaveBeenCalled()
  })

  it('should reject an empty instruction before calling the pipeline', async () => {
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', '')

    await expect(regenerateDraftContent(formData)).rejects.toBeTruthy()
    expect(regenerateDraftContentPipelineMock).not.toHaveBeenCalled()
  })

  it('should return ok:false with the error code when the LLM call fails, without throwing', async () => {
    regenerateDraftContentPipelineMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'LLM generateObject failed'))
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    const result = await regenerateDraftContent(formData)

    expect(result).toEqual({ ok: false, code: 'EXTERNAL_ERROR' })
    expect(updateDraftContentRowMock).not.toHaveBeenCalled()
  })

  it('should return ok:false when the draft was approved out from under the redesign', async () => {
    regenerateDraftContentPipelineMock.mockResolvedValue({ subject: 'AI subject', body: 'AI body' })
    updateDraftContentRowMock.mockResolvedValue(null)
    const formData = new FormData()
    formData.set('emailId', EMAIL_ID)
    formData.set('instruction', 'make it shorter')

    const result = await regenerateDraftContent(formData)

    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(revalidatePathMock).not.toHaveBeenCalled()
  })
})
```

(`AppError` is already imported at the top of this test file.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run src/app/\(app\)/inbox/actions.test.ts`
Expected: FAIL — `updateDraftContent`/`regenerateDraftContent` are not exported from `./actions`.

- [ ] **Step 4: Write the implementation**

In `src/app/(app)/inbox/actions.ts`:

1. Change the `@/lib/db/emails` import (currently lines 7-13) to alias `updateDraftContent` (it would otherwise collide with this file's own exported Server Action of the same name):

```ts
import {
  getEmailById,
  claimDraftForSend,
  markEmailSent,
  markEmailFailed,
  hasReplyForInbound,
  updateDraftContent as updateDraftContentRow,
} from '@/lib/db/emails'
```

2. Add two new imports below the existing `@/lib/resources/...` imports:

```ts
import { regenerateDraftContent as regenerateDraftContentPipeline } from '@/lib/pipeline/redesign'
import { MAX_SUBJECT_CHARS, MAX_BODY_CHARS, MAX_INSTRUCTION_CHARS } from '@/lib/validation/email-limits'
```

3. Insert both new actions after `updateDraftAttachments` (after line 172, before the `// Operator supplies the previously-missing fact.` comment that precedes `answerKnowledgeRequest`):

```ts
const updateContentSchema = z.object({
  emailId: z.string().uuid(),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_CHARS),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
})

// Persists a hand-edited (or just-redesigned) subject/body onto a draft.
export async function updateDraftContent(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can edit drafts', { userId: appUser.id })
  }
  const { emailId, subject, body } = updateContentSchema.parse({
    emailId: formData.get('emailId'),
    subject: formData.get('subject'),
    body: formData.get('body'),
  })

  const supabase = createAdminClient()
  const updated = await updateDraftContentRow(supabase, emailId, { subject, body })
  if (!updated) {
    throw new AppError('VALIDATION_ERROR', 'Draft was already sent', { emailId })
  }
  revalidatePath('/inbox')
}

const regenerateSchema = z.object({
  emailId: z.string().uuid(),
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION_CHARS),
})

export type RegenerateDraftResult =
  | { ok: true; subject: string; body: string }
  | { ok: false; code: 'VALIDATION_ERROR' | 'EXTERNAL_ERROR' | 'EXTERNAL_TIMEOUT' }

// A redesign failure (LLM error/timeout, or the draft having just been
// approved out from under the operator) is an expected, user-facing outcome
// the operator retries — not a crash — so it is returned, not thrown.
export async function regenerateDraftContent(formData: FormData): Promise<RegenerateDraftResult> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can redesign drafts', { userId: appUser.id })
  }
  const { emailId, instruction } = regenerateSchema.parse({
    emailId: formData.get('emailId'),
    instruction: formData.get('instruction'),
  })

  const supabase = createAdminClient()
  let draft: { subject: string; body: string }
  try {
    draft = await regenerateDraftContentPipeline(supabase, { emailId, instruction })
  } catch (error) {
    if (
      error instanceof AppError
      && (error.code === 'EXTERNAL_ERROR' || error.code === 'EXTERNAL_TIMEOUT' || error.code === 'VALIDATION_ERROR')
    ) {
      return { ok: false, code: error.code }
    }
    throw error
  }

  const updated = await updateDraftContentRow(supabase, emailId, draft)
  if (!updated) {
    return { ok: false, code: 'VALIDATION_ERROR' }
  }
  revalidatePath('/inbox')
  return { ok: true, subject: draft.subject, body: draft.body }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/app/\(app\)/inbox/actions.test.ts`
Expected: PASS (all existing tests plus the new ones)

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/validation/email-limits.ts "src/app/(app)/inbox/actions.ts" "src/app/(app)/inbox/actions.test.ts"
git commit -m "feat: add updateDraftContent and regenerateDraftContent server actions"
```

---

### Task 5: `draft-row.tsx` — edit mode, redesign box, and manual write

**Files:**
- Modify: `src/app/(app)/inbox/draft-row.tsx` (full rewrite of the component body — no other file changes needed, `page.tsx` already passes every prop this component needs)

**Interfaces:**
- Consumes: `updateDraftContent`, `regenerateDraftContent`, `type RegenerateDraftResult` (Task 4, from `./actions`); `MAX_SUBJECT_CHARS`, `MAX_BODY_CHARS`, `MAX_INSTRUCTION_CHARS` (`@/lib/validation/email-limits`); `Input` (`@/components/ui/input`), `Textarea` (`@/components/ui/textarea`), `Label` (`@/components/ui/label`) — all already used by `compose-form.tsx`; `PencilSimple`, `MagicWand` icons (`@phosphor-icons/react`, both confirmed present alongside the icons already imported in this file).
- Produces: no change to `DraftRowProps` or the exported `DraftAttachment` type — `page.tsx` needs no changes.

- [ ] **Step 1: Replace the component**

Replace the full contents of `src/app/(app)/inbox/draft-row.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { CheckCircle, MagicWand, Paperclip, PaperPlaneTilt, PencilSimple } from '@phosphor-icons/react'
import { approveDraft, regenerateDraftContent, updateDraftAttachments, updateDraftContent } from './actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { CompanyMark } from '@/components/company-mark'
import { ResourcePicker } from '@/components/resource-picker'
import type { ResourceSummary } from '@/components/resource-list'
import { formatBytes } from '@/lib/format/bytes'
import { MAX_SUBJECT_CHARS, MAX_BODY_CHARS, MAX_INSTRUCTION_CHARS } from '@/lib/validation/email-limits'

export interface DraftAttachment {
  resourceId: string
  title: string
  byteSize: number
}

interface DraftRowProps {
  emailId: string
  caseId: string | null
  subject: string
  body: string
  companyName: string
  /** Preformatted on the server so no clock runs during hydration. */
  age: string
  /** What the agent chose, as recorded in email_attachments. */
  attachments: readonly DraftAttachment[]
  /** This client's sendable library, for the "Add from library" editor. */
  resources: readonly ResourceSummary[]
}

function messageForRegenerateCode(code: 'VALIDATION_ERROR' | 'EXTERNAL_ERROR' | 'EXTERNAL_TIMEOUT'): string {
  if (code === 'VALIDATION_ERROR') return 'This draft was already sent, so it can no longer be redesigned.'
  return 'Could not redesign that draft. Try again.'
}

export function DraftRow({
  emailId,
  caseId,
  subject,
  body,
  companyName,
  age,
  attachments,
  resources,
}: DraftRowProps): React.ReactElement {
  const [isPending, startTransition] = useTransition()
  const [isSent, setIsSent] = useState(false)
  const [isEditingAttachments, setIsEditingAttachments] = useState(false)
  const [isSavingAttachments, startAttachmentTransition] = useTransition()
  const [isEditingContent, setIsEditingContent] = useState(false)
  const [draftSubject, setDraftSubject] = useState(subject)
  const [draftBody, setDraftBody] = useState(body)
  const [instruction, setInstruction] = useState('')
  const [isSavingContent, startContentTransition] = useTransition()
  const [isRedesigning, startRedesignTransition] = useTransition()
  const [redesignError, setRedesignError] = useState<string | null>(null)
  const reduceMotion = useReducedMotion()

  const onSaveAttachments = (formData: FormData): void => {
    startAttachmentTransition(async () => {
      try {
        await updateDraftAttachments(formData)
        setIsEditingAttachments(false)
        toast.success('Attachments updated')
      } catch (error) {
        toast.error('Could not update the attachments', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
      }
    })
  }

  const onOpenEditor = (): void => {
    setDraftSubject(subject)
    setDraftBody(body)
    setInstruction('')
    setRedesignError(null)
    setIsEditingContent(true)
  }

  const onCancelEdit = (): void => {
    setIsEditingContent(false)
    setRedesignError(null)
  }

  const onClear = (): void => {
    setDraftSubject('')
    setDraftBody('')
  }

  const onSaveContent = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    formData.set('subject', draftSubject)
    formData.set('body', draftBody)
    startContentTransition(async () => {
      try {
        await updateDraftContent(formData)
        setIsEditingContent(false)
        toast.success('Draft updated')
      } catch (error) {
        toast.error('Could not save that change', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
      }
    })
  }

  const onRedesign = (): void => {
    setRedesignError(null)
    const formData = new FormData()
    formData.set('emailId', emailId)
    formData.set('instruction', instruction)
    startRedesignTransition(async () => {
      const result = await regenerateDraftContent(formData)
      if (!result.ok) {
        setRedesignError(messageForRegenerateCode(result.code))
        return
      }
      setDraftSubject(result.subject)
      setDraftBody(result.body)
    })
  }

  const onApprove = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    startTransition(async () => {
      try {
        await approveDraft(formData)
        setIsSent(true)
        toast.success('Email sent', { description: `To ${companyName}` })
      } catch (error) {
        // The Server Action already logged the cause; the operator needs to
        // know the send did not happen and the draft is still theirs to retry.
        toast.error('Could not send', {
          description: error instanceof Error ? error.message : 'Please try again.',
        })
      }
    })
  }

  return (
    <article className="border-hairline bg-surface rounded-lg border">
      <header className="border-hairline flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <CompanyMark name={companyName} />
        <div className="min-w-0 flex-1">
          {caseId ? (
            <Link
              href={`/cases/${caseId}`}
              className="hover:text-primary block truncate text-[13px] font-medium transition-colors duration-200"
            >
              {companyName}
            </Link>
          ) : (
            <p className="truncate text-[13px] font-medium">{companyName}</p>
          )}
          <p className="text-faint truncate text-[11px]">{age}</p>
        </div>
      </header>

      <div className="px-4 py-4">
        {isEditingContent ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`draft-subject-${emailId}`}>Subject</Label>
              <Input
                id={`draft-subject-${emailId}`}
                value={draftSubject}
                onChange={(event) => setDraftSubject(event.target.value)}
                maxLength={MAX_SUBJECT_CHARS}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`draft-body-${emailId}`}>Body</Label>
              <Textarea
                id={`draft-body-${emailId}`}
                value={draftBody}
                onChange={(event) => setDraftBody(event.target.value)}
                rows={8}
                maxLength={MAX_BODY_CHARS}
              />
            </div>

            <div className="border-hairline flex flex-col gap-2 rounded-md border border-dashed p-3">
              <Label htmlFor={`draft-instruction-${emailId}`}>Redesign with AI</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`draft-instruction-${emailId}`}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder="e.g. make it shorter, lead with the pricing angle"
                  maxLength={MAX_INSTRUCTION_CHARS}
                  className="min-w-56 flex-1"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={isRedesigning || instruction.trim().length === 0}
                  onClick={onRedesign}
                >
                  <MagicWand size={13} weight="light" />
                  {isRedesigning ? 'Redesigning…' : 'Redesign'}
                </Button>
              </div>
              {redesignError ? (
                <p role="alert" className="text-destructive text-[12px]">
                  {redesignError}
                </p>
              ) : null}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={isSavingContent || draftSubject.trim().length === 0 || draftBody.trim().length === 0}
                onClick={onSaveContent}
              >
                {isSavingContent ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={isSavingContent} onClick={onClear}>
                Clear
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={isSavingContent} onClick={onCancelEdit}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-[13px] font-medium">{subject}</p>
            <p className="text-muted-foreground mt-2.5 max-w-[75ch] text-sm leading-relaxed whitespace-pre-wrap">
              {body}
            </p>
          </>
        )}

        {isSent ? null : (
          <div className="mt-4 flex flex-col gap-2">
            {!isEditingContent ? (
              <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onOpenEditor}>
                <PencilSimple size={14} weight="light" />
                Edit
              </Button>
            ) : null}

            {attachments.length > 0 ? (
              <ul className="flex flex-wrap gap-2">
                {attachments.map((attachment) => (
                  <li
                    key={attachment.resourceId}
                    className="border-hairline text-muted-foreground flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
                  >
                    <Paperclip size={12} weight="light" />
                    <span className="max-w-[28ch] truncate">{attachment.title}</span>
                    <span className="text-faint tnum">{formatBytes(attachment.byteSize)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-faint text-[11px]">No files attached.</p>
            )}

            {/* Its own form, so editing attachments can never submit the send.
                Offered whenever there is something to add OR something already
                attached: a draft can outlive the resource it carries, and
                hiding the editor on an empty library would leave that stale
                attachment permanently stuck to an email that cannot send. */}
            {resources.length > 0 || attachments.length > 0 ? (
              isEditingAttachments ? (
                <form action={onSaveAttachments} className="flex flex-col gap-2">
                  <input type="hidden" name="emailId" value={emailId} />
                  <ResourcePicker
                    resources={resources}
                    name="resourceIds"
                    defaultSelectedIds={attachments.map((attachment) => attachment.resourceId)}
                  />
                  <div className="flex items-center gap-2">
                    <Button type="submit" variant="secondary" size="sm" disabled={isSavingAttachments}>
                      {isSavingAttachments ? 'Saving…' : 'Save attachments'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={isSavingAttachments}
                      onClick={() => setIsEditingAttachments(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="self-start"
                  onClick={() => setIsEditingAttachments(true)}
                >
                  <Paperclip size={14} weight="light" />
                  {attachments.length > 0 ? 'Edit attachments' : 'Add from library'}
                </Button>
              )
            ) : null}
          </div>
        )}
      </div>

      <footer className="border-hairline flex flex-wrap items-center gap-3 border-t px-4 py-3">
        <AnimatePresence mode="wait" initial={false}>
          {isSent ? (
            <motion.span
              key="sent"
              role="status"
              className="inline-flex items-center gap-1.5 text-xs font-medium"
              style={{ color: 'var(--status-won)' }}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <CheckCircle size={14} weight="fill" />
              Sent
            </motion.span>
          ) : (
            <motion.div
              key="actions"
              className="flex flex-wrap items-center gap-3"
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              <Button type="button" size="sm" onClick={onApprove} disabled={isPending || isEditingContent}>
                <PaperPlaneTilt size={14} weight="fill" />
                {isPending ? 'Sending…' : 'Approve and send'}
              </Button>
              <p className="text-faint text-[11px]">
                {isEditingContent
                  ? 'Save or cancel your edit before approving.'
                  : 'Goes out from the campaign mailbox immediately.'}
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </article>
  )
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Run the full test suite**

Run: `pnpm test`
Expected: all tests across the project pass. (This codebase has no `.test.tsx` component tests anywhere — `vitest.config.ts` only includes `src/**/*.test.ts` and runs in a `node` environment with no DOM/testing-library setup — so `draft-row.tsx` is verified manually below, matching how every other component in `/inbox` and `/settings` is already covered: the Server Actions underneath, which hold all the actual logic, are fully covered by Task 4's and Task 2/3's tests.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/inbox/draft-row.tsx"
git commit -m "feat: add redesign box and manual editing to inbox drafts"
```

- [ ] **Step 5: Manual verification**

1. Run `pnpm dev`, sign in as an operator, and get at least one draft into `/inbox` → "Drafts awaiting approval" (either put a client on `human_approve` reply mode and let a case get written to, or insert a `status: 'draft', direction: 'outbound'` row by hand).
2. Open the draft, click **Edit** — confirm the read-only text is replaced by editable Subject/Body fields pre-filled with the current draft, plus the "Redesign with AI" box.
3. Type an instruction (e.g. "make it shorter and mention the free trial") and click **Redesign** — confirm the Subject/Body fields update to a new AI-written version, and that it does not contradict or invent facts beyond what the case's dossier/knowledge already contains.
4. Hand-edit the regenerated text further, then click **Save** — confirm the form closes, a success toast appears, and the card now shows your saved text.
5. Click **Edit** again, then **Clear** — confirm both fields empty out — type a fully custom subject/body, **Save**, and confirm it persists.
6. Click **Edit** once more and, while the form is open, confirm **Approve and send** is disabled and the footer note reads "Save or cancel your edit before approving."
7. **Cancel** out of an edit and click **Approve and send** — confirm it sends the last-saved content and the card transitions to "Sent."
8. In another tab (or via direct DB edit), approve a draft while its edit form is open in the first tab; click **Save** in the first tab and confirm you see the "Draft was already sent" toast rather than a silent overwrite.

---

## Task Order

Tasks 1 → 2 → 3 → 4 → 5, strictly sequential:

- Task 2 does not depend on Task 1, but Task 3 depends on Task 1's `draft-schema.ts`.
- Task 4 depends on Task 2's `updateDraftContent` (DB) and Task 3's `regenerateDraftContent` (pipeline).
- Task 5 depends on Task 4's two Server Actions and the `MAX_INSTRUCTION_CHARS` constant it introduces.
