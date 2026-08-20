# Design: Per-contact status, computed case rollup

**Status:** Approved for planning.

## Problem

A `cases` row (one company, one campaign) can have many `leads` rows (contacts) attached via `leads.case_id` — multi-contact outreach (`contactsPerCompany`) is a deliberate campaign feature, not an edge case. But all outreach-progress state (`new/researching/ready/writing/waiting/contacted/in_conversation/hot_handoff/won/lost/dead`) lives on exactly one column, `cases.status`, shared by every contact on the case. Every pipeline stage computes a per-contact outcome internally and then collapses it into that single shared value, and the collapse is lossy:

- `write.ts` (`runWriteForCase`) — one lead sending while a sibling lead hits a same-tick cap race leaves the case `contacted`, with the second lead's real, already-written content invisible at the case level (traced 2026-08-19, `.claude/roadmap.md`).
- `reply.ts` (`runReplyForInbound`) — any single contact's reply flips the whole case (`in_conversation`, then `hot_handoff`/`lost` off that one contact's classified intent), overwriting the state of every other contact on the case.
- `followup.ts` (`runFollowupStep`) — one contact's exhausted sequence marks the entire case `dead`, regardless of other contacts still active.
- `inbox/actions.ts` (`approveDraft`), `cases/[id]/send-actions.ts` (`finalizeManualSend`), `resend-failed.ts` — same pattern: one contact's event writes the shared case-level value.
- `/crm` kanban buckets and counts a case into exactly one column off that single value, so a mixed-progress case shows no sign it's mixed.

Root cause: **there is no per-contact progress field at all today.** `leads.status` (`new/parked/active`) is a send-eligibility flag, not progress. `leads.email_status` is a deliverability verdict. Every pipeline stage has the per-contact information it needs in the moment, but nowhere to put it — so it gets written straight onto the shared case column instead.

## Scope decisions (from brainstorming)

- Per-contact status becomes the real, stored source of truth. `cases.status`/`wait_reason` become a **computed rollup**, not something pipeline code writes to directly.
- Rollup rule: whichever contact has progressed furthest wins (most-positive-first), matching the UI's badge ordering.
- The case only shows `lost`/`dead` once **every** contact on it has reached a dead end. One contact going cold never overwrites a sibling still active in the funnel.
- `won` is excluded from the automatic rollup entirely — it's a manual, human-driven action on the case itself (unchanged from today's behavior), and `recompute_case_status` must never touch a case already marked `won`.
- Kanban/case-card UI shows one badge per distinct stage present among a case's contacts (most-positive first), not just one collapsed label.

## 1. Data model

New enum, new columns on `leads`, in the same style as `case_status`/`case_wait_reason`:

```sql
-- supabase/migrations/0053_lead_stage.sql

-- Per-contact progress, the piece that's been missing. Deliberately a
-- subset of case_status: 'new'/'researching'/'ready' are pre-outreach,
-- company-level research phases with no per-contact meaning yet (stays
-- null until write.ts first drafts something for this lead); 'won' is a
-- human decision made on the case itself, never derived from a contact's
-- reply — see cases_status_won_guard note in recompute_case_status.
create type lead_stage as enum (
  'writing',
  'waiting',
  'contacted',
  'in_conversation',
  'hot_handoff',
  'lost',
  'dead'
);

alter table leads add column stage lead_stage;
alter table leads add column wait_reason case_wait_reason;

-- Same cross-column guard as cases_wait_reason_matches_status (0050),
-- adjusted for stage being nullable (a lead that hasn't started
-- outreach yet has both columns null). coalesce(..., false) avoids the
-- three-valued-logic trap of comparing a nullable boolean straight
-- against a NOT NULL check.
alter table leads add constraint leads_wait_reason_matches_stage
  check (coalesce(stage = 'waiting', false) = (wait_reason is not null));
```

`src/types/database.ts`: `leads.Row` gains `stage: Database['public']['Enums']['lead_stage'] | null` and `wait_reason: Database['public']['Enums']['case_wait_reason'] | null`; new `lead_stage` enum entry alongside the existing enum list.

