# Uniforms Fashion Formal-Intro Email Style Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-client `email_style` setting (`concise` default / `formal_intro`) so Uniforms Fashion's first-touch cold emails can follow a formal introduction structure (greeting, self-intro, capabilities, personalized hook, qualifying-question CTA) instead of the pipeline's default dossier-led style, without touching any other client's emails.

**Architecture:** New `clients.email_style` enum column (default `'concise'`, zero behavior change on migration). `write.ts` gains a second system prompt (`FORMAL_INTRO_SYSTEM_PROMPT`) and a `selectSystemPrompt(emailStyle)` helper that `processLead` calls instead of using a single hardcoded prompt. An operator-only toggle on `/clients/[id]` (same `PATCH /api/clients/[clientId]` pattern as the existing warmup/domain/signature controls) lets an operator flip it per client. `followup.ts` and `redesign.ts` are untouched — this only affects the first-touch email.

**Tech Stack:** Next.js 15 / TypeScript strict / Supabase (Postgres) / Zod / Vitest.

**Spec:** `docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md`

## Global Constraints

- TypeScript `strict: true`, no `any`; Zod validates all external input (API route bodies).
- No i18n in operator-only pages/components — per `CLAUDE.md`: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES, TRANSLATE ONLY IN CLIENT FACING PLACES." `/clients/[id]` 404s for non-operators, so the new `EmailStyleSelect` component uses plain English strings, not `useTranslations`.
- Named exports only (no default exports outside Next.js pages/layouts/components); no barrel files; no `console.log`.
- All Supabase reads/writes for `clients` live in `src/lib/db/clients.ts` — never inline queries elsewhere.
- Every `{ data, error }` from Supabase is destructured and both branches handled; DB errors are mapped to `AppError` with `code`/`message`/`context`, never a bare `Error`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` must all stay clean after every task.
- Use `pnpm`, never `npm` (this repo is pnpm-only — `npm install` corrupts the tree).
- Migration default (`'concise'`) must not change behavior for any existing client, including Uniforms Fashion's 8 already-live campaigns, until an operator explicitly flips the toggle.
- Scope is first-touch generation (`write.ts`) only — do not touch `followup.ts` or `redesign.ts` voice.
- Commit directly to `master` (no feature branch — "dont branch use main" per `CLAUDE.md`); commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Update `.claude/roadmap.md` with a dated entry describing what shipped (`CLAUDE.md`: "UPDATE THE .claude/roadmap.md EVERY TIME YOU MAKE PROGRESS").

---

### Task 1: Database schema — `email_style` column

**Files:**
- Create: `supabase/migrations/0034_client_email_style.sql`
- Modify: `src/types/database.ts:12-57` (the `clients` table's `Row`/`Insert`), `src/types/database.ts:1073` (the `Enums` block)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Database['public']['Enums']['email_style']` = `'concise' | 'formal_intro'`, and `clients.email_style: Database['public']['Enums']['email_style']` on `ClientRow`/`ClientInsert`. Every later task reads/writes this exact path.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0034_client_email_style.sql
-- Per-client first-touch email voice. 'concise' (default) is today's
-- existing dossier-led, low-friction style — every current client keeps it
-- unchanged. 'formal_intro' is a structured self-introduction voice, opt-in
-- per client via the /clients/[id] toggle. See
-- docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md

create type email_style as enum ('concise', 'formal_intro');
alter table clients add column email_style email_style not null default 'concise';
```

- [ ] **Step 2: Update `src/types/database.ts` — `clients` table**

In the `clients.Row` block, add one line right after `reply_mode`:

```ts
          reply_mode: Database['public']['Enums']['reply_mode']
          email_style: Database['public']['Enums']['email_style']
```

In the `clients.Insert` block, add the matching optional line right after `reply_mode?`:

```ts
          reply_mode?: Database['public']['Enums']['reply_mode']
          email_style?: Database['public']['Enums']['email_style']
```

(`Update` stays `Partial<Database['public']['Tables']['clients']['Insert']>` — no change needed there.)

- [ ] **Step 3: Update `src/types/database.ts` — `Enums` block**

Add one line right after the existing `reply_mode` entry (currently line 1073):

```ts
      reply_mode: 'auto_send' | 'human_approve' | 'hybrid'
      email_style: 'concise' | 'formal_intro'
