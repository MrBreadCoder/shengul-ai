# Client-Configurable Reply Mode — Design

**Status:** Approved design
**Date:** 2026-08-03
**Scope:** Let a client choose, from their own Settings page, how the AI handles replies from leads across all of their campaigns — send automatically, always draft for human review, or a confidence-based hybrid.

---

## 1. Purpose

`reply_mode` (`auto_send` / `human_approve` / `hybrid`) already exists as a per-campaign column and already drives `replyDisposition()` in the reply pipeline. Today it can only be set by a direct DB write — no Server Action, API route, or UI ever writes it, and clients (and operators) have no way to see or change it.

This feature exposes the setting to clients on `/settings`, scoped **account-wide** rather than per-campaign: a client picks one mode that applies to every campaign they have, present and future. Operators do not get their own control for this — it is a client-owned preference.

---

## 2. Design Principles

- **No pipeline changes.** Every read of `reply_mode` goes through `getCampaignForCase()`, which reads `campaigns.reply_mode`. This feature adds a client-level *source of truth* that is kept in sync onto `campaigns.reply_mode`, so `reply.ts`, `knowledge-answer.ts`, and `collision-notify.ts` need no changes at all.
- **Consistency over lazy propagation.** Changing the setting immediately bulk-updates every one of the client's campaigns (active, paused, or archived) — mirroring the existing `pauseActiveCampaignsForClient` bulk-update pattern in `src/lib/db/campaigns.ts`. A client should never see "automatic" in Settings while a campaign is quietly still on manual.
- **Client-owned, no extra friction.** No confirmation dialog on switching to Automatic — save-on-change like every other Settings control, with a one-line description of what each mode does inline so the risk is legible without a modal.

---

## 3. Data Model

Migration `supabase/migrations/0023_client_reply_mode.sql`:

```sql
alter table clients add column reply_mode reply_mode not null default 'human_approve';
```

Reuses the existing `reply_mode` enum (`auto_send`, `human_approve`, `hybrid`) defined in `0001_initial_schema.sql` — no new type. `campaigns.reply_mode` is untouched; it remains the column the pipeline actually reads.

Regenerate `src/types/database.ts` after the migration so `ClientRow['reply_mode']` is typed.

---

## 4. Data Layer

### 4.1 `src/lib/db/clients.ts`

```ts
export async function updateClientReplyMode(
  supabase: SupabaseClient<Database>,
  id: string,
  mode: ReplyMode,
): Promise<ClientRow>
```

Single-field `.update({ reply_mode: mode }).eq('id', id).select('*').single()`, same shape as `updateClientWarmupProfile`.

### 4.2 `src/lib/db/campaigns.ts`

```ts
// Applied to every campaign regardless of status, so a paused or archived
// campaign is already correct if it is ever resumed — mirrors
// pauseActiveCampaignsForClient's bulk-update shape.
export async function syncReplyModeForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  mode: ReplyMode,
): Promise<void>
```

`.update({ reply_mode: mode }).eq('client_id', clientId)` — no status filter.

### 4.3 New-campaign default — `src/app/api/campaigns/route.ts`

Campaign creation currently relies on the column default (`'human_approve'`). Change the insert path to fetch the client's `reply_mode` (already loading the client row for validation) and pass it explicitly in the insert, so a new campaign for a client already on `auto_send` doesn't silently start on `human_approve`.

---

## 5. Server Action

New file `src/app/(app)/settings/reply-mode-actions.ts`, following `settings/crm/actions.ts` exactly:

```ts
'use server'

const replyModeSchema = z.enum(['auto_send', 'human_approve', 'hybrid'])

export async function updateReplyMode(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their reply mode', { role: appUser.role })
  }

  const parsed = replyModeSchema.safeParse(formData.get('replyMode'))
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid reply mode', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateClientReplyMode(admin, appUser.client_id, parsed.data)
  await syncReplyModeForClient(admin, appUser.client_id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.reply_mode_changed',
    source: 'settings',
    payload: { replyMode: parsed.data },
  })
  revalidatePath('/settings')
}
```