Not every `case_wait_reason` value is contact-attributable. `awaiting_manual_approval`, `awaiting_resend`, and `daily_cap` are about one specific lead's send/draft and flow through `leads.wait_reason`. `mailreach_gate`, `no_healthy_mailbox`, and `no_viable_leads` describe the case's mailbox pool or lead pool as a whole, not any one contact — those stay case-only, written directly via the existing `updateCaseWaiting`, untouched by this design.

## 2. `recompute_case_status` — the one place the rollup rule lives

A Postgres function, not application code — the same conflict (`write.ts` mid-loop for one lead while a reply lands for another lead on the same case) that broke `cases.status` before is exactly the kind of race a read-then-write in TypeScript would reproduce. Locking the case row first serializes concurrent recomputes for the same case:

```sql
-- supabase/migrations/0054_recompute_case_status.sql

create or replace function recompute_case_status(p_case_id uuid)
returns void
language plpgsql
as $$
declare
  v_current_status  case_status;
  v_total_leads      int;
  v_terminal_leads   int;
  v_has_lost         boolean;
  v_primary          lead_stage;
begin
  -- Row lock first: two concurrent callers for the same case (e.g. a
  -- reply landing for lead A while write.ts is finishing lead B) must
  -- serialize, not interleave their read-compute-write.
  select status into v_current_status from cases where id = p_case_id for update;
  if v_current_status is null then
    return; -- case not found -- caller's own FK guarantees this shouldn't happen
  end if;

  -- 'won' is a human decision, made on the case, never derived from a
  -- contact's stage. Recompute must never walk it back.
  if v_current_status = 'won' then
    return;
  end if;

  select count(*), count(*) filter (where stage in ('lost', 'dead'))
    into v_total_leads, v_terminal_leads
  from leads
  where case_id = p_case_id;

  if v_total_leads = 0 then
    return; -- no contacts on this case yet
  end if;

  if v_terminal_leads = v_total_leads then
    -- Every contact on the case is lost or dead. 'lost' (an explicit
    -- "no") is more informative than 'dead' (cadence exhausted, no
    -- reply either way), so it wins the tie when both are present.
    select exists(select 1 from leads where case_id = p_case_id and stage = 'lost') into v_has_lost;
    update cases
    set status = case when v_has_lost then 'lost' else 'dead' end::case_status,
        wait_reason = null,
        updated_at = now()
    where id = p_case_id;
    return;
  end if;

  -- Not every contact is terminal. Pick whichever active contact has
  -- progressed furthest. Order mirrors LEAD_STAGE_RANK in
  -- src/lib/ui/status.ts -- keep both in sync, see that file's comment.
  select stage into v_primary
  from leads
  where case_id = p_case_id
    and stage in ('hot_handoff', 'in_conversation', 'contacted', 'writing', 'waiting')
  order by array_position(
    array['hot_handoff', 'in_conversation', 'contacted', 'writing', 'waiting']::lead_stage[],
    stage
  )
  limit 1;

  if v_primary is null then
    -- No contact has started outreach yet (all null), or the only
    -- contacts with a stage are a terminal minority alongside
    -- not-yet-started siblings. Leave the case's current pre-outreach
    -- status (new/researching/ready) exactly as the discovery pipeline
    -- set it -- there's nothing new to report yet.
    return;
  end if;

  update cases
  -- lead_stage and case_status are separate enum types even though these
  -- labels are spelled the same in both -- Postgres has no implicit
  -- cross-enum cast, so this has to go through text.
  set status = v_primary::text::case_status,
      wait_reason = case when v_primary = 'waiting' then (
        select wait_reason from leads
        where case_id = p_case_id and stage = 'waiting' and wait_reason is not null
        -- Most-actionable-for-a-human first: an approval sitting in
        -- /inbox beats a resend that clears itself, which beats a cap
        -- that clears itself tomorrow.
        order by array_position(
          array['awaiting_manual_approval', 'awaiting_resend', 'daily_cap']::case_wait_reason[],
          wait_reason
        )
        limit 1
      ) else null end,
      updated_at = now()
  where id = p_case_id;
end;
$$;
```