```

- [ ] **Step 4: Verify the types compile**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0034_client_email_style.sql src/types/database.ts
git commit -m "feat(db): add clients.email_style enum column (concise default)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `write.ts` — formal-intro system prompt + `selectSystemPrompt`

**Files:**
- Modify: `src/lib/pipeline/write.ts:46-77` (system prompt + `buildPrompt`), `src/lib/pipeline/write.ts:96-108` (`processLead`'s `generateJson` call)
- Test: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `Database['public']['Enums']['email_style']` (Task 1), `HUMAN_VOICE_INSTRUCTION` from `./email-voice` (already imported), `ClientRow` from `@/lib/db/clients` (already imported).
- Produces: `export type EmailStyle = Database['public']['Enums']['email_style']`, `export const CONCISE_SYSTEM_PROMPT: string` (renamed from today's `SYSTEM_PROMPT`), `export const FORMAL_INTRO_SYSTEM_PROMPT: string`, `export function selectSystemPrompt(emailStyle: EmailStyle | null | undefined): string`, and `buildPrompt`'s new 5th parameter `client: ClientRow | null`. Task 5 (the regeneration script) consumes all of these by exact name.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pipeline/write.test.ts`, change the import line to also pull the two new exports:

```ts
import { runWriteForCase, CONCISE_SYSTEM_PROMPT, FORMAL_INTRO_SYSTEM_PROMPT } from './write'
```

Add these two tests inside the existing `describe('runWriteForCase', ...)` block (after the last `it(...)`):

```ts
  it('should use the formal-intro system prompt when the client email_style is formal_intro', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Uniforms Fashion', domain: null, phone: null,
      address: null, signature_name: 'Cihat Bozkurt', signature_title: null, email_style: 'formal_intro',
    })

    await runWriteForCase({} as never, input)

    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: FORMAL_INTRO_SYSTEM_PROMPT }),
    )
  })

  it('should default to the concise system prompt when email_style is unset', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: CONCISE_SYSTEM_PROMPT }),
    )
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/pipeline/write.test.ts`
Expected: FAIL — `CONCISE_SYSTEM_PROMPT`/`FORMAL_INTRO_SYSTEM_PROMPT` are not exported from `./write` yet (module has no such member), so the whole file fails to run.

- [ ] **Step 3: Replace the system prompt section in `write.ts`**

Replace lines 46-63 (the current `export const SYSTEM_PROMPT = [...]`) with:

```ts
export type EmailStyle = Database['public']['Enums']['email_style']

// Shared between both system prompts below so subject-line formatting can
// never drift between styles.
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]

// Default voice — dossier-led, low-friction, no greeting. Used for every
// client unless email_style is explicitly set to 'formal_intro'.
export const CONCISE_SYSTEM_PROMPT = [
  'You write short, human-sounding B2B cold emails.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'One clear idea. 90 words or fewer.',
  'Use only facts present in the provided dossier. Never invent specifics.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
  'Lead with the specific dossier fact, not a greeting.',
  'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"),',
  'not the booking link. Only offer the booking link if it is clearly the natural next step —',
  'it is an optional extra, never the default ask.',
].join(' ')

// Formal introduction voice — a per-client opt-in (clients.email_style =
// 'formal_intro'), currently used only by Uniforms Fashion. See
// docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md
export const FORMAL_INTRO_SYSTEM_PROMPT = [
  'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any specific you were not given.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
  'Structure the body as exactly five short paragraphs, in this order:',
  '1. Greeting: "Dear [Recipient first name]," using the recipient\'s first name from the Recipient',
  'line below; if no name is given, use "Dear," alone.',
  '2. Self-introduction: one sentence giving the sender name and company name exactly as given in',
  '"Sender name" / "Our company name" below, plus the company\'s home base and years of experience —',
  'only the ones you have evidence for in "About our company"; drop whichever you don\'t have',
  'rather than guessing.',
  '3. Capabilities: one sentence on what the company manufactures or does, grounded in the value',
  'proposition and "About our company" below.',
  '4. Hook: one sentence connecting to this specific recipient — cite a real fact about their',
  'company or industry from the dossier. Never use a generic line like "I came across your',
  'company" or "I wanted to introduce ourselves" — the hook must trace to a dossier fact.',
  '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the',
  'kind of procurement or project relevant to their industry, followed by an offer to send the',
  'company profile, references, and product capabilities if so. Only mention the booking link',
  'here if it is clearly the natural next step; otherwise the offer to send materials is the',
  'entire ask.',
  'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any',
  'sign-off — a signature block is appended separately in code.',
  '120 words or fewer, including the greeting.',
].join(' ')

// Picks the system prompt for a client's configured voice. Falls back to
// CONCISE_SYSTEM_PROMPT for null/undefined so a missing client row never
// blocks first-touch generation.
export function selectSystemPrompt(emailStyle: EmailStyle | null | undefined): string {
  return emailStyle === 'formal_intro' ? FORMAL_INTRO_SYSTEM_PROMPT : CONCISE_SYSTEM_PROMPT
}
```

