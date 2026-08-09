# Editable & Addable Email Styles — Design

**Date:** 2026-08-09
**Trigger:** Operator request — the two first-touch email voices (`concise`, `formal_intro`) are hardcoded TS string constants in `src/lib/pipeline/write.ts`, and the DB column backing them (`clients.email_style`) is a fixed 2-value Postgres enum. Adding a third voice, or tweaking the wording of an existing one, currently requires an engineer to edit code and ship a migration. This makes styles a first-class, operator-managed entity: create, edit, and delete voices from the client detail page, with no code change required.

## Decisions from clarifying questions

- **Fully dynamic, not edit-only.** Operators create/name/edit/delete styles freely. `clients.email_style` (enum) is replaced by `clients.email_style_id`, a nullable FK into a new `email_styles` table.
- **Guardrails stay fixed in code, broadened.** Five things that are true of every voice today — regardless of style — move into a hardcoded block that's always appended: subject-line formatting rules, the human-voice instruction, "always write in English / translate foreign facts," "no bulk-sender markers / unsubscribe footer / tracking language," and "use only facts present in the dossier, never invent." Operators only ever edit the voice-specific part: opening move, structure, tone, word-count target, CTA style. This is a deliberate risk reduction — a badly-written new style can't accidentally ship non-compliant or fact-inventing emails, because those rules aren't in the text an operator controls.
- **Management UI lives inline on `/clients/[id]`,** next to the existing style dropdown — not a separate global settings page. Editing a style there is a global change (it affects every client using that style); the UI must say so explicitly to avoid an operator thinking they're only changing the current client's copy.
- **Deleting a style in use reassigns affected clients to the default style automatically** (no confirmation-blocking on "is this style in use"). Deleting the style currently marked default is blocked outright — decided during design, not asked — because the system always needs exactly one fallback voice to resolve `email_style_id = NULL` against. To retire the current default, an operator marks a different style as default first (new "Set as default" action), then deletes the old one.

## Approaches considered

- **Table + FK on `clients` (chosen).** Same shape as any other lookup-table relationship in this codebase; `email_style_id` on `clients` is nullable, `NULL` means "use whichever style `is_default` points to right now," matching the existing `selectSystemPrompt` fallback behavior for missing/null values.
- **JSON column of styles on a settings row.** Rejected — no natural place to enforce name-uniqueness or a single default, and every read call site would need to parse JSON instead of a typed row.
- **Keep enum, add new enum values via migration per style.** Rejected outright — this is exactly the "requires an engineer" problem the feature exists to remove.

## Data model

New migration `supabase/migrations/0035_email_styles_table.sql`:

```sql
create table email_styles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  voice_instructions text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index email_styles_name_key on email_styles (name);

-- Enforces "exactly one default" at the DB level, not just in application code.
create unique index email_styles_single_default_key on email_styles (is_default) where is_default;

insert into email_styles (name, voice_instructions, is_default) values
  ('Concise (default)',
   'You write short, human-sounding B2B cold emails. One clear idea. 90 words or fewer. '
   || 'Lead with the specific dossier fact, not a greeting. '
   || 'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"), '
   || 'not the booking link. Only offer the booking link if it is clearly the natural next step — '
   || 'it is an optional extra, never the default ask.',
   true),
  ('Formal introduction',
   'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect. '
   || 'Structure the body as exactly five short paragraphs, in this order: '
   || '1. Greeting: "Dear [Recipient first name]," using the recipient''s first name from the Recipient '
   || 'line below; if no name is given, use "Dear," alone. '
   || '2. Self-introduction: one sentence giving the sender name and company name exactly as given in '
   || '"Sender name" / "Our company name" below, plus the company''s home base and years of experience — '
   || 'only the ones you have evidence for in "About our company"; drop whichever you don''t have '
   || 'rather than guessing. '
   || '3. Capabilities: one sentence on what the company manufactures or does, grounded in the value '
   || 'proposition and "About our company" below. '
   || '4. Hook: one sentence connecting to this specific recipient — cite a real fact about their '
   || 'company or industry from the dossier. Never use a generic line like "I came across your '
   || 'company" or "I wanted to introduce ourselves" — the hook must trace to a dossier fact. '
   || '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the '
   || 'kind of procurement or project relevant to their industry, followed by an offer to send the '
   || 'company profile, references, and product capabilities if so. Only mention the booking link '
   || 'here if it is clearly the natural next step; otherwise the offer to send materials is the '
   || 'entire ask. '
   || 'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any '
   || 'sign-off — a signature block is appended separately in code. '
   || '120 words or fewer, including the greeting.',
   false);

alter table clients add column email_style_id uuid references email_styles(id) on delete set null;

-- Explicit backfill (not left NULL) so existing clients' resolved voice can't
-- silently change later if someone re-points is_default at a different style.
update clients set email_style_id = (select id from email_styles where name = 'Concise (default)')
  where email_style = 'concise';
update clients set email_style_id = (select id from email_styles where name = 'Formal introduction')
  where email_style = 'formal_intro';

alter table clients drop column email_style;
drop type email_style;
```