`src/lib/db/cases.ts` gets a thin wrapper:

```ts
export async function recomputeCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<void> {
  const { error } = await supabase.rpc('recompute_case_status', { p_case_id: caseId })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to recompute case status', { caseId, cause: error.message })
  }
}
```

`src/lib/db/leads.ts` gets the per-contact write it's been missing:

```ts
export async function updateLeadStage(
  supabase: SupabaseClient<Database>,
  leadId: string,
  stage: LeadStage,
  waitReason: CaseWaitReason | null = null,
): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ stage, wait_reason: waitReason, updated_at: new Date().toISOString() })
    .eq('id', leadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update lead stage', { leadId, stage, cause: error.message })
  }
}
```

## 3. Call-site changes

Every place that writes `cases.status`/`wait_reason` off a single contact's event switches to: write that one contact's `leads.stage` (+`wait_reason` if `waiting`), then call `recomputeCaseStatus`. None of these decide the case's status themselves anymore.

- **`write.ts` (`runWriteForCase`)** — inside the leads loop, each outcome (`sent`/`drafted`/`waiting`/`skipped`) writes that lead's `stage` (`contacted`/`writing`/`waiting`, `skipped` leaves it untouched) instead of being tallied for a post-loop case-wide branch. **One `recomputeCaseStatus` call after the loop finishes**, not per-lead — calling it per-lead would let a mid-run recompute prematurely overwrite the `claimCaseForWriting` lock's `'writing'` value off partial information from a still-in-progress run.
- **`reply.ts` (`runReplyForInbound`)** — `updateLeadStage(inbound.lead_id, 'in_conversation')` replaces the unconditional case-wide `in_conversation` write; the intent-based follow-up (`'price'` → `hot_handoff`, `'not_interested'` → `lost`) becomes `updateLeadStage(inbound.lead_id, ...)`. `recomputeCaseStatus(inbound.case_id)` after.
- **`followup.ts` (`runFollowupStep`)** — sequence exhaustion becomes `updateLeadStage(sequence.lead_id, 'dead')` + `recomputeCaseStatus(sequence.case_id)`, replacing the direct `updateCaseStatus(sequence.case_id, 'dead')`.
- **`inbox/actions.ts` (`approveDraft`)** — `updateLeadStage(email.lead_id, 'contacted')` + `recomputeCaseStatus(email.case_id)` replaces `claimCaseContacted`.
- **`cases/[id]/send-actions.ts` (`finalizeManualSend`)** — same pattern, replaces `claimCaseContactedFrom`.
- **`resend-failed.ts`** — the drain sweep's per-resend outcome (`contacted` on success, `dead` on final-step exhaustion) becomes `updateLeadStage` + `recomputeCaseStatus`, scoped to the one lead being resent.

Unaffected, by design:
- `claimCaseForWriting`'s `'writing'` claim-lock — this is a dispatch lock on the case row (only one write-fanout run may hold it at a time), not a progress signal. It keeps writing `cases.status` directly.
- Case-only wait reasons (`mailreach_gate`, `no_healthy_mailbox`, `no_viable_leads`) — still written directly via `updateCaseWaiting`, since they're not about any one contact.
- A human clicking "Mark Won" — still writes `cases.status = 'won'` directly; `recompute_case_status`'s guard (§2) keeps it from being walked back.

## 4. Backfill

No history exists to derive real per-contact stages from, so cutover is a one-time best-guess: every lead currently attached to a case whose `status` is not `new`/`researching`/`ready` (i.e. outreach has already begun) gets `stage` set from its case's current status where that status has a direct `lead_stage` counterpart; `won` backfills to `hot_handoff` (closest available proxy — the deal reached serious conversation before closing). From cutover forward, every contact's stage is tracked for real.

```sql
-- supabase/migrations/0055_backfill_lead_stage.sql
update leads l
set stage = case c.status
  when 'won' then 'hot_handoff'
  else c.status::text::lead_stage
end,
wait_reason = case when c.status = 'waiting' then c.wait_reason else null end
from cases c
where l.case_id = c.id
  and c.status not in ('new', 'researching', 'ready')
  and l.stage is null;
```