- [ ] **Step 4: Update `buildPrompt` to accept the client row**

Replace the existing `buildPrompt` function (lines 65-77) with:

```ts
export function buildPrompt(
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  clientKnowledge: string,
  client: ClientRow | null,
): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
    client?.name ? `Our company name: ${client.name}` : '',
    client?.signature_name ? `Sender name: ${client.signature_name}` : '',
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
    input.bookingLink ? `Booking link (optional CTA): ${input.bookingLink}` : '',
    `Dossier:\n${dossier}`,
    'Write the first-touch email. Return a subject and a body.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
```

- [ ] **Step 5: Wire the new prompt selection and `client` argument into `processLead`**

In `processLead`, replace:

```ts
  const draft = await generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge),
```

with:

```ts
  const draft = await generateJson(context, {
    instructions: selectSystemPrompt(client?.email_style),
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

(the rest of that `generateJson` call — `schema`, `maxOutputTokens`, `thinkingLevel`, and the comment above it — is unchanged.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/lib/pipeline/write.test.ts`
Expected: PASS — all 10 tests (8 existing + 2 new) green.

- [ ] **Step 7: Type-check and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "feat(write): add formal_intro email style alongside the concise default

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `updateClientEmailStyle` + PATCH route

**Files:**
- Modify: `src/lib/db/clients.ts` (add function after `updateClientWarmupProfile`, ~line 149)
- Modify: `src/app/api/clients/[clientId]/route.ts`
- Test: `src/app/api/clients/[clientId]/route.test.ts`

**Interfaces:**
- Consumes: `ClientRow`, `AppError` (both already imported in `clients.ts`); `Database['public']['Enums']['email_style']` (Task 1).
- Produces: `export async function updateClientEmailStyle(supabase: SupabaseClient<Database>, id: string, style: Database['public']['Enums']['email_style']): Promise<ClientRow>`, and `PATCH /api/clients/[clientId]` accepting `{ emailStyle: 'concise' | 'formal_intro' }` in its JSON body. Task 4 (the UI toggle) calls this route by exact shape.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/clients/[clientId]/route.test.ts`, add `updateClientEmailStyleMock` alongside the other mocks:

```ts
const updateClientEmailStyleMock = vi.fn()
```

Add it to the `vi.mock('@/lib/db/clients', ...)` factory:

```ts
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientName: (...a: unknown[]) => updateClientNameMock(...a),
  updateClientDomain: (...a: unknown[]) => updateClientDomainMock(...a),
  updateClientSignature: (...a: unknown[]) => updateClientSignatureMock(...a),
  updateClientEmailStyle: (...a: unknown[]) => updateClientEmailStyleMock(...a),
  deleteClientCascade: (...a: unknown[]) => deleteClientCascadeMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