Both the client-level write and the campaign bulk-sync happen inside this one action, in that order — if the sync fails, `updateClientReplyMode` has already committed, which is acceptable (retrying the action re-runs the sync idempotently; there's no partial-write hazard since both writes target the terminal `mode` value, not a delta).

---

## 6. UI

### 6.1 `src/app/(app)/settings/page.tsx`

New `Section title="Reply mode"`, rendered only when `appUser.role === 'client'` (operators viewing their own `/settings` have no `client_id` and nothing to scope this to — consistent with the account-scoped decision in §2). Placed after "Connected mailboxes".

### 6.2 `src/app/(app)/settings/reply-mode-section.tsx` (new, client component)

A labeled `<select>` matching the existing style in `mailbox-controls.tsx` (`border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]`), three options each with inline one-line help text below the select (not per-option, since native `<option>` can't carry rich text):

| Value | Label | Help text shown when selected |
|---|---|---|
| `auto_send` | Automatic | "The AI sends replies to leads immediately, with no review." |
| `human_approve` | Manual | "Every reply is drafted for your team to review and send from the Inbox." |
| `hybrid` | Hybrid | "The AI sends high-confidence replies automatically and drafts the rest for review." |

Calls `updateReplyMode` via `useTransition`, matching `pipeline-picker.tsx`'s pattern (`startTransition(async () => { await updateReplyMode(formData) })`), with an inline error message on failure (no toast system in this codebase for this kind of control — same as `crm` actions).

Props: `currentMode: ReplyMode`. No client-side polling — `revalidatePath('/settings')` in the action refreshes the Server Component after the transition resolves.

---

## 7. Out of Scope

- Per-campaign overrides. Every campaign inherits the client's current mode; there is no UI to diverge a single campaign from it.
- Operator-side control of a client's reply mode. Operators can still see the effective mode by reading a campaign's `reply_mode` directly (existing `/campaigns` views), but this feature adds no operator UI.
- A confirmation step or warning modal on switching to Automatic — decided against per §2.
- Historical reconciliation: campaigns created before this migration ships already have `reply_mode = 'human_approve'` (the existing column default) and a client's new `clients.reply_mode` also defaults to `'human_approve'`, so both start in the same state — no backfill needed.

---

## 8. Testing

Per `QUALITY.md` coverage targets.

**`clients.test.ts`** — `updateClientReplyMode`: happy path returns the updated row; Supabase error maps to `AppError`.

**`campaigns.test.ts`** — `syncReplyModeForClient`: issues the update with no status filter; Supabase error maps to `AppError`.

**`reply-mode-actions.test.ts`** — unauthenticated → redirect (via `requireUser`); operator role → `FORBIDDEN`; client with `client_id === null` → `FORBIDDEN` (defensive, shouldn't occur given the DB constraint); invalid enum value → `VALIDATION_ERROR`; happy path asserts both `updateClientReplyMode` and `syncReplyModeForClient` are called with the parsed mode, `logEvent` fires with the right payload, and `revalidatePath('/settings')` is called.

**`src/app/api/campaigns/route.test.ts`** — new campaign insert carries the client's current `reply_mode`, not the column default, when the client has a non-default value set.

**Component** — `reply-mode-section.tsx`: renders the current mode selected; changing the select triggers the transition and calls the action with the new value; a rejected action surfaces the inline error text.

---

## 9. Implementation Order

1. Migration `0023_client_reply_mode.sql` + regenerate `src/types/database.ts`.
2. `updateClientReplyMode` (`lib/db/clients.ts`) and `syncReplyModeForClient` (`lib/db/campaigns.ts`), with tests.
3. `src/app/api/campaigns/route.ts` — use client's `reply_mode` as the insert default, with test.
4. `reply-mode-actions.ts` Server Action, with tests.
5. `reply-mode-section.tsx` component + wire into `settings/page.tsx`.
6. Manual verification: change the setting as a client-role user, confirm all of that client's campaigns reflect the new mode in the DB, confirm a newly created campaign for that client picks it up.