## 5. UI changes

- **Case detail page** (`cases/[id]/page.tsx`) — each contact gets a real stage pill (`LEAD_STAGE[lead.stage]`), alongside the existing `email_status` (deliverability) pill, which is a different thing and stays as-is.
- **Kanban** (`crm/page.tsx`) — the board still buckets a case into one column via `cases.status` (now the computed rollup). The card itself renders every distinct stage present among the case's contacts as a badge, most-positive first, using the same `LEAD_STAGE_RANK` order as the SQL function. Fetched with one aggregate query alongside the visible cases, not N+1:
  ```sql
  select case_id, stage, count(*) from leads
  where case_id = any($1) and stage is not null
  group by case_id, stage
  ```
  A small, pure, unit-testable function (`buildStageBadges(stages: LeadStage[]): LeadStage[]`) turns that into the ordered, terminal-suppressed badge list per card — same filtering rule as §2 (badges exclude `lost`/`dead` unless every contact on the case is terminal).

## 6. Error handling

`recomputeCaseStatus` failing after a successful `updateLeadStage` must not be swallowed — a stale case status is exactly the bug this design fixes. Every call site treats a recompute failure as a real error (thrown `AppError`, escalated to Sentry, the pipeline step retried on its normal cadence), not a best-effort side note.

## 7. Testing plan

- `recompute_case_status`: integration tests against a real Postgres instance (per project convention for RPC-backed logic) — every branch: no leads, all-null (no-op), mixed active stages (primary selection + tie-break), all-terminal (`lost` vs `dead` tie-break), `won` guard, `waiting` reason tie-break, and a concurrency test asserting two simultaneous calls for the same case serialize rather than lose an update.
- `updateLeadStage`: unit test, mirrors `updateCaseStatus`'s existing tests.
- `buildStageBadges`: unit tests, 100% branch coverage per `QUALITY.md` (pure function) — ordering, terminal suppression, empty input.
- `write.ts`, `reply.ts`, `followup.ts`, `approveDraft`, `finalizeManualSend`, `resend-failed.ts`: existing tests updated to assert `updateLeadStage` + `recomputeCaseStatus` calls in place of the direct `updateCaseStatus`/`claimCaseContacted*` calls they replace.
- Full suite + `tsc --noEmit` + `eslint` at each step, per project standard.

## 8. Rollout order

1. Migrations: `lead_stage` enum + columns (0053), `recompute_case_status` function (0054), backfill (0055) — three separate files/transactions, same reasoning as 0049/0050's split (`ALTER TYPE ... ADD VALUE` and anything referencing the new value can't share a transaction).
2. `updateLeadStage`, `recomputeCaseStatus` — small, independently testable primitives.
3. `write.ts` swap (highest-traffic path, most existing test coverage to lean on).
4. `reply.ts`, `followup.ts` swaps.
5. `inbox/actions.ts`, `cases/[id]/send-actions.ts`, `resend-failed.ts` swaps.
6. UI: case detail per-contact pill, kanban badges + aggregate query.
7. Retire now-dead code: `claimCaseContacted`/`claimCaseContactedFrom` once every caller has moved to `recomputeCaseStatus`.

## Open risks / edge cases

- A contact whose sequence exhausts (`dead`) while a sibling on the same case hasn't started outreach yet (`stage` still null) does **not** flip the case to `dead` — `v_total_leads = v_terminal_leads` fails since the null-stage sibling isn't counted as terminal, but it also isn't `'active'`, so the case is left untouched (§2, `v_primary is null` branch) rather than showing something new. Acceptable: nothing meaningful has actually happened for the case as a whole yet.
- `recompute_case_status` can legitimately run mid-write-loop if a genuinely concurrent event (a reply, an approval) touches a different lead on the same case while `write.ts` is still processing others. The row lock prevents corruption, but the case's displayed status can be transiently based on partial information until `write.ts`'s own post-loop recompute call corrects it — a few seconds of staleness, not a wrong permanent value. Matches the system's existing eventual-accuracy character; not worth a stronger guarantee at this scope.