```

Add `updateClientEmailStyleMock.mockReset()` to the `beforeEach` block's reset list.

Add these two tests inside `describe('PATCH /api/clients/[clientId]', ...)`, after the existing `'should return 400 for an invalid phone'` test:

```ts
  it('should save the email style and log the event on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style: 'concise' })
    updateClientEmailStyleMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style: 'formal_intro' })
    const res = await PATCH(req({ emailStyle: 'formal_intro' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.email_style).toBe('formal_intro')
    expect(updateClientEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'formal_intro')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.email_style_changed' }))
  })

  it('should return 400 for an invalid email style', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style: 'concise' })
    const res = await PATCH(req({ emailStyle: 'shouty' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientEmailStyleMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test 'src/app/api/clients/[clientId]/route.test.ts'`
Expected: FAIL — `updateClientEmailStyleMock` is referenced but the route doesn't call it yet / `emailStyle` isn't a recognized field (the two new tests fail: 200 expected but validation rejects unknown field isn't the failure mode here since `patchSchema` doesn't yet know `emailStyle`, so the "save" test gets a 400 instead of 200, and `updateClientEmailStyleMock` is never called).

- [ ] **Step 3: Add `updateClientEmailStyle` to `src/lib/db/clients.ts`**

Insert right after the existing `updateClientWarmupProfile` function (after its closing `}`, before `updateClientMailreachEnabled`):

```ts
// The client-level first-touch email voice. See selectSystemPrompt in
// write.ts for how this is consumed.
export async function updateClientEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
  style: Database['public']['Enums']['email_style'],
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ email_style: style })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client email style', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Wire it into the PATCH route**

In `src/app/api/clients/[clientId]/route.ts`, add `updateClientEmailStyle` to the import from `@/lib/db/clients`:

```ts
import {
  getClientById,
  updateClientName,
  updateClientWarmupProfile,
  updateClientDomain,
  updateClientSignature,
  updateClientEmailStyle,
  deleteClientCascade,
  listClientRoleAppUsers,
} from '@/lib/db/clients'
```

Add `emailStyle` to `patchSchema` and its `.refine` check:

```ts
const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    warmupProfile: z.enum(['standard', 'slow', 'none']).optional(),
    domain: domainSchema.optional(),
    phone: phoneSchema.optional(),
    address: nullableTextSchema(200).optional(),
    signatureName: nullableTextSchema(120).optional(),
    signatureTitle: nullableTextSchema(120).optional(),
    emailStyle: z.enum(['concise', 'formal_intro']).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.warmupProfile !== undefined ||
      body.domain !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined ||
      body.emailStyle !== undefined,
    { message: 'At least one field must be provided' },
  )
```

Add a new handling block in `PATCH`, after the existing `phone`/`address`/`signatureName`/`signatureTitle` block and before `return NextResponse.json({ ok: true, client: updated })`:

```ts
    if (body.emailStyle !== undefined) {
      updated = await updateClientEmailStyle(admin, clientId, body.emailStyle)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.email_style_changed',
          payload: { from: client.email_style, to: body.emailStyle },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test 'src/app/api/clients/[clientId]/route.test.ts'`
Expected: PASS — all tests green (existing + 2 new).

- [ ] **Step 6: Type-check and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/clients.ts "src/app/api/clients/[clientId]/route.ts" "src/app/api/clients/[clientId]/route.test.ts"
git commit -m "feat(clients): add PATCH support for emailStyle

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Operator UI toggle

**Files:**
- Create: `src/app/(app)/clients/[id]/email-style-select.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `PATCH /api/clients/[clientId]` with `{ emailStyle }` (Task 3), `Database['public']['Enums']['email_style']` (Task 1), `client.email_style` (available on the `ClientRow` already fetched in `page.tsx`).
- Produces: `export function EmailStyleSelect({ clientId, value }: { clientId: string; value: Database['public']['Enums']['email_style'] }): React.ReactElement`. No downstream task consumes this — it's the terminal UI piece.

There is no automated test for this component — no sibling `*-select.tsx` on this page has one either (`WarmupProfileSelect`, `DefaultLocaleSelect` are both untested), so this task is verified by type-check + lint + a manual read-through, consistent with existing coverage on this page.

- [ ] **Step 1: Create `email-style-select.tsx`**

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Database } from '@/types/database'

type EmailStyleValue = Database['public']['Enums']['email_style']

const EMAIL_STYLES: readonly EmailStyleValue[] = ['concise', 'formal_intro']

const LABELS: Record<EmailStyleValue, string> = {
  concise: 'Concise (default)',
  formal_intro: 'Formal introduction',
}

interface EmailStyleSelectProps {
  clientId: string
  value: EmailStyleValue
}

// Operator-only control — plain English strings, no useTranslations. Per
// CLAUDE.md: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES,
// TRANSLATE ONLY IN CLIENT FACING PLACES" — this page 404s for non-operators
// (see page.tsx's `if (appUser.role !== 'operator') notFound()`).
export function EmailStyleSelect({ clientId, value }: EmailStyleSelectProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(style: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailStyle: style }),
    })
    if (!response.ok) {
      setError('Failed to save email style.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`email-style-${clientId}`} className="text-faint text-[11px]">
        First-touch email style
      </label>
      <select
        id={`email-style-${clientId}`}
        value={value}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {EMAIL_STYLES.map((style) => (
          <option key={style} value={style}>
            {LABELS[style]}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into `page.tsx`**

Add the import alongside the other client-detail imports:

```ts
import { EmailStyleSelect } from './email-style-select'
```

In the header actions row, add it after `<DefaultLocaleSelect ... />`:

```tsx
            <ClientLifecycleActions clientId={client.id} status={client.status} />
            <WarmupProfileSelect clientId={client.id} value={client.warmup_profile} />
            <MailreachToggle clientId={client.id} enabled={client.mailreach_enabled} />
            <DefaultLocaleSelect clientId={client.id} value={client.default_locale} />
            <EmailStyleSelect clientId={client.id} value={client.email_style} />
