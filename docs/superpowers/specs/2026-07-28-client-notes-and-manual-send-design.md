# Client notes + client-written email — design

**Date:** 2026-07-28
**Status:** approved, ready for an implementation plan

Two features for client-role users, sharing one migration (`0020`):

1. **Notes** — a client annotates a company (case) or one person in it.
2. **Manual send** — a client writes and sends an email themselves, inside a case,
   through the same mailboxes the agent uses.

---

## 1. Notes

### What it is

A free-text annotation a human writes on a case, optionally pinned to one lead
inside that case. Purely a CRM annotation: **no prompt reads a note.** They are
not written to `case_knowledge`, not embedded, not retrieved. A client can write
"CEO seemed annoyed on the call" without any risk of it surfacing in outbound
copy.

### Schema (`0020`)

```sql
create table notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  case_id    uuid not null references cases(id) on delete cascade,
  lead_id    uuid references leads(id) on delete cascade,
  body       text not null,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_case_idx on notes (case_id, created_at desc);
```

`case_id` is **not null** even for a note about a person. `leads.case_id` is
nullable (`on delete set null` in `0001`), so anchoring on the lead would leave
notes that belong to no visible surface. Anchoring on the case makes the list one
query and makes "delete the case, delete its notes" the obvious cascade.

`lead_id` null = the note is about the company. `lead_id` set = the note is about
that person, and it still renders in the same list, tagged with their name.

### RLS

Mirrors `client_resources` (`0018`) exactly — this is the second client-writable
table and it should not invent a second pattern:

```sql
alter table notes enable row level security;
create policy notes_select on notes for select
  using (is_operator() or client_id = current_client_id());
create policy notes_insert on notes for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy notes_update on notes for update
  using  (is_operator() or (client_id = current_client_id() and created_by = auth.uid()))
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy notes_delete on notes for delete
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
```

Everyone in a client reads every note of that client; only the author (or an
operator) edits or deletes. `canManageOwnRow` already encodes exactly this and is
used for the app-side check.

**Notes writes use the scoped `createServerClient`**, not the admin client. The
policies above are the boundary, and there is no storage or cross-tenant work
that needs to bypass them. This is the one place these two features differ:
emails stay admin-written, because clients have no insert policy on `emails`.

### Code

- `src/lib/db/notes.ts` — `listNotesForCase(supabase, caseId)`, `insertNote`,
  `updateNote`, `deleteNote`. One function per operation, `{ data, error }`
  destructured, errors mapped to `AppError('DB_ERROR', …)`.
- `src/app/(app)/cases/[id]/note-actions.ts` — `createNote`, `editNote`,
  `deleteNote` Server Actions. Each: `requireUser` → Zod parse → resolve the
  case through the scoped client (RLS makes an out-of-scope case indistinguishable
  from a missing one) → `canManageClient` / `canManageOwnRow` → write →
  `revalidatePath('/cases/[id]')`.
- `created_by` always comes from the session, never the form.

### UI

**Not a tab.** The notes panel sits in the upper part of the case page, between
the `<header>` block and the Contacts section, above the
Mail/Knowledge/Questions/Activity tabs — a client should see what a human already
knows about this company before anything else on the page.

The panel contains:

- A composer: a textarea plus an **About** selector (`Company` — the default — or
  a named contact on the case). Submitted through `useTransition` so the pending
  state is real.
- The list, newest first. A lead-pinned note carries a chip with that person's
  name.
- Inline edit and delete on your own notes only; an operator sees the controls on
  every note.

A note about a person can be started from **either** end, because both readings
of "notes on leads and companies" are legitimate and they write the same row:

- from the panel, by switching the **About** selector to that contact; or
- from that person's card in the Contacts section, which shows their note count
  and an **Add note** control that focuses the panel composer with **About**
  already set to them.

There is one composer and one list — the contact card is a shortcut into it, not
a second surface. A card with no notes still shows the control, so the first note
on a person is as easy to write as the tenth.