`src/types/database.ts`: add an `email_styles` table (`Row`/`Insert`/`Update` for `id`, `name`, `voice_instructions`, `is_default`, `created_at`, `updated_at`), replace `clients.email_style: Enums['email_style']` with `clients.email_style_id: string | null`, and remove the `email_style` entry from `Enums`.

## `src/lib/pipeline/write.ts` — prompt changes

`CONCISE_SYSTEM_PROMPT` / `FORMAL_INTRO_SYSTEM_PROMPT` / `selectSystemPrompt` are removed. In their place:

```ts
// Always true regardless of voice — not something a style's text can opt out
// of. Broadened from the original SUBJECT_LINE_RULES-only guardrail so a
// newly created style can't accidentally ship non-compliant or
// fact-inventing copy: this is the entire trust boundary between "operator
// picks words" and "operator can break compliance."
const FIXED_GUARDRAILS = [
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any other specific you were not given.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
].join(' ')

// Combines the fixed, non-editable guardrails above with a style's
// operator-authored voice text. Pure function — the only place style text
// touches the system prompt, so it's the one thing tests need to cover.
export function buildSystemPrompt(voiceInstructions: string): string {
  return `${FIXED_GUARDRAILS} ${voiceInstructions}`
}
```

`buildPrompt` is unchanged (it's the per-lead user-turn prompt, unrelated to voice selection).

`processLead` currently fetches `client: ClientRow | null` via `getClientById`. `getClientById`'s select gains an embedded join, aliased to avoid confusion with the old scalar column name:

```ts
.select('*, email_style:email_styles(*)')
```

`ClientRow` gains `email_style: EmailStyleRow | null` (the embedded resource; `null` when `email_style_id` is `NULL`). `processLead` resolves the effective style, falling back to the DB-wide default exactly like today's "missing client row never blocks generation" comment describes:

```ts
const style = client?.email_style ?? (await getDefaultEmailStyle(supabase))
const draft = await generateJson(context, {
  instructions: buildSystemPrompt(style.voice_instructions),
  prompt: buildPrompt(input, lead, knowledge, clientKnowledge, client),
  schema: draftSchema,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  thinkingLevel: 'minimal',
})
```

`getDefaultEmailStyle` throws `AppError('INVARIANT_VIOLATION', ...)` if no row has `is_default = true` — this must never happen given the DB constraint, but the code doesn't trust that silently.

`MAX_OUTPUT_TOKENS` (1,400) is unchanged.

## `src/lib/db/email-styles.ts` (new)

One function per operation, mirroring the rest of `lib/db/`:

- `listEmailStyles(supabase): Promise<EmailStyleRow[]>` — ordered by `name`.
- `getEmailStyleById(supabase, id): Promise<EmailStyleRow | null>`.
- `getDefaultEmailStyle(supabase): Promise<EmailStyleRow>` — throws `INVARIANT_VIOLATION` if none found.
- `createEmailStyle(supabase, { name, voiceInstructions }): Promise<EmailStyleRow>` — maps the unique-name Postgres error (`23505`) to `AppError('EMAIL_STYLE_NAME_TAKEN', ...)`.
- `updateEmailStyle(supabase, id, { name?, voiceInstructions? }): Promise<EmailStyleRow>` — same name-conflict mapping; `AppError('EMAIL_STYLE_NOT_FOUND', ...)` if the row doesn't exist.
- `setDefaultEmailStyle(supabase, id): Promise<EmailStyleRow>` — two-step within one call: unset the current `is_default` row, set the new one. Not a raw two-statement race in application code — wrapped so a failure between the two steps can't leave zero defaults; see Testing.
- `deleteEmailStyle(supabase, id): Promise<void>` — loads the row first; if `is_default`, throws `AppError('CANNOT_DELETE_DEFAULT_STYLE', ...)`. Otherwise: `update clients set email_style_id = null where email_style_id = id`, then deletes the row.

`src/lib/db/clients.ts`: `updateClientEmailStyle(supabase, id, styleId: string | null)` replaces the current enum-typed version — same shape as `updateClientWarmupProfile`, just the DB column and its type change.

## API routes

`src/app/api/clients/[clientId]/route.ts`: `patchSchema`'s `emailStyle: z.enum([...])` becomes `emailStyleId: z.string().uuid().nullable()`. The existing `emailStyle` PATCH block is renamed and calls `updateClientEmailStyle(admin, clientId, body.emailStyleId)`; the `client.email_style_changed` event payload switches from the old/new enum values to old/new style ids.

New `src/app/api/email-styles/route.ts` (operator-only, same `requireUser` + role check as every other route here):

- `GET` → `listEmailStyles`.
- `POST` → Zod `{ name: z.string().trim().min(1).max(80), voiceInstructions: z.string().trim().min(1).max(4000) }` → `createEmailStyle`, logs `email_style.created`.

New `src/app/api/email-styles/[styleId]/route.ts`:

- `PATCH` → Zod `{ name?, voiceInstructions?, isDefault?: z.literal(true) }.refine(at least one field)`. If `isDefault` is set, calls `setDefaultEmailStyle` (mutually exclusive with `name`/`voiceInstructions` in the same request — simplest to reason about, and the UI never needs to combine them). Otherwise calls `updateEmailStyle`. Logs `email_style.updated` / `email_style.default_changed`.
- `DELETE` → `deleteEmailStyle`, 409 with `{ error: 'cannot_delete_default_style' }` on that specific `AppError` code, logs `email_style.deleted`.

## UI — `src/app/(app)/clients/[id]/email-style-select.tsx`

Server Component (`page.tsx`) now fetches `listEmailStyles(admin)` alongside the client and passes `styles: EmailStyleRow[]` and `selectedStyleId: string` (the client's `email_style_id`, **resolved**: `client.email_style_id ?? defaultStyle.id`, where `defaultStyle` is the `is_default` row already present in `styles`) as props, replacing the current `value={client.email_style}` prop. This resolution matters beyond the day-one migration: a future style deletion can null out a client's `email_style_id` again (the fallback-to-default reassignment), and the dropdown must keep showing an explicit, real selection rather than a blank/null state in that case too.

The component becomes a small combined selector/editor, still operator-only plain English (no `useTranslations`, per `CLAUDE.md`):

- The `<select>` lists every style by `name`, value always one of the real style ids in `styles` — never a synthetic "default" placeholder option. Selecting any listed style PATCHes `emailStyleId` to that style's id.
- An **Edit** icon button next to the dropdown expands an inline form (name input + textarea for `voiceInstructions`, Save/Cancel) for the *currently selected* style. Above the textarea: "Editing this style updates it for every client currently using it." Save → `PATCH /api/email-styles/[styleId]`, `router.refresh()`.
- A **+ New style** button expands the same form, empty, with Save → `POST /api/email-styles`, then immediately PATCHes the current client to the new style's id and refreshes.
- A **Delete** icon button, disabled (with a tooltip: "Can't delete the default style") when the selected style `is_default`. Confirms, then `DELETE`s; on success, if the deleted style was the one selected for this client, the dropdown moves to whatever the client now resolves to (the default) after refresh.
- A **Set as default** action, only shown for the selected style when it isn't already default.

All mutations reuse the existing `isPending`/`error` pattern already in the file.

## Tests

- `src/lib/db/email-styles.test.ts`: create/read/update/delete happy paths; name-conflict on create and update; `deleteEmailStyle` rejects when `is_default`; `deleteEmailStyle` reassigns referencing clients to `null` before deleting; `getDefaultEmailStyle` throws when (mocked) no row is default; `setDefaultEmailStyle` results in exactly one `is_default = true` row.
- `src/lib/pipeline/write.test.ts`: `buildSystemPrompt('custom voice text')` contains every fixed guardrail line and the given voice text, for both a short and an empty-ish voice string; `processLead`-level test with a mocked client whose `email_style` join is `null` asserts `getDefaultEmailStyle` is called and its `voice_instructions` reaches `generateJson`'s `instructions`.
- `src/app/api/email-styles/route.test.ts` and `.../[styleId]/route.test.ts`: auth rejection (non-operator → 403), validation rejection (empty name, oversized text), success path for each verb, name-conflict → 409, delete-default → 409.
- `src/app/api/clients/[clientId]/route.test.ts`: existing `emailStyle` PATCH test case updated to `emailStyleId` (uuid, and `null`).
- No new test file for the `email-style-select.tsx` component itself — consistent with the existing "no other `*-select.tsx` on this page has one" precedent noted in the prior formal-intro design doc.

## `scripts/regenerate-sample-emails.ts`

Currently depends on `selectSystemPrompt` and `client?.email_style` (the enum). Updated to depend on `buildSystemPrompt` and the joined `client?.email_style?.voice_instructions`, falling back to `getDefaultEmailStyle` exactly like `processLead` — same dependency-injection (`AppDeps`) pattern already used there for testability.

## Rollout

Every existing client keeps its current resolved voice unchanged — the migration's explicit backfill (not a bare default) guarantees Uniforms Fashion stays on `formal_intro`'s current wording and everyone else stays on `concise`'s, byte-for-byte, immediately after migration. The only new capability is the ability to add/edit/delete styles going forward; nothing sends differently on day one.

## Out of scope

- A global (non-client-page) styles management screen — deferred; can be added later without a data-model change if the inline-on-client-page location turns out to be hard to find.
- Per-campaign style overrides (styles stay client-level, matching the existing `formal_intro` precedent).
- Versioning/history of style-text edits.
- Changing `followup.ts` or `redesign.ts` voice — first-touch only, matching the original formal-intro design's scope.