```

- [ ] **Step 3: Type-check and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/clients/[id]/email-style-select.tsx" "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat(clients): add operator toggle for first-touch email style

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Update `scripts/regenerate-sample-emails.ts`

**Files:**
- Modify: `scripts/regenerate-sample-emails.ts`

**Interfaces:**
- Consumes: `selectSystemPrompt`, `buildPrompt` (both from Task 2, `src/lib/pipeline/write.ts`), `getClientById` (from `src/lib/db/clients.ts`, already exists).
- Produces: nothing consumed by other tasks — this is a standalone CLI tool. No automated test exists for it (confirmed: no `regenerate-sample-emails.test.ts` in the repo), so this task is verified by type-check only, consistent with its existing lack of test coverage.

- [ ] **Step 1: Update the `AppDeps` interface**

Replace the `SYSTEM_PROMPT: string` line with `selectSystemPrompt`, and add `getClientById`:

```ts
interface AppDeps {
  generateJson: typeof import('../src/lib/llm/client').generateJson
  draftSchema: typeof import('../src/lib/pipeline/draft-schema').draftSchema
  selectSystemPrompt: typeof import('../src/lib/pipeline/write').selectSystemPrompt
  MAX_OUTPUT_TOKENS: number
  buildPrompt: typeof import('../src/lib/pipeline/write').buildPrompt
  listKnowledgeForCase: typeof import('../src/lib/db/case-knowledge').listKnowledgeForCase
  getLeadById: typeof import('../src/lib/db/leads').getLeadById
  getCaseById: typeof import('../src/lib/db/cases').getCaseById
  getCampaignForCase: typeof import('../src/lib/db/campaigns').getCampaignForCase
  getClientById: typeof import('../src/lib/db/clients').getClientById
  retrieveClientKnowledge: typeof import('../src/lib/knowledge/client-context').retrieveClientKnowledge
  buildKnowledgeQueryText: typeof import('../src/lib/knowledge/build-query').buildKnowledgeQueryText
}
```

- [ ] **Step 2: Update `loadAppDeps`**

```ts
async function loadAppDeps(): Promise<AppDeps> {
  const [writeMod, llmMod, schemaMod, caseKnowledgeMod, leadsMod, casesMod, campaignsMod, clientsMod, clientContextMod, buildQueryMod] =
    await Promise.all([
      import('../src/lib/pipeline/write'),
      import('../src/lib/llm/client'),
      import('../src/lib/pipeline/draft-schema'),
      import('../src/lib/db/case-knowledge'),
      import('../src/lib/db/leads'),
      import('../src/lib/db/cases'),
      import('../src/lib/db/campaigns'),
      import('../src/lib/db/clients'),
      import('../src/lib/knowledge/client-context'),
      import('../src/lib/knowledge/build-query'),
    ])
  return {
    generateJson: llmMod.generateJson,
    draftSchema: schemaMod.draftSchema,
    selectSystemPrompt: writeMod.selectSystemPrompt,
    MAX_OUTPUT_TOKENS: writeMod.MAX_OUTPUT_TOKENS,
    buildPrompt: writeMod.buildPrompt,
    listKnowledgeForCase: caseKnowledgeMod.listKnowledgeForCase,
    getLeadById: leadsMod.getLeadById,
    getCaseById: casesMod.getCaseById,
    getCampaignForCase: campaignsMod.getCampaignForCase,
    getClientById: clientsMod.getClientById,
    retrieveClientKnowledge: clientContextMod.retrieveClientKnowledge,
    buildKnowledgeQueryText: buildQueryMod.buildKnowledgeQueryText,
  }
}
```

- [ ] **Step 3: Fetch the client and use it in `regenerateOne`**

Replace the function body:

```ts
async function regenerateOne(
  supabase: SupabaseClient<Database>,
  deps: AppDeps,
  sample: SampleEmail,
): Promise<RegeneratedPair | null> {
  const [kase, lead, campaign, knowledge, client] = await Promise.all([
    deps.getCaseById(supabase, sample.caseId),
    deps.getLeadById(supabase, sample.leadId),
    deps.getCampaignForCase(supabase, sample.caseId),
    deps.listKnowledgeForCase(supabase, sample.caseId),
    deps.getClientById(supabase, sample.clientId),
  ])
  if (!kase || !lead || !campaign) return null

  const input: RunWriteInput = {
    clientId: sample.clientId,
    campaignId: campaign.id,
    caseId: sample.caseId,
    replyMode: campaign.reply_mode,
    valueProp: campaign.value_prop,
    bookingLink: campaign.booking_link,
    mailboxIds: campaign.mailbox_ids,
    companyName: kase.company_name,
  }

  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await deps.retrieveClientKnowledge(supabase, {
    clientId: sample.clientId,
    queryText: deps.buildKnowledgeQueryText({ primary: dossierText, secondary: [input.valueProp ?? ''] }),
  })

  const draft = await deps.generateJson(
    { clientId: sample.clientId, caseId: sample.caseId, actor: ACTOR },
    {
      instructions: deps.selectSystemPrompt(client?.email_style),
      prompt: deps.buildPrompt(input, lead, knowledge, clientKnowledge, client),
      schema: deps.draftSchema,
      maxOutputTokens: deps.MAX_OUTPUT_TOKENS,
      thinkingLevel: 'minimal',
    },
  )

  return { original: sample, regenerated: draft }
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/regenerate-sample-emails.ts
git commit -m "chore(scripts): make regenerate-sample-emails style-aware

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Final verification + roadmap entry

**Files:**
- Modify: `.claude/roadmap.md` (append a new dated entry at the end of the file)

**Interfaces:**
- Consumes: nothing new — this is the integration/wrap-up task.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Run the full suite**

Run: `pnpm test`
Expected: PASS, every file green (no regressions in `followup.test.ts`, `redesign.test.ts`, or anywhere else — neither was touched).

- [ ] **Step 2: Full type-check and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: both clean.

- [ ] **Step 3: Append a roadmap entry**

Add this section at the very end of `.claude/roadmap.md`:

```markdown
## 2026-08-08 — Per-client formal-intro email style for Uniforms Fashion

Added `clients.email_style` (`'concise'` default / `'formal_intro'`,
migration `0034_client_email_style.sql`). `write.ts` now has two system
prompts — `CONCISE_SYSTEM_PROMPT` (today's dossier-led, low-friction
voice, renamed from `SYSTEM_PROMPT`) and `FORMAL_INTRO_SYSTEM_PROMPT` (a
five-beat structured self-introduction: greeting, sender/company
self-intro, capabilities, a dossier-grounded personalized hook in place of
a generic "I came across your company" line, then a qualifying-question +
send-materials CTA) — selected per client via `selectSystemPrompt`.
`buildPrompt` gained a `client` parameter so the model has the sender's
real name/company to introduce, never invented. Scoped to first-touch only
(`followup.ts`/`redesign.ts` untouched) and to Uniforms Fashion only via a
new operator toggle on `/clients/[id]` (`EmailStyleSelect`,
`PATCH /api/clients/[clientId]` with `{ emailStyle }`) — every other
client keeps `'concise'` and sees zero behavior change.
`scripts/regenerate-sample-emails.ts` updated to fetch the client and pick
the matching prompt, so before/after comparisons stay accurate regardless
of style. Design: `docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md`.

Operator follow-up (not code): confirm Uniforms Fashion's `signature_name`
is filled in (e.g. "Cihat Bozkurt") via the existing signature dialog, then
flip the new toggle to `formal_intro` on the Uniforms Fashion client page.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: roadmap entry for the formal-intro email style

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