Four states handled: loading (`loading.tsx` already exists for this route), error
(`error.tsx`), empty ("No notes yet — anything you know about this company that
the agent doesn't"), and populated.

---

## 2. Manual send

### Scope

A client may write to **leads already attached to one of their cases** — either
replying in an existing thread or opening a first message to a lead the agent has
not contacted. No free-form "type any address" compose: every send stays tied to
a case, a lead and a campaign mailbox, so suppression, threading, caps, the audit
trail and the outreach privacy posture all keep working unchanged.

Available to client-role users **and** operators. This is a deliberate loosening
of the operator-only rule on `approveDraft`: that guard exists because approving
means rubber-stamping AI copy, while here the human wrote the words.

### UI

A composer in the case page's **Mail** tab, under the thread:

- **Recipient** — a select over the case's active leads that have an address.
  Defaults to the lead of the most recent inbound message, else the first active
  lead. A case with no eligible lead shows why instead of a dead form.
- **Subject** — prefilled `Re: <last outbound subject>` when a thread exists,
  empty otherwise.
- **Body** — plain textarea. No AI draft-assist, no save-as-draft; both were
  considered and cut.
- **Attachments** — the existing `ResourcePicker`, capped by
  `MAX_ATTACHMENTS_PER_EMAIL`.
- Send runs in `useTransition`; failures surface the `AppError` code as a human
  sentence — `FORBIDDEN` → "this address is on your suppression list",
  `VALIDATION_ERROR` on mailboxes → "no mailbox is connected to this campaign".

### Server Action `sendManualEmail`

In `src/app/(app)/cases/[id]/send-actions.ts`. Shape follows `stopLead`: scoped
read for authorization, admin client for the writes (clients are read-only on
`emails` under `0002`).

1. `requireUser`; Zod parse `{ caseId, leadId, subject, body, resourceIds[] }`.
2. Scoped `createServerClient`: `getCaseById`, `getLeadById`. Re-check
   `appUser.role === 'operator' || appUser.client_id === lead.client_id`, and that
   the lead belongs to the case.
3. `getCampaignForCase` → `mailbox_ids`. Empty ⇒ `VALIDATION_ERROR`.
4. `resolveSelectedResources` then `loadResourceAttachments` — **before** the row
   claim, matching `approveDraft`: a bad selection must fail while the form is
   still on screen, not after the point of no return.
5. Threading from `listThreadEmails(leadId)`: `threadId` from the first outbound,
   `inReplyToMessageId` / `references` from the last message.
6. `purpose`: `'reply'` when that lead has ever written back, else `'outreach'`.
   Suppression stays enforced inside `sendViaMailbox` — outreach to any suppressed
   address is refused, and a hard-bounced address is refused even as a reply.
7. Claim the row (see the step-0 rule), `insertEmailAttachments`, send with
   `bypassDailyCap: true`, then `markEmailSent`; on a send failure
   `markEmailFailed` and rethrow.
8. Post-send bookkeeping (below), then `logEventSafe` with
   `type: 'email.manual_sent'`, `actor: 'human:<appUser.id>'`, and
   `revalidatePath`.

### The step-0 rule

`emails_outbound_step_uniq` on `(lead_id, sequence_step, direction)` is what stops
the writer double-sending. A manual email must respect it:

- **No step-0 outbound exists for this lead** → the manual email *claims* that
  slot via `claimOutboundEmail({ sequence_step: 0, … })`. It **is** the first
  touch: after a successful send, `scheduleFirstFollowup` starts the 3/7/14
  cadence off the client's own message, and the case moves to `contacted` if it
  is still `new`, `researching` or `ready`.
- **Slot already taken** → insert with `sequence_step = null` (a new
  `insertManualEmail` helper). The email is an interjection into an existing
  cadence, not a cadence step, and many of them may exist per lead — Postgres
  allows unlimited nulls in a unique index.

Claiming step 0 is not bookkeeping neatness. Without it: the write cron would
cold-email the same person days later, and `find_stuck_cases` (`0006`) would drag
a manually-contacted case back to `ready` **precisely because** it has no step-0
outbound email, producing exactly the collision the client just avoided by
writing themselves.

`claimOutboundEmail` also reclaims a slot left at `status = 'failed'`; for this
path that is the right outcome — the client's text replaces a first touch that
never went out.

### The skip

`sequences.skip_next_step boolean not null default false` (`0020`).

An **interjection** sets the flag on that lead's sequence, guarded on
`state = 'active'`. A first touch does not — there is no pending step to skip.

In `runFollowupStep`, placed immediately after the campaign-active branch and
before the LLM call:

```
if (sequence.skip_next_step) {
  clear the flag and set current_step = input.step
  if (input.step >= MAX_FOLLOWUP_STEP) { stopSequence('stopped'); return 'skipped' }
  enqueue step input.step + 1 at FOLLOWUP_DELAYS_SECONDS[input.step]
  return 'skipped'
}
```

Chosen behaviours, each deliberate:

- **The cadence continues.** The firing message does the work of scheduling its
  successor, so the chain survives a skip instead of dying. This is why the skip
  is a flag consumed at fire time rather than a QStash cancellation: a failed
  cancel would leave a message whose guard no longer matches, silently ending the
  sequence.
- **An inbound reply still wins.** The reply check sits above this branch and ends
  the sequence outright — a prospect who answered must never receive a nudge.
- **A dead or suppressed lead still stops the sequence** — that check also sits
  above.
- **A paused campaign freezes the skip too.** The branch is below the
  campaign-active reschedule, so a paused client resumes exactly where it was.
- **Two manual sends consume one skip.** The flag is a boolean. Simpler, and the
  second send's intent (don't let the agent talk over me) is already satisfied.
