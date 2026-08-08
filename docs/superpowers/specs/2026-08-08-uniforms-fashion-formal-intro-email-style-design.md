# Uniforms Fashion — Formal Intro Email Style — Design

**Date:** 2026-08-08
**Trigger:** Uniforms Fashion (client, `d99edf8f-b185-47b2-9615-1f6e43853001`) asked for their first-touch cold emails to follow a specific formal introduction structure (sample below) instead of the pipeline's default dossier-led, low-friction style.

Sample provided by the operator:

> Dear,
>
> I'm Cihat Bozkurt from Uniforms Fashion / Cardiff Textile, an Istanbul-based uniform manufacturer with nearly 30 years of experience.
>
> We design and manufacture complete uniform solutions for airlines, army, police, hospitality, security organizations, public institutions, and corporate companies, including garments, hats & caps, accessories, and bags.
>
> I came across your company and wanted to introduce ourselves and explore a potential cooperation.
>
> Would you be the right person to discuss uniform procurement or upcoming uniform projects?
>
> If so, I would be pleased to send you our company profile, references, and product capabilities.
>
> Best regards,
> Cihat Bozkurt
> Uniforms Fashion

## Decisions from clarifying questions

- **Scope: Uniforms Fashion only**, not a global default. No per-client email-style setting exists today (`src/lib/pipeline/write.ts`'s `SYSTEM_PROMPT` is shared by every client) — this needs a new one.
- **Personalization: convert, don't copy verbatim.** The sample's generic "I came across your company and wanted to introduce ourselves" line is replaced by a real per-recipient dossier fact — same voice and structure as the sample, not the same words for every lead.
- **Constraints: whatever converts most**, not a strict word-for-word port of the sample's exact length/rules. The sample's own body (excluding the greeting and the "Best regards" sign-off, both handled separately — see below) is already close to the pipeline's existing 90-word cap; the new style targets ~120 words to leave room for the personalized hook.
- **Scope: first-touch only.** `followup.ts` (3/7/14-day nudges) and `redesign.ts` (`/inbox` AI-rewrite-draft) keep the current voice — a follow-up re-introducing "Dear, I'm Cihat Bozkurt from Uniforms Fashion..." every few days would be redundant; nudges already reference "the first outbound email."

## Approaches considered

- **Per-client `email_style` column (chosen).** Same pattern as `warmup_profile`/`reply_mode`/the phone-signature fields already on `clients`: a nullable-with-default column, an operator toggle on `/clients/[id]`, `write.ts` branches on it. Reusable if another client wants this style later; zero risk to other clients' campaigns.
- **Per-campaign override.** Rejected — Uniforms Fashion runs 8 campaigns under one client; the earlier phone-signature design (`docs/superpowers/specs/2026-08-07-client-contact-signature-design.md`) explicitly avoided this same trap ("a property of the company, not of an individual campaign... must not need setting 8 times").
- **Hardcode `client.id === '<uuid>'` in `write.ts`.** Rejected — bakes an environment-specific UUID into source, not operator-toggleable, not reusable.

## Data model

New migration `supabase/migrations/0034_client_email_style.sql`:

```sql
create type email_style as enum ('concise', 'formal_intro');
alter table clients add column email_style email_style not null default 'concise';
```

`concise` is today's existing behavior for every client (zero migration risk — no existing row changes meaning). `src/types/database.ts`: add `email_style: Database['public']['Enums']['email_style']` to `clients`' `Row`/`Insert`/`Update`, and `email_style: 'concise' | 'formal_intro'` to the `Enums` block.

## `src/lib/pipeline/write.ts` — prompt changes

Today's `export const SYSTEM_PROMPT` is renamed to `CONCISE_SYSTEM_PROMPT` (text unchanged). Its subject-line rules are extracted into a shared `SUBJECT_LINE_RULES` array so both prompts stay identical on subject formatting without duplication:

```ts
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]
```

New `FORMAL_INTRO_SYSTEM_PROMPT`:

```ts
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
```

No sign-off is generated by the model in either style — `appendSignatureBlock` (`src/lib/pipeline/signature.ts`, unchanged) already appends `Best regards,` + identity + contact lines deterministically whenever the client has a phone on file, which is exactly how the sample's closing three lines are produced.

`buildPrompt` gains one parameter, `client: ClientRow | null` (the row `runWriteForCase`/`processLead` already fetch), and two new optional context lines used by `formal_intro` (harmless no-ops for `concise`, since that prompt never asks the model to introduce itself by name):

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

A new exported helper picks the prompt, reused by both `write.ts` and the regeneration script:

```ts
export type EmailStyle = Database['public']['Enums']['email_style']

export function selectSystemPrompt(emailStyle: EmailStyle | null | undefined): string {
  return emailStyle === 'formal_intro' ? FORMAL_INTRO_SYSTEM_PROMPT : CONCISE_SYSTEM_PROMPT
}
```

`processLead` (already holds the fetched `client` row) replaces its `instructions: SYSTEM_PROMPT` with `instructions: selectSystemPrompt(client?.email_style)`, and its `buildPrompt(input, lead, knowledge, clientKnowledge)` call gains the `client` argument.

`MAX_OUTPUT_TOKENS` (1,400) is unchanged — a 120-word email is well under that ceiling regardless of style.

## Operator toggle

New `src/app/(app)/clients/[id]/email-style-select.tsx`, modeled directly on `warmup-profile-select.tsx`: a plain `<select>` (`concise` / `formal_intro`), `PATCH /api/clients/${clientId}` with `{ emailStyle }`, `useTransition` + inline error state. Per `CLAUDE.md` ("no language translation in operator-only pages"), this component uses plain English strings, **not** `useTranslations` — even though sibling components on that page (pre-existing) do use it; that's not touched here.

Rendered next to `WarmupProfileSelect`/`MailreachToggle`/`DefaultLocaleSelect` in the header actions row of `src/app/(app)/clients/[id]/page.tsx`.

`src/app/api/clients/[clientId]/route.ts`: `patchSchema` gains `emailStyle: z.enum(['concise', 'formal_intro']).optional()`, added to the `.refine` "at least one field" check. New block mirrors the existing `warmupProfile` block exactly:

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

`src/lib/db/clients.ts`: new `updateClientEmailStyle(supabase, id, style)`, same shape as `updateClientWarmupProfile`.

## `scripts/regenerate-sample-emails.ts`

This script currently imports a flat `SYSTEM_PROMPT` string and never fetches the client row, so it always compares against the concise voice regardless of the sampled email's actual client. It needs:
- `getClientById` added to its dynamic-import deps (`AppDeps`) and called in `regenerateOne` (it already has `sample.clientId`).
- Its `SYSTEM_PROMPT: string` dep replaced with `selectSystemPrompt: typeof import('../src/lib/pipeline/write').selectSystemPrompt`.
- Its `buildPrompt` call gains the fetched `client` argument.
- Its `generateJson` call's `instructions` becomes `deps.selectSystemPrompt(client?.email_style)`.

## Tests

- `write.test.ts`: the default mocked client fixture gets `email_style: 'concise'` (or omits it — `selectSystemPrompt` falls back to concise on `undefined`, so every existing assertion keeps passing unchanged). New test: with a mocked client `{ email_style: 'formal_intro', ... }`, `generateJson` is called with `instructions` equal to `FORMAL_INTRO_SYSTEM_PROMPT`.
- `src/app/api/clients/[clientId]/route.test.ts`: mock `updateClientEmailStyle`; new PATCH test case for `emailStyle`, same shape as the existing `warmupProfile` case (success path + validation rejection for an invalid enum value).
- No new test file for `email-style-select.tsx` — no other `*-select.tsx` on this page has one either (consistent with existing coverage).

## Rollout

Ships with `email_style` defaulting to `'concise'` for every client, including Uniforms Fashion's already-live 8 campaigns — **no behavior changes until an operator explicitly flips the toggle** on the Uniforms Fashion client page.

**Prerequisite:** the self-introduction line ("I'm [Sender name] from [Company]...") only names a sender if `clients.signature_name` is set — the same field the existing `EditSignatureDialog` already edits (added for the phone-signature feature). Without it, the model drops the sender's name per its "drop what you don't have evidence for" instruction and opens with the company name only. The operator should confirm Uniforms Fashion's `signature_name` is filled in (e.g. "Cihat Bozkurt") before flipping the toggle, so the generated opening matches the sample.

## Out of scope

- Applying `formal_intro` to any other client.
- Changing `followup.ts` or `redesign.ts` voice.
- A UI preview of the generated email before send (existing `human_approve` reply mode already covers draft review, unchanged).