- **Skipping the final step does not mark the case `dead`.** The sequence stops,
  but a human is in that thread.
- **Idempotent.** A duplicate QStash delivery after the flag is cleared fails the
  `current_step === step - 1` guard and returns `skipped`.

New DB helpers: `requestFollowupSkip(supabase, leadId)` and
`consumeFollowupSkip(supabase, sequenceId, step)` in `src/lib/db/sequences.ts`.

### Cap bypass

A manual send must never be blocked because the agent used the quota that
morning. `claim_mailbox_send` hard-caps in SQL at
`least(daily_cap, greatest(p_effective_cap, 0))`, so passing a large cap cannot
bypass it. `0020` adds a separate function:

```sql
create or replace function public.claim_mailbox_send_uncapped(p_mailbox_id uuid)
returns setof public.mailboxes
language sql security definer set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1, updated_at = now()
   where id = p_mailbox_id and health <> 'blocked'
  returning *;
$$;
```

- **A separate function, not a parameter**, so the agent's capped path cannot
  accidentally become uncapped.
- **`sent_today` still increments**, so real volume stays visible to the health
  monitor and the daily reset.
- **`health <> 'blocked'` still applies.** If every mailbox is blocked the send
  fails with `RATE_LIMITED` — there is nothing safe to send from, and that is a
  real answer, not a cap.

`sendViaMailbox` gains `bypassDailyCap?: boolean`. Rotation (least-used-first),
the blocked filter, jitter, token refresh and the suppression chokepoint are all
unchanged; only which claim RPC runs differs. `claimMailboxSendUncapped` lands in
`src/lib/db/mailboxes.ts`.

### Provenance

`emails.sent_by uuid null references app_users(id)` (`0020`). Null = the agent
wrote it. The case thread and `/mail` render a "sent by a person" marker on
non-null rows, so an operator reading a thread can tell who said what without a
join — `EmailMessage` takes a boolean prop, no name lookup.

---

## Migration `0020` — full contents

1. `notes` table + index + RLS policies.
2. `emails.sent_by uuid null references app_users(id)`.
3. `sequences.skip_next_step boolean not null default false`.
4. `claim_mailbox_send_uncapped(p_mailbox_id uuid)`.

`src/types/database.ts` updated for the new table, both new columns and the new
`Functions` entry. All four are additive — no backfill, no deploy ordering
constraint.

---

## Testing

Per `.claude/QUALITY.md`: 100% on new pure functions and Zod schemas, 90% on
Server Actions, 80% on the DB layer.

- `src/lib/db/notes.test.ts` — each helper, success and `DB_ERROR` mapping.
- `note-actions.test.ts` — unauthenticated reject, cross-tenant case reject,
  editing someone else's note reject, operator override, happy path.
- `send-actions.test.ts` — auth reject, cross-tenant lead reject, lead not on the
  case, no mailbox on campaign, suppressed recipient (`FORBIDDEN`), attachment
  resolution failure leaves no row, first-touch path (claims step 0 → sequence
  created → case `contacted`), interjection path (`sequence_step` null → skip flag
  set), send failure marks the row `failed` and rethrows.
- `sender.test.ts` — `bypassDailyCap` sends from a mailbox already at
  `sent_today >= daily_cap`; still refuses a `blocked` mailbox; the capped path is
  unchanged.
- `followup.test.ts` — skip consumed and step N+1 enqueued at the right delay;
  skip on the final step stops the sequence without marking the case `dead`; an
  inbound reply beats a pending skip; a paused campaign postpones it; a duplicate
  delivery after consumption returns `skipped`.
- RLS integration coverage for `notes` alongside the existing
  `src/lib/supabase/rls.integration.test.ts` cases.

---

## Explicitly out of scope

- Free-form send to an arbitrary address.
- AI draft-assist in the client composer.
- Save-as-draft for client-written mail.
- Notes feeding any prompt, in any form.
- Note counts on the `/crm` board.
