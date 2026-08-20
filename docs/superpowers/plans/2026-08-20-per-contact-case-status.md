# Per-Contact Case Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each contact (`leads` row) on a case its own real progress field (`stage`/`wait_reason`), and turn `cases.status`/`wait_reason` from something pipeline code writes directly into a computed rollup over all of a case's contacts — fixing the class of bugs where one contact's event (a reply, a cap-blocked send, an exhausted sequence) silently overwrites the true state of every other contact on the same case.

**Architecture:** New `leads.stage`/`leads.wait_reason` columns are the real per-contact source of truth. A single Postgres function, `recompute_case_status`, is the only place the rollup rule lives — row-locked so concurrent callers for the same case serialize instead of racing. Every pipeline stage that currently writes `cases.status` off one contact's event (`write.ts`, `reply.ts`, `followup.ts`, `approveDraft`, `finalizeManualSend`, `resend-failed.ts`) switches to writing that one contact's stage, then calling the shared recompute. `won` stays a manual, human-only action the recompute function never touches.

**Tech Stack:** Next.js Server Actions, Supabase/PostgreSQL (`@supabase/supabase-js`), Vitest (`vitest run` for unit tests, `vitest run --config vitest.integration.config.ts` for integration tests against a local `supabase start`).

**Spec:** [docs/superpowers/specs/2026-08-20-per-contact-case-status-design.md](../specs/2026-08-20-per-contact-case-status-design.md)

**Corrections made while planning** (found by reading the exact current code, not visible at spec time — noted here since the spec doesn't reflect them):
- The spec's `lead_stage` included `'writing'`. No real call site ever sets a lead's outcome to "still writing" — `processLead` in `write.ts` always knows the final per-lead outcome (`sent`/`drafted`/`waiting`/`skipped`) by the time it can write a stage, so `'writing'` would be dead, untested enum territory. Dropped from the enum (YAGNI). `cases.status`'s own `'writing'` value is untouched — it's `claimCaseForWriting`'s dispatch lock, unrelated to this rollup.
- `recompute_case_status` returns `(status, did_change)` instead of `void` — every call site needs to know whether the status actually changed before firing `enqueueCrmSync`, matching every existing call site's own "only sync on a real transition" guard (`claimCaseContacted`'s atomic claim, `resend-failed.ts`'s `if (kase.status !== 'contacted')`, etc.). Without this, the redesign would either lose that guard or reintroduce a read-then-write race outside the atomic function.
- `updateLeadStage` takes a discriminated-union parameter (`{ stage: 'waiting'; waitReason }` vs `{ stage: Exclude<LeadStage, 'waiting'> }`) instead of an optional reason argument, so passing a reason for a non-`'waiting'` stage — or omitting one for `'waiting'` — is a compile error, not a constraint violation caught at runtime.
- The spec called `/crm` a "kanban" needing a new aggregate badge query. It's actually a flat, single-status-pill row list (`src/app/(app)/crm/page.tsx` → `CaseRow`), and it already loads full lead rows per case in one query (`listCasesWithLeads`'s `select('*, leads(*)')`). No new query is needed — `stage` rides along automatically once the column exists.

## Global Constraints

- `strict: true` TypeScript, no `any`, no `!` non-null assertion without a comment proving it's safe.
- Every DB write throws `AppError` — never let a raw Supabase/Postgres error escape `lib/db/*`.
- Every catch block handles, rethrows, or escalates — never swallows silently.
- `CREATE TYPE`/`CREATE OR REPLACE FUNCTION` are fine to share a migration file with other statements (unlike `ALTER TYPE ... ADD VALUE`, which cannot share a transaction with anything referencing the new value — not a concern here since `lead_stage` is a brand-new type, not an added value on an existing one).
- `recompute_case_status` must never modify a case whose `status` is already `'won'`.
- Both UI surfaces touched (`/crm`, `/cases/[id]`) are operator-only — no `next-intl` / `src/messages/*.json` work needed (CLAUDE.md: translate only client-facing surfaces).
- TDD throughout: write the failing test, watch it fail, implement, watch it pass. Run `npx tsc --noEmit` + `npx eslint .` + `npx vitest run` before every commit; run `npx vitest run --config vitest.integration.config.ts` (needs `supabase start` running locally, per Task 2) before commits that touch a migration or an integration test.

---

## Task 1: `lead_stage` schema — enum, columns, constraint, generated types

**Files:**
- Create: `supabase/migrations/0053_lead_stage.sql`
- Modify: `src/types/database.ts`

**Interfaces:**
- Produces: `lead_stage` enum (`'waiting' | 'contacted' | 'in_conversation' | 'hot_handoff' | 'lost' | 'dead'`); `leads.stage: LeadStage | null`; `leads.wait_reason: CaseWaitReason | null`. Every later task depends on this.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0053_lead_stage.sql

-- Per-contact progress -- the piece that's been missing (see
-- docs/superpowers/specs/2026-08-20-per-contact-case-status-design.md).
-- Deliberately a subset of case_status: 'new'/'researching'/'ready' are
-- pre-outreach, company-level research phases with no per-contact meaning
-- yet (leads.stage stays null until a pipeline stage first has a real
-- per-lead outcome); 'won' is a human decision made on the case itself,
-- never derived from a contact's reply -- see recompute_case_status
-- (0054), which must never touch a case already 'won'.
create type lead_stage as enum (
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
-- adjusted for stage being nullable (a lead that hasn't started outreach
-- yet has both columns null). coalesce(..., false) avoids the
-- three-valued-logic trap of comparing a nullable boolean straight
-- against a NOT NULL check.
alter table leads add constraint leads_wait_reason_matches_stage
  check (coalesce(stage = 'waiting', false) = (wait_reason is not null));
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx supabase db reset`
Expected: every existing migration plus `0053_lead_stage.sql` applies with no errors.

- [ ] **Step 3: Update generated types**

In `src/types/database.ts`, in the `Enums` block, add `lead_stage` right after `lead_status`:

```ts
      lead_email_status: 'unverified' | 'verified' | 'invalid' | 'risky' | 'not_found'
      lead_status: 'new' | 'parked' | 'active'
      lead_stage: 'waiting' | 'contacted' | 'in_conversation' | 'hot_handoff' | 'lost' | 'dead'
      case_status:
```

In the `leads` table's `Row` block, add `stage`/`wait_reason` right after `status`:

```ts
          status: Database['public']['Enums']['lead_status']
          stage: Database['public']['Enums']['lead_stage'] | null
          wait_reason: Database['public']['Enums']['case_wait_reason'] | null
          created_at: string
          updated_at: string
```

In the `leads` table's `Insert` block, same position:

```ts
          status?: Database['public']['Enums']['lead_status']
          stage?: Database['public']['Enums']['lead_stage'] | null
          wait_reason?: Database['public']['Enums']['case_wait_reason'] | null
          created_at?: string
          updated_at?: string
```

(`Update` is `Partial<Database['public']['Tables']['leads']['Insert']>` already — no manual change needed there.)

- [ ] **Step 4: Verify the type change compiles**

Run: `npx tsc --noEmit`
Expected: no new errors — nothing references `stage`/`wait_reason`/`lead_stage` yet.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0053_lead_stage.sql src/types/database.ts
git commit -m "feat(db): add leads.stage and leads.wait_reason columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `recompute_case_status` — the rollup function

**Files:**
- Create: `supabase/migrations/0054_recompute_case_status.sql`
- Modify: `src/types/database.ts`
- Create: `src/lib/db/recompute-case-status.integration.test.ts`

**Interfaces:**
- Consumes: `lead_stage` (Task 1).
- Produces: SQL function `recompute_case_status(p_case_id uuid) returns case_recompute_result` where `case_recompute_result = (status case_status, did_change boolean)`. Consumed by Task 5's TypeScript wrapper.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0054_recompute_case_status.sql

-- The one place the case-level rollup rule lives. Every pipeline stage
-- that used to write cases.status directly off one contact's event now
-- writes that contact's leads.stage and calls this instead. Row-locks the
-- case first so two concurrent callers for the same case (e.g. a reply
-- landing for lead A while write.ts is still finishing lead B) serialize
-- their read-compute-write instead of interleaving it -- the same class
-- of race this whole redesign exists to close.
create type case_recompute_result as (
  status case_status,
  did_change boolean
);

create or replace function recompute_case_status(p_case_id uuid)
returns case_recompute_result
language plpgsql
as $$
declare
  v_current_status  case_status;
  v_total_leads     int;
  v_terminal_leads  int;
  v_has_lost        boolean;
  v_primary         lead_stage;
  v_new_status      case_status;
  v_new_wait_reason case_wait_reason;
  v_result          case_recompute_result;
begin
  select status into v_current_status from cases where id = p_case_id for update;
  if v_current_status is null then
    v_result.did_change := false;
    return v_result; -- case not found -- caller's own FK guarantees this shouldn't happen
  end if;

  -- 'won' is a human decision, made on the case, never derived from a
  -- contact's stage. Recompute must never walk it back.
  if v_current_status = 'won' then
    v_result.status := v_current_status;
    v_result.did_change := false;
    return v_result;
  end if;

  select count(*), count(*) filter (where stage in ('lost', 'dead'))
    into v_total_leads, v_terminal_leads
  from leads
  where case_id = p_case_id;

  if v_total_leads = 0 then
    v_result.status := v_current_status;
    v_result.did_change := false;
    return v_result;
  end if;

  if v_terminal_leads = v_total_leads then
    -- Every contact on the case is lost or dead. 'lost' (an explicit "no")
    -- is more informative than 'dead' (cadence exhausted, no reply either
    -- way), so it wins the tie when both are present.
    select exists(select 1 from leads where case_id = p_case_id and stage = 'lost') into v_has_lost;
    v_new_status := case when v_has_lost then 'lost' else 'dead' end::case_status;
    update cases set status = v_new_status, wait_reason = null, updated_at = now() where id = p_case_id;
    v_result.status := v_new_status;
    v_result.did_change := v_new_status is distinct from v_current_status;
    return v_result;
  end if;

  -- Not every contact is terminal. Pick whichever active contact has
  -- progressed furthest. Order mirrors ACTIVE_STAGE_RANK in
  -- src/lib/ui/lead-stage-badges.ts -- keep both in sync.
  select stage into v_primary
  from leads
  where case_id = p_case_id
    and stage in ('hot_handoff', 'in_conversation', 'contacted', 'waiting')
  order by array_position(
    array['hot_handoff', 'in_conversation', 'contacted', 'waiting']::lead_stage[],
    stage
  )
  limit 1;

  if v_primary is null then
    -- No contact has started outreach yet (all null), or the only
    -- contacts with a stage are a terminal minority alongside
    -- not-yet-started siblings. Leave the case's current pre-outreach
    -- status (new/researching/ready) exactly as the discovery pipeline
    -- set it -- there's nothing new to report yet.
    v_result.status := v_current_status;
    v_result.did_change := false;
    return v_result;
  end if;

  -- lead_stage and case_status are separate enum types even though these
  -- labels are spelled the same in both -- Postgres has no implicit
  -- cross-enum cast, so this has to go through text.
  v_new_status := v_primary::text::case_status;
  v_new_wait_reason := case when v_primary = 'waiting' then (
    select wait_reason from leads
    where case_id = p_case_id and stage = 'waiting' and wait_reason is not null
    -- Most-actionable-for-a-human first: an approval sitting in /inbox
    -- beats a resend that clears itself, which beats a cap that clears
    -- itself tomorrow.
    order by array_position(
      array['awaiting_manual_approval', 'awaiting_resend', 'daily_cap']::case_wait_reason[],
      wait_reason
    )
    limit 1
  ) else null end;

  update cases
  set status = v_new_status, wait_reason = v_new_wait_reason, updated_at = now()
  where id = p_case_id;

  v_result.status := v_new_status;
  v_result.did_change := v_new_status is distinct from v_current_status;
  return v_result;
end;
$$;
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx supabase db reset`
Expected: `0054_recompute_case_status.sql` applies with no errors.

- [ ] **Step 3: Update generated types**

In `src/types/database.ts`, find the `Functions:` block (it already has an entry for `find_stuck_cases`, called from `listStuckCases` in `src/lib/db/cases.ts` — match its exact formatting) and add:

```ts
      recompute_case_status: {
        Args: { p_case_id: string }
        Returns: {
          status: Database['public']['Enums']['case_status']
          did_change: boolean
        }
      }
```

- [ ] **Step 4: Write the integration test**

```ts
// src/lib/db/recompute-case-status.integration.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Integration test: runs against local `supabase start`. Verifies
// recompute_case_status (supabase/migrations/0054_recompute_case_status.sql)
// directly via RPC, independent of the TypeScript wrapper added in Task 5.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

let clientId = ''
let campaignId = ''

beforeAll(async () => {
  const { data: client, error: clientErr } = await admin.from('clients')
    .insert({ name: `Recompute Test Client ${Date.now()}` }).select('id').single()
  if (clientErr || !client) throw new Error(`clients insert failed: ${clientErr?.message}`)
  clientId = client.id

  const { data: campaign, error: campaignErr } = await admin.from('campaigns')
    .insert({ client_id: clientId, name: 'Recompute Test Campaign' }).select('id').single()
  if (campaignErr || !campaign) throw new Error(`campaigns insert failed: ${campaignErr?.message}`)
  campaignId = campaign.id
}, 30_000)

async function createCase(status: Database['public']['Enums']['case_status']): Promise<string> {
  const { data, error } = await admin.from('cases')
    .insert({
      client_id: clientId, campaign_id: campaignId, company_name: 'Recompute Co',
      company_key: `recompute-${Date.now()}-${Math.random()}`, status,
    })
    .select('id').single()
  if (error || !data) throw new Error(`cases insert failed: ${error?.message}`)
  return data.id
}

async function createLead(
  caseId: string,
  stage: Database['public']['Enums']['lead_stage'] | null,
  waitReason: Database['public']['Enums']['case_wait_reason'] | null = null,
): Promise<string> {
  const { data, error } = await admin.from('leads')
    .insert({
      client_id: clientId, campaign_id: campaignId, case_id: caseId,
      full_name: 'Recompute Lead', stage, wait_reason: waitReason,
    })
    .select('id').single()
  if (error || !data) throw new Error(`leads insert failed: ${error?.message}`)
  return data.id
}

async function recompute(caseId: string) {
  const { data, error } = await admin.rpc('recompute_case_status', { p_case_id: caseId })
  if (error) throw new Error(`recompute_case_status failed: ${error.message}`)
  return data
}

describe('recompute_case_status (migration 0054)', () => {
  it('should no-op when no lead on the case has a stage yet', async () => {
    const caseId = await createCase('ready')
    await createLead(caseId, null)
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'ready', did_change: false })
  })

  it('should pick the highest-ranked active stage among mixed contacts', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'waiting', 'awaiting_manual_approval')
    await createLead(caseId, 'in_conversation')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'in_conversation', did_change: true })
  })

  it('should carry the waiting reason from the waiting lead when waiting is the primary stage', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'waiting', 'daily_cap')
    const { data: kase, error } = await admin.from('cases').select('wait_reason').eq('id', caseId).single()
    await recompute(caseId)
    const { data: after } = await admin.from('cases').select('wait_reason').eq('id', caseId).single()
    expect(error).toBeNull()
    expect(kase?.wait_reason).toBeNull()
    expect(after?.wait_reason).toBe('daily_cap')
  })

  it('should not mark the case terminal while any contact has not started', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'dead')
    await createLead(caseId, null)
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'writing', did_change: false })
  })

  it('should mark the case dead only once every contact is terminal, with no lost among them', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'dead')
    await createLead(caseId, 'dead')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'dead', did_change: true })
  })

  it('should prefer lost over dead when the case is fully terminal and mixed', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'lost')
    await createLead(caseId, 'dead')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'lost', did_change: true })
  })

  it('should never modify a case already won', async () => {
    const caseId = await createCase('won')
    await createLead(caseId, 'dead')
    await createLead(caseId, 'dead')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'won', did_change: false })
    const { data: after } = await admin.from('cases').select('status').eq('id', caseId).single()
    expect(after?.status).toBe('won')
  })

  it('should report did_change: false when recomputing lands on the same status again', async () => {
    const caseId = await createCase('contacted')
    await createLead(caseId, 'contacted')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'contacted', did_change: false })
  })
})
```

- [ ] **Step 5: Run the integration test**

Run: `npx supabase start` (if not already running), then `npx vitest run --config vitest.integration.config.ts src/lib/db/recompute-case-status.integration.test.ts`
Expected: all 8 cases PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0054_recompute_case_status.sql src/types/database.ts src/lib/db/recompute-case-status.integration.test.ts
git commit -m "feat(db): add recompute_case_status, the case-status rollup function

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Backfill existing leads

**Files:**
- Create: `supabase/migrations/0055_backfill_lead_stage.sql`

**Interfaces:**
- Consumes: `lead_stage`, `leads.stage`/`wait_reason` (Task 1).
- Produces: every existing lead on a case whose outreach has already begun gets a best-guess `stage` — nothing downstream depends on this beyond correctness of existing data.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0055_backfill_lead_stage.sql

-- One-time best-guess backfill: no history exists to derive real
-- per-contact stages from, so every lead on a case whose outreach has
-- already begun gets its case's CURRENT status as a starting point.
-- 'new'/'researching'/'ready'/'writing' are excluded -- the first three
-- have no lead_stage counterpart (pre-outreach, case-level only), and
-- 'writing' is claimCaseForWriting's dispatch lock, not a committed
-- per-lead outcome, so casting it directly would either fail (no
-- 'writing' label in lead_stage) or misrepresent a lead that may not
-- have been touched yet. 'won' has no lead_stage counterpart either --
-- backfills to 'hot_handoff', the closest available proxy (the deal
-- reached serious conversation before closing). From this migration
-- forward, every contact's stage is tracked for real via
-- recompute_case_status (0054), not backfilled again.
update leads l
set stage = case c.status
  when 'won' then 'hot_handoff'
  else c.status::text::lead_stage
end,
wait_reason = case when c.status = 'waiting' then c.wait_reason else null end
from cases c
where l.case_id = c.id
  and c.status not in ('new', 'researching', 'ready', 'writing')
  and l.stage is null;
```

- [ ] **Step 2: Apply the migration locally**

Run: `npx supabase db reset`
Expected: `0055_backfill_lead_stage.sql` applies with no errors (a fresh local reset has no pre-existing case/lead data from before this migration set, so this step should affect 0 rows against a clean local DB — that's expected and correct; the statement's correctness against real data is verified next).

- [ ] **Step 3: Verify the backfill logic against seeded rows**

This is a one-time data migration, not a reusable function, so it isn't covered by an automated regression test the way Task 2's function is — verify it manually against representative data before this migration ever runs against a database with real rows. Get the local DB connection string:

Run: `npx supabase status` (note the `DB URL` line, e.g. `postgresql://postgres:postgres@127.0.0.1:54322/postgres`)

Then, with `psql` (or any Postgres client) connected to that URL, insert a representative case+lead pair for each `case_status` value this migration handles, confirm the backfill statement produces the expected `lead_stage`/`wait_reason`, then roll back:

```sql
begin;
insert into clients (id, name) values ('00000000-0000-0000-0000-000000000001', 'Backfill Check');
insert into campaigns (id, client_id, name) values ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Backfill Check');
insert into cases (id, client_id, campaign_id, company_name, company_key, status, wait_reason)
  values ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'Backfill Co', 'backfill-check', 'waiting', 'daily_cap');
insert into leads (id, client_id, campaign_id, case_id, full_name)
  values ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'Backfill Lead');

-- Re-run the migration's UPDATE statement here (copy from 0055 verbatim), then:
select stage, wait_reason from leads where id = '00000000-0000-0000-0000-000000000004';
-- Expected: stage = 'waiting', wait_reason = 'daily_cap'

rollback;
```

Repeat with `status = 'won'` (expect `stage = 'hot_handoff'`, `wait_reason = null`) and `status = 'writing'` (expect `stage` still `null` — excluded).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0055_backfill_lead_stage.sql
git commit -m "feat(db): backfill leads.stage from each case's current status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `updateLeadStage` (`src/lib/db/leads.ts`)

**Files:**
- Modify: `src/lib/db/leads.ts`
- Create: `src/lib/db/leads.test.ts` (if it doesn't already exist — check first; if it does, add the new `describe` block to it)

**Interfaces:**
- Consumes: `lead_stage`, `leads.stage`/`wait_reason` (Task 1).
- Produces: `updateLeadStage(supabase, leadId, update): Promise<void>` and exported types `LeadStage`, `LeadStageUpdate`. Consumed by Tasks 6-11.

- [ ] **Step 1: Write the failing tests**

```ts
// Add to src/lib/db/leads.test.ts
import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { updateLeadStage } from './leads'

function mockSupabaseForUpdate(result: { error: unknown }) {
  const calls: { table: string; payload: unknown; leadId: string }[] = []
  return {
    client: {
      from: (table: string) => ({
        update: (payload: unknown) => ({
          eq: (_column: string, leadId: string) => {
            calls.push({ table, payload, leadId })
            return Promise.resolve(result)
          },
        }),
      }),
    } as never,
    calls,
  }
}

describe('updateLeadStage', () => {
  it('should write the stage with a null wait_reason for a non-waiting stage', async () => {
    const { client, calls } = mockSupabaseForUpdate({ error: null })
    await updateLeadStage(client, 'lead-1', { stage: 'contacted' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.table).toBe('leads')
    expect(calls[0]?.leadId).toBe('lead-1')
    expect(calls[0]?.payload).toMatchObject({ stage: 'contacted', wait_reason: null })
  })

  it('should write the stage and reason for a waiting stage', async () => {
    const { client, calls } = mockSupabaseForUpdate({ error: null })
    await updateLeadStage(client, 'lead-2', { stage: 'waiting', waitReason: 'awaiting_resend' })
    expect(calls[0]?.payload).toMatchObject({ stage: 'waiting', wait_reason: 'awaiting_resend' })
  })

  it('should throw AppError when the update fails', async () => {
    const { client } = mockSupabaseForUpdate({ error: { message: 'boom' } })
    await expect(
      updateLeadStage(client, 'lead-3', { stage: 'lost' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/db/leads.test.ts -t updateLeadStage`
Expected: FAIL — `updateLeadStage` is not exported from `./leads`.

- [ ] **Step 3: Implement `updateLeadStage`**

Add to `src/lib/db/leads.ts` (near the other single-row update functions, e.g. after `parkLead`):

```ts
export type LeadStage = Database['public']['Enums']['lead_stage']

// Discriminated on purpose: passing a wait reason for a non-'waiting'
// stage, or omitting one for 'waiting', is a compile error here rather
// than a constraint violation caught at write time (leads_wait_reason_
// matches_stage, migration 0053).
export type LeadStageUpdate =
  | { stage: 'waiting'; waitReason: CaseWaitReason }
  | { stage: Exclude<LeadStage, 'waiting'> }

// The per-contact write every pipeline stage now makes instead of writing
// cases.status directly -- see recompute_case_status (migration 0054) and
// docs/superpowers/specs/2026-08-20-per-contact-case-status-design.md.
export async function updateLeadStage(
  supabase: SupabaseClient<Database>,
  leadId: string,
  update: LeadStageUpdate,
): Promise<void> {
  const waitReason = update.stage === 'waiting' ? update.waitReason : null
  const { error } = await supabase
    .from('leads')
    .update({ stage: update.stage, wait_reason: waitReason, updated_at: new Date().toISOString() })
    .eq('id', leadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update lead stage', { leadId, stage: update.stage, cause: error.message })
  }
}
```

`leads.ts` needs `CaseWaitReason` in scope — add a type-only import at the top of the file: `import type { CaseWaitReason } from '@/lib/db/cases'`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/db/leads.test.ts -t updateLeadStage`
Expected: PASS.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/db/leads.ts src/lib/db/leads.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat(db): add updateLeadStage

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `recomputeCaseStatus` + `CRM_SYNC_STATUSES` (`src/lib/db/cases.ts`)

**Files:**
- Modify: `src/lib/db/cases.ts`
- Modify: `src/lib/db/cases.test.ts`

**Interfaces:**
- Consumes: `recompute_case_status` RPC (Task 2).
- Produces: `recomputeCaseStatus(supabase, caseId): Promise<CaseRecomputeResult>` where `CaseRecomputeResult = { status: CaseStatus; didChange: boolean }`; `CRM_SYNC_STATUSES: readonly CaseStatus[]`. Consumed by Tasks 6-11.

- [ ] **Step 1: Write the failing tests**

```ts
// Add to src/lib/db/cases.test.ts
import { recomputeCaseStatus, CRM_SYNC_STATUSES } from './cases'

function mockRpcRecompute(result: { data: unknown; error: unknown }) {
  return { rpc: (...a: unknown[]) => { void a; return Promise.resolve(result) } } as never
}

describe('recomputeCaseStatus', () => {
  it('should return the status and didChange from the RPC', async () => {
    const result = await recomputeCaseStatus(
      mockRpcRecompute({ data: { status: 'contacted', did_change: true }, error: null }),
      'case-1',
    )
    expect(result).toEqual({ status: 'contacted', didChange: true })
  })

  it('should return didChange: false when the RPC reports no change', async () => {
    const result = await recomputeCaseStatus(
      mockRpcRecompute({ data: { status: 'won', did_change: false }, error: null }),
      'case-2',
    )
    expect(result).toEqual({ status: 'won', didChange: false })
  })

  it('should throw DB_ERROR when the RPC errors', async () => {
    await expect(
      recomputeCaseStatus(mockRpcRecompute({ data: null, error: { message: 'boom' } }), 'case-3'),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the RPC returns no row', async () => {
    await expect(
      recomputeCaseStatus(mockRpcRecompute({ data: null, error: null }), 'case-4'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('CRM_SYNC_STATUSES', () => {
  it('should include every status the CRM sync historically fired for', () => {
    expect(CRM_SYNC_STATUSES).toEqual(
      expect.arrayContaining(['contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead']),
    )
  })

  it('should exclude waiting, since no existing call site synced on it', () => {
    expect(CRM_SYNC_STATUSES).not.toContain('waiting')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/db/cases.test.ts -t recomputeCaseStatus`
Expected: FAIL — `recomputeCaseStatus`/`CRM_SYNC_STATUSES` not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/db/cases.ts` (near `listStuckCases`, the existing RPC-backed function):

```ts
// Every status an existing call site fired enqueueCrmSync for, before this
// redesign. Preserved exactly -- CRM sync traffic must not change shape as
// a side effect of centralizing the rollup rule.
export const CRM_SYNC_STATUSES: readonly CaseStatus[] = [
  'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead',
]

export interface CaseRecomputeResult {
  status: CaseStatus
  didChange: boolean
}

// The one place every pipeline stage now goes to update a case's status,
// instead of writing it directly -- see recompute_case_status (migration
// 0054) and docs/superpowers/specs/2026-08-20-per-contact-case-status-design.md.
// Callers must check didChange (paired with CRM_SYNC_STATUSES) before
// firing enqueueCrmSync -- recompute runs on every per-contact event, most
// of which don't actually move the case's summary status.
export async function recomputeCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CaseRecomputeResult> {
  const { data, error } = await supabase.rpc('recompute_case_status', { p_case_id: caseId })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to recompute case status', { caseId, cause: error.message })
  }
  if (!data) {
    throw new AppError('DB_ERROR', 'recompute_case_status returned no row', { caseId })
  }
  return { status: data.status, didChange: data.did_change }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/db/cases.test.ts -t recomputeCaseStatus`
Expected: PASS.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/db/cases.ts src/lib/db/cases.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/cases.ts src/lib/db/cases.test.ts
git commit -m "feat(db): add recomputeCaseStatus and CRM_SYNC_STATUSES

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `write.ts` integration

**Files:**
- Modify: `src/lib/pipeline/write.ts`
- Modify: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `updateLeadStage` (Task 4), `recomputeCaseStatus`/`CRM_SYNC_STATUSES` (Task 5).

- [ ] **Step 1: Update imports**

In `src/lib/pipeline/write.ts`, change:

```ts
import { listActiveLeadsForCase, type LeadRow } from '@/lib/db/leads'
```
to:
```ts
import { listActiveLeadsForCase, updateLeadStage, type LeadRow } from '@/lib/db/leads'
```

Change:
```ts
import { updateCaseStatus, updateCaseWaiting, type CaseWaitReason } from '@/lib/db/cases'
```
to:
```ts
import { updateCaseWaiting, recomputeCaseStatus, CRM_SYNC_STATUSES, type CaseWaitReason } from '@/lib/db/cases'
```

- [ ] **Step 2: Write a lead's stage inside `processLead`, at each real outcome**

In `processLead`, before `if (!shouldSendFirstTouch(input.replyMode)) return 'drafted'`, insert:

```ts
  if (!shouldSendFirstTouch(input.replyMode)) {
    await updateLeadStage(supabase, lead.id, { stage: 'waiting', waitReason: 'awaiting_manual_approval' })
    return 'drafted'
  }
```

In the `catch` block for the send attempt, after `await parkAsWaiting(supabase, claimed.id)`:

```ts
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await parkAsWaiting(supabase, claimed.id)
      await updateLeadStage(supabase, lead.id, { stage: 'waiting', waitReason: 'awaiting_resend' })
      return 'waiting'
    }
```

Before the final `return 'sent'` (after `scheduleFirstFollowup`):

```ts
  await scheduleFirstFollowup(supabase, {
    clientId: input.clientId,
    caseId: input.caseId,
    leadId: lead.id,
  })
  await updateLeadStage(supabase, lead.id, { stage: 'contacted' })
  return 'sent'
```

- [ ] **Step 3: Replace the post-loop case-status branch in `runWriteForCase`**

Replace:

```ts
  if (sent > 0) {
    await updateCaseStatus(supabase, input.caseId, 'contacted')
    await enqueueCrmSync(input.caseId, 'contacted')
  } else if (drafted > 0) {
    // human_approve, or hybrid's first-touch step — nothing sent yet, a
    // human owns the next move in /inbox. approveDraft is what eventually
    // advances this case to 'contacted'.
    await updateCaseWaiting(supabase, input.caseId, 'awaiting_manual_approval')
  } else if (waiting > 0) {
    // At least one lead's content is already committed and parked — the
    // drain sweep (not another write-fanout pass) is what sends it. Not in
    // AUTO_RETRY_WAIT_REASONS, so write-fanout never re-dispatches this case
    // over it.
    await updateCaseWaiting(supabase, input.caseId, 'awaiting_resend')
  } else {
    // Every active lead was permanently disqualified this attempt (missing
    // email, suppressed) — processLead checks suppression before
    // generation, so this path never paid for an LLM call either. Not
    // 'contacted' (never sent), and not left at 'writing' (would misread as
    // stuck and get endlessly re-queued by stuck-sweep for a condition that
    // won't change on its own). 'no_viable_leads' is deliberately excluded
    // from the auto-retry set — nothing about waiting 5 more minutes
    // changes a suppression list.
    //
    // (A narrower pre-existing imprecision: a lead skipped because a
    // concurrent write already claimed its step-0 slot also lands here,
    // same as it unconditionally became 'contacted' before this change —
    // not a new regression, and case-level write concurrency is out of
    // scope for this fix.)
    await updateCaseWaiting(supabase, input.caseId, 'no_viable_leads')
  }
```

with:

```ts
  if (sent > 0 || drafted > 0 || waiting > 0) {
    // Every real per-lead outcome above already wrote its own lead's
    // stage — this is the one recompute for the whole run, not one per
    // lead, so a concurrent event on a different lead of this case can't
    // read a partially-updated case mid-loop and prematurely overwrite the
    // claimCaseForWriting dispatch lock this run is still holding.
    const recompute = await recomputeCaseStatus(supabase, input.caseId)
    if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
      await enqueueCrmSync(input.caseId, recompute.status)
    }
  } else {
    // Every active lead was permanently disqualified this attempt (missing
    // email, suppressed) — processLead checks suppression before
    // generation, so this path never paid for an LLM call either. This is
    // a case-level condition ("no viable leads exist"), not any one lead's
    // stage — stays a direct write. Not 'contacted' (never sent), and not
    // left at 'writing' (would misread as stuck and get endlessly
    // re-queued by stuck-sweep for a condition that won't change on its
    // own). 'no_viable_leads' is deliberately excluded from the auto-retry
    // set — nothing about waiting 5 more minutes changes a suppression list.
    //
    // (A narrower pre-existing imprecision: a lead skipped because a
    // concurrent write already claimed its step-0 slot also lands here,
    // same as it unconditionally became 'contacted' before this change —
    // not a new regression, and case-level write concurrency is out of
    // scope for this fix.)
    await updateCaseWaiting(supabase, input.caseId, 'no_viable_leads')
  }
```

- [ ] **Step 4: Update `write.test.ts`**

`write.test.ts` mocks `@/lib/db/cases` (`updateCaseStatusMock`, `updateCaseWaitingMock`) and `@/lib/db/leads` (`listActiveLeadsMock`, among others). Extend both `vi.mock` blocks:

```ts
const updateLeadStageMock = vi.fn()
// ...alongside the existing listActiveLeadsMock declaration
vi.mock('@/lib/db/leads', () => ({
  listActiveLeadsForCase: (...a: unknown[]) => listActiveLeadsMock(...a),
  updateLeadStage: (...a: unknown[]) => updateLeadStageMock(...a),
}))
```

```ts
const recomputeCaseStatusMock = vi.fn()
vi.mock('@/lib/db/cases', () => ({
  updateCaseWaiting: (...a: unknown[]) => updateCaseWaitingMock(...a),
  recomputeCaseStatus: (...a: unknown[]) => recomputeCaseStatusMock(...a),
  CRM_SYNC_STATUSES: ['contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead'],
}))
```

Remove `updateCaseStatusMock` and its old `vi.mock` entry entirely — `write.ts` no longer imports `updateCaseStatus`.

In `beforeEach`, add a default resolved value: `recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: true })`.

Find every existing assertion of the form `expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), caseId, 'contacted')` (the `sent > 0` branch) and replace it with:

```ts
expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), leadId, { stage: 'contacted' })
expect(recomputeCaseStatusMock).toHaveBeenCalledWith(expect.anything(), caseId)
```

(substituting the actual `leadId`/`caseId` fixture values already used in that test). Add three new test cases:

```ts
it('should mark the sending lead contacted and recompute the case', async () => {
  listActiveLeadsMock.mockResolvedValue([{ id: 'lead-1', email: 'a@b.com', full_name: 'A' }])
  recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: true })
  await runWriteForCase({} as never, baseInput) // baseInput per existing fixture in this file
  expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), 'lead-1', { stage: 'contacted' })
  expect(enqueueCrmSyncMock).toHaveBeenCalledWith(baseInput.caseId, 'contacted')
})

it('should not enqueue a CRM sync when recompute reports no change', async () => {
  listActiveLeadsMock.mockResolvedValue([{ id: 'lead-1', email: 'a@b.com', full_name: 'A' }])
  recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: false })
  await runWriteForCase({} as never, baseInput)
  expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
})

it('should mark a drafted lead waiting on manual approval, not send it', async () => {
  listActiveLeadsMock.mockResolvedValue([{ id: 'lead-1', email: 'a@b.com', full_name: 'A' }])
  const draftInput = { ...baseInput, replyMode: 'human_approve' as const }
  await runWriteForCase({} as never, draftInput)
  expect(updateLeadStageMock).toHaveBeenCalledWith(
    expect.anything(), 'lead-1', { stage: 'waiting', waitReason: 'awaiting_manual_approval' },
  )
})
```

(`baseInput`, `enqueueCrmSyncMock`, and the exact claim/generation mock setup needed for a lead to reach the 'sent'/'drafted' outcome already exist in this file's fixtures — reuse them; adjust the two new tests' mock setup to match whatever this file's existing "successful send" test already arranges for `claimOutboundEmailMock`/`generateJsonMock`/`sendViaMailboxMock`, rather than re-deriving it.)

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/pipeline/write.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "refactor(pipeline): write.ts sets per-lead stage, recomputes case status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `reply.ts` integration

**Files:**
- Modify: `src/lib/pipeline/reply.ts`
- Modify: `src/lib/pipeline/reply.test.ts`

**Interfaces:**
- Consumes: `updateLeadStage` (Task 4), `recomputeCaseStatus`/`CRM_SYNC_STATUSES` (Task 5).

- [ ] **Step 1: Update imports**

Change:
```ts
import { getLeadById, type LeadRow } from '@/lib/db/leads'
```
to:
```ts
import { getLeadById, updateLeadStage, type LeadRow } from '@/lib/db/leads'
```

Change:
```ts
import { updateCaseStatus } from '@/lib/db/cases'
```
to:
```ts
import { recomputeCaseStatus, CRM_SYNC_STATUSES } from '@/lib/db/cases'
```

- [ ] **Step 2: Replace the unconditional pre-switch write with the intent's final stage**

Replace:

```ts
  // A reply always means we are in a conversation now.
  await updateCaseStatus(supabase, inbound.case_id, 'in_conversation')
  await enqueueCrmSync(inbound.case_id, 'in_conversation')

  switch (classification.intent) {
```

with:

```ts
  // A reply always moves this contact forward — price and not_interested
  // move it further still; every other intent lands on in_conversation,
  // matching the unconditional write this replaces. Computed once, up
  // front, so this contact's stage is only ever written its true final
  // value for this reply, never written to an intermediate value first.
  const finalStage: 'hot_handoff' | 'lost' | 'in_conversation' =
    classification.intent === 'price' ? 'hot_handoff'
      : classification.intent === 'not_interested' ? 'lost'
        : 'in_conversation'
  await updateLeadStage(supabase, inbound.lead_id, { stage: finalStage })
  const recompute = await recomputeCaseStatus(supabase, inbound.case_id)
  if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
    await enqueueCrmSync(inbound.case_id, recompute.status)
  }

  switch (classification.intent) {
```

- [ ] **Step 3: Remove the now-redundant per-branch case-status writes**

In the `'price'` case, remove:
```ts
      await updateCaseStatus(supabase, inbound.case_id, 'hot_handoff')
      await enqueueCrmSync(inbound.case_id, 'hot_handoff')
```
(the stage/recompute already happened in Step 2; the rest of the branch — `sendOrDraftReply`, `addSuppression`, `stopSequenceForLead`, `triggerCollisionNotice`, `logEventSafe`, `return` — is unchanged).

In the `'not_interested'` case, remove:
```ts
      await updateCaseStatus(supabase, inbound.case_id, 'lost')
      await enqueueCrmSync(inbound.case_id, 'lost')
```
(the rest of the branch — `addSuppression`, `stopSequenceForLead`, `logEventSafe`, `return` — is unchanged).

The `'question'`/`'interested'`/`'other'` branch had no case-status write of its own — unchanged.

- [ ] **Step 4: Update `reply.test.ts`**

Extend the `vi.mock('@/lib/db/leads', ...)` block to add `updateLeadStage`, and replace the `vi.mock('@/lib/db/cases', ...)` block's `updateCaseStatus` mock with `recomputeCaseStatus`/`CRM_SYNC_STATUSES`, following the exact same pattern as Task 6 Step 4. In `beforeEach`, default `recomputeCaseStatusMock.mockResolvedValue({ status: 'in_conversation', didChange: true })`.

Find the existing assertions checking `updateCaseStatusMock` was called with `'in_conversation'`/`'hot_handoff'`/`'lost'` and replace each with the matching `updateLeadStageMock` assertion:

```ts
// was: expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), inbound.case_id, 'hot_handoff')
expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), inbound.lead_id, { stage: 'hot_handoff' })
expect(recomputeCaseStatusMock).toHaveBeenCalledWith(expect.anything(), inbound.case_id)
```

Add:

```ts
it('should mark the lead in_conversation for a question intent, not hot_handoff or lost', async () => {
  classifyReplyMock.mockResolvedValue({
    intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null,
    replyBody: 'Here you go', attachResourceIds: [],
  })
  await runReplyForInbound({} as never, { emailId: 'email-1' })
  expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), expect.any(String), { stage: 'in_conversation' })
})

it('should not enqueue a CRM sync when recompute reports no change', async () => {
  recomputeCaseStatusMock.mockResolvedValue({ status: 'in_conversation', didChange: false })
  await runReplyForInbound({} as never, { emailId: 'email-1' })
  expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
})
```

(reusing this file's existing fixtures/mocks for `getEmailByIdMock`, `getLeadByIdMock`, `getCampaignForCaseMock`, etc. — every other lookup in `runReplyForInbound` needs its usual happy-path mock already present elsewhere in this file for the function to reach the classification step).

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/lib/pipeline/reply.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/reply.ts src/lib/pipeline/reply.test.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/reply.ts src/lib/pipeline/reply.test.ts
git commit -m "refactor(pipeline): reply.ts sets per-lead stage, recomputes case status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `followup.ts` integration

**Files:**
- Modify: `src/lib/pipeline/followup.ts`
- Modify: `src/lib/pipeline/followup.test.ts`

**Interfaces:**
- Consumes: `updateLeadStage` (Task 4), `recomputeCaseStatus`/`CRM_SYNC_STATUSES` (Task 5).

- [ ] **Step 1: Update imports**

Change:
```ts
import { getLeadById } from '@/lib/db/leads'
```
to:
```ts
import { getLeadById, updateLeadStage } from '@/lib/db/leads'
```

Change:
```ts
import { updateCaseStatus } from '@/lib/db/cases'
```
to:
```ts
import { recomputeCaseStatus, CRM_SYNC_STATUSES } from '@/lib/db/cases'
```

- [ ] **Step 2: Replace the exhaustion branch**

Replace:

```ts
  if (input.step >= maxStep) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, sequence.case_id, 'dead')
    await enqueueCrmSync(sequence.case_id, 'dead')
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }
```

with:

```ts
  if (input.step >= maxStep) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateLeadStage(supabase, sequence.lead_id, { stage: 'dead' })
    const recompute = await recomputeCaseStatus(supabase, sequence.case_id)
    if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
      await enqueueCrmSync(sequence.case_id, recompute.status)
    }
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }
```

- [ ] **Step 3: Update `followup.test.ts`**

Same mechanical change as Tasks 6-7: extend the `@/lib/db/leads` mock with `updateLeadStage`, replace the `@/lib/db/cases` mock's `updateCaseStatus` with `recomputeCaseStatus`/`CRM_SYNC_STATUSES`. Find the existing exhaustion test asserting `updateCaseStatusMock` was called with `'dead'` and replace with:

```ts
expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), sequence.lead_id, { stage: 'dead' })
expect(recomputeCaseStatusMock).toHaveBeenCalledWith(expect.anything(), sequence.case_id)
```

Add:

```ts
it('should not enqueue a CRM sync when recompute reports the case is not yet fully dead', async () => {
  recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: false })
  // ...reuse this file's existing final-step fixture setup that reaches the exhaustion branch
  await runFollowupStep({} as never, { sequenceId: 'seq-1', step: maxStepFixture })
  expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/pipeline/followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts
git commit -m "refactor(pipeline): followup.ts sets per-lead stage, recomputes case status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: `approveDraft` integration (`src/app/(app)/inbox/actions.ts`)

**Files:**
- Modify: `src/app/(app)/inbox/actions.ts`
- Modify: `src/app/(app)/inbox/actions.test.ts` (if present under a different path, e.g. co-located per-file test — locate via `find src/app/\(app\)/inbox -name '*.test.ts'` and adjust the path in this task accordingly)

**Interfaces:**
- Consumes: `updateLeadStage` (Task 4), `recomputeCaseStatus`/`CRM_SYNC_STATUSES` (Task 5).

- [ ] **Step 1: Update imports**

Change:
```ts
import { getLeadById } from '@/lib/db/leads'
```
to:
```ts
import { getLeadById, updateLeadStage } from '@/lib/db/leads'
```

Change:
```ts
import { claimCaseContacted, updateCaseWaiting } from '@/lib/db/cases'
```
to:
```ts
import { recomputeCaseStatus, CRM_SYNC_STATUSES } from '@/lib/db/cases'
```

- [ ] **Step 2: Replace the RATE_LIMITED branch's case write**

Replace:

```ts
      try {
        await updateCaseWaiting(supabase, email.case_id, 'awaiting_resend')
      } catch (waitError) {
        await logEventSafe({
          clientId: email.client_id,
          caseId: email.case_id,
          actor: 'inbox_approve_draft',
          type: 'inbox.mark_waiting_failed',
          payload: { emailId: email.id, cause: waitError instanceof Error ? waitError.message : String(waitError) },
        })
      }
```

with:

```ts
      try {
        await updateLeadStage(supabase, email.lead_id, { stage: 'waiting', waitReason: 'awaiting_resend' })
        const recompute = await recomputeCaseStatus(supabase, email.case_id)
        if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
          await enqueueCrmSync(email.case_id, recompute.status)
        }
      } catch (waitError) {
        await logEventSafe({
          clientId: email.client_id,
          caseId: email.case_id,
          actor: 'inbox_approve_draft',
          type: 'inbox.mark_waiting_failed',
          payload: { emailId: email.id, cause: waitError instanceof Error ? waitError.message : String(waitError) },
        })
      }
```

(`email.lead_id` is non-null here — validated earlier in `approveDraft` at `if (!email.case_id || !email.lead_id || !email.subject || !email.body) throw new AppError(...)`, and `email` is never reassigned afterward, so TypeScript's narrowing holds.)

- [ ] **Step 3: Replace the successful-send `claimCaseContacted` block**

Replace:

```ts
    try {
      await scheduleFirstFollowup(supabase, {
        clientId: email.client_id,
        caseId: email.case_id,
        leadId: email.lead_id,
      })
      // Atomic conditional update, not read-then-write: two concurrent
      // approvals for different leads on the same case (each reaching this
      // point via its own claimDraftForSend) must not both pass a stale
      // status read and double-fire the CRM sync. Only the approval whose
      // update actually flips the case to 'contacted' gets true here.
      const advancedToContacted = await claimCaseContacted(supabase, email.case_id)
      if (advancedToContacted) {
        await enqueueCrmSync(email.case_id, 'contacted')
      }
    } catch (error) {
```

with:

```ts
    try {
      await scheduleFirstFollowup(supabase, {
        clientId: email.client_id,
        caseId: email.case_id,
        leadId: email.lead_id,
      })
      await updateLeadStage(supabase, email.lead_id, { stage: 'contacted' })
      // recomputeCaseStatus is itself the atomic, race-safe step: two
      // concurrent approvals for different leads on the same case each
      // write their own lead's stage, then each call recompute, which
      // row-locks the case — only whichever recompute actually flips the
      // case's status reports didChange: true, so the CRM sync still fires
      // exactly once per real transition, not once per approval.
      const recompute = await recomputeCaseStatus(supabase, email.case_id)
      if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
        await enqueueCrmSync(email.case_id, recompute.status)
      }
    } catch (error) {
```

- [ ] **Step 4: Update the test file**

Locate the existing test file for this module (`find src/app -path '*inbox*' -name '*.test.ts'`). Apply the same mechanical mock change as Task 6 Step 4 (extend `@/lib/db/leads` mock with `updateLeadStage`, swap `claimCaseContacted`/`updateCaseWaiting` for `recomputeCaseStatus`/`CRM_SYNC_STATUSES` in the `@/lib/db/cases` mock). Replace the existing assertion on `claimCaseContactedMock` having been called and gating `enqueueCrmSyncMock` with:

```ts
expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), email.lead_id, { stage: 'contacted' })
expect(recomputeCaseStatusMock).toHaveBeenCalledWith(expect.anything(), email.case_id)
```

Replace the existing RATE_LIMITED test's assertion on `updateCaseWaitingMock` with:

```ts
expect(updateLeadStageMock).toHaveBeenCalledWith(
  expect.anything(), email.lead_id, { stage: 'waiting', waitReason: 'awaiting_resend' },
)
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run` (filtered to the located test file path)
Expected: PASS.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/inbox/actions.ts"`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/inbox/actions.ts"
git commit -m "refactor(inbox): approveDraft sets per-lead stage, recomputes case status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: `finalizeManualSend` integration (`src/app/(app)/cases/[id]/send-actions.ts`)

**Files:**
- Modify: `src/app/(app)/cases/[id]/send-actions.ts`
- Modify: its test file (locate via `find "src/app/(app)/cases" -name '*send-actions*test*'`)

**Interfaces:**
- Consumes: `updateLeadStage` (Task 4), `recomputeCaseStatus`/`CRM_SYNC_STATUSES` (Task 5).

- [ ] **Step 1: Update imports and remove `PRE_CONTACT_STATUSES`**

Change:
```ts
import { getCaseById, claimCaseContactedFrom, type CaseRow, type CaseStatus } from '@/lib/db/cases'
```
to:
```ts
import { getCaseById, recomputeCaseStatus, CRM_SYNC_STATUSES, type CaseRow } from '@/lib/db/cases'
```

Change:
```ts
import { getLeadById } from '@/lib/db/leads'
```
to:
```ts
import { getLeadById, updateLeadStage } from '@/lib/db/leads'
```

Delete the `PRE_CONTACT_STATUSES` constant and its comment block entirely — `recompute_case_status`'s own ranking makes a case that has already progressed past this lead's contribution structurally unable to regress: recompute always picks the *highest*-ranked stage among every lead on the case, so a lead newly marked `'contacted'` can only push the case forward or leave it unchanged, never walk an `in_conversation`/`won`/`lost` case back down. The explicit allowlist this constant existed for is no longer needed. `CaseStatus` is no longer used elsewhere in this file — remove that import too (already done in the import change above).

- [ ] **Step 2: Replace the `claimCaseContactedFrom` block**

Replace:

```ts
    try {
      const advancedToContacted = await claimCaseContactedFrom(supabase, input.caseId, PRE_CONTACT_STATUSES)
      if (advancedToContacted) {
        // Mirrors approveDraft (inbox/actions.ts): a manual send is just as
        // much "this case has now been contacted" as an approved draft, and
        // must fire the same CRM sync — including the waiting case this
        // manual send exists to rescue.
        await enqueueCrmSync(input.caseId, 'contacted')
      }
    } catch (error) {
      await logManualBookkeepingFailure(input, error)
    }
```

with:

```ts
    try {
      await updateLeadStage(supabase, input.leadId, { stage: 'contacted' })
      // Mirrors approveDraft (inbox/actions.ts): a manual send is just as
      // much "this case has now been contacted" as an approved draft, and
      // must fire the same CRM sync — including the waiting case this
      // manual send exists to rescue. recomputeCaseStatus's row lock is
      // what makes this race-safe against another lead's concurrent event
      // on the same case, same as approveDraft.
      const recompute = await recomputeCaseStatus(supabase, input.caseId)
      if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
        await enqueueCrmSync(input.caseId, recompute.status)
      }
    } catch (error) {
      await logManualBookkeepingFailure(input, error)
    }
```

- [ ] **Step 3: Update the test file**

Locate the existing test file. Apply the same mechanical mock change as Task 6 Step 4. Replace the existing assertion on `claimCaseContactedFromMock` (including any test asserting it was called with `PRE_CONTACT_STATUSES`) with:

```ts
expect(updateLeadStageMock).toHaveBeenCalledWith(expect.anything(), input.leadId, { stage: 'contacted' })
expect(recomputeCaseStatusMock).toHaveBeenCalledWith(expect.anything(), input.caseId)
```

Delete any test asserting specifically on the `PRE_CONTACT_STATUSES` array's contents — that behavior moved into `recompute_case_status` itself (covered by Task 2's integration tests) and no longer exists in this file.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run` (filtered to the located test file path)
Expected: PASS.

- [ ] **Step 5: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/cases/[id]/send-actions.ts"`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/cases/[id]/send-actions.ts"
git commit -m "refactor(cases): finalizeManualSend sets per-lead stage, recomputes case status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 11: `resend-failed.ts` integration

**Files:**
- Modify: `src/lib/pipeline/resend-failed.ts`
- Modify: `src/lib/pipeline/resend-failed.test.ts` (or wherever its test lives — locate via `find src/lib/pipeline -name '*resend-failed*test*'`)

**Interfaces:**
- Consumes: `updateLeadStage` (Task 4), `recomputeCaseStatus`/`CRM_SYNC_STATUSES` (Task 5).

- [ ] **Step 1: Update imports**

Change:
```ts
import { getLeadById } from '@/lib/db/leads'
```
to:
```ts
import { getLeadById, updateLeadStage } from '@/lib/db/leads'
```

Change:
```ts
import { getCaseById, updateCaseStatus, type CaseStatus } from '@/lib/db/cases'
```
to:
```ts
import { getCaseById, recomputeCaseStatus, CRM_SYNC_STATUSES, type CaseStatus } from '@/lib/db/cases'
```

(`CaseStatus` stays — still used by `CASE_CLOSED_STATUSES`, unaffected by this task.)

- [ ] **Step 2: Replace the first-touch success block**

Replace:

```ts
  if (step === FIRST_TOUCH_STEP) {
    await scheduleFirstFollowup(supabase, { clientId: email.client_id, caseId, leadId })
    if (kase.status !== 'contacted') {
      await updateCaseStatus(supabase, caseId, 'contacted')
      await enqueueCrmSync(caseId, 'contacted')
    }
    return 'sent'
  }
```

with:

```ts
  if (step === FIRST_TOUCH_STEP) {
    await scheduleFirstFollowup(supabase, { clientId: email.client_id, caseId, leadId })
    await updateLeadStage(supabase, leadId, { stage: 'contacted' })
    const recompute = await recomputeCaseStatus(supabase, caseId)
    if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
      await enqueueCrmSync(caseId, recompute.status)
    }
    return 'sent'
  }
```

(the `kase.status !== 'contacted'` pre-check is no longer needed — `recompute.didChange` is the same guard, computed race-safely inside the row-locked function instead of off a stale in-memory `kase` snapshot read earlier in this function.)

- [ ] **Step 3: Replace the follow-up exhaustion block**

Replace:

```ts
  if (step >= maxStep) {
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, caseId, 'dead')
    await enqueueCrmSync(caseId, 'dead')
  } else {
```

with:

```ts
  if (step >= maxStep) {
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateLeadStage(supabase, leadId, { stage: 'dead' })
    const recompute = await recomputeCaseStatus(supabase, caseId)
    if (recompute.didChange && CRM_SYNC_STATUSES.includes(recompute.status)) {
      await enqueueCrmSync(caseId, recompute.status)
    }
  } else {
```

- [ ] **Step 4: Update the test file**

Same mechanical mock change as Task 6 Step 4. Replace assertions on `updateCaseStatusMock` (both the `'contacted'` and `'dead'` cases) with the `updateLeadStageMock`/`recomputeCaseStatusMock` equivalents, matching the exact patterns from Task 6 Step 4. Remove any test asserting the old `kase.status !== 'contacted'` pre-check skips a redundant write — that guard moved into `recompute.didChange`, already covered by Task 2's and Task 5's own tests; add instead:

```ts
it('should not enqueue a CRM sync when recompute reports the case was already contacted', async () => {
  recomputeCaseStatusMock.mockResolvedValue({ status: 'contacted', didChange: false })
  // ...reuse this file's existing first-touch-success fixture setup
  const outcome = await resendOneUnderTest // however this file currently invokes resendOne / sweepFailedFirstTouch
  expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run` (filtered to the located test file path)
Expected: PASS.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/resend-failed.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/resend-failed.ts
git commit -m "refactor(pipeline): resend-failed.ts sets per-lead stage, recomputes case status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 12: Case detail page — per-contact stage pill

**Files:**
- Modify: `src/app/(app)/cases/[id]/page.tsx`

**Interfaces:**
- Consumes: `leads.stage` (Task 1), `CASE_STATUS` (existing, `src/lib/ui/status.ts`).

- [ ] **Step 1: Render the pill**

`CASE_STATUS` is already imported at the top of this file (`import { CASE_STATUS, KNOWLEDGE_REQ_STATUS, leadEmailStatusMetaFor } from '@/lib/ui/status'`) and its keys already cover every `lead_stage` value (`waiting`/`contacted`/`in_conversation`/`hot_handoff`/`lost`/`dead` are all valid `case_status` labels too) — no new status map needed. `listLeadsForCase` already does `select('*')`, so `lead.stage` is present on every fetched row once Task 1's migration lands and types regenerate.

In the per-contact list, change:

```tsx
                    <div className="mt-2 flex items-center gap-2">
                      <StatusPill meta={leadEmailStatusMetaFor(lead.email_status, appUser.role)} />
                      {lead.linkedin_url ? (
```

to:

```tsx
                    <div className="mt-2 flex items-center gap-2">
                      <StatusPill meta={leadEmailStatusMetaFor(lead.email_status, appUser.role)} />
                      {lead.stage ? <StatusPill meta={CASE_STATUS[lead.stage]} /> : null}
                      {lead.linkedin_url ? (
```

(`lead.stage` is `null` for a contact whose outreach hasn't produced a real per-contact outcome yet — rendering nothing for that case matches the "not started" semantics established in the spec, rather than showing a misleading placeholder.)

- [ ] **Step 2: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/cases/[id]/page.tsx"`
Expected: no errors.

- [ ] **Step 3: Manual check**

Run: `npm run dev` (or this project's existing dev-server invocation), open a case with at least one contact whose `leads.stage` is set (any lead backfilled by Task 3's migration on a non-trivial local dataset, or manually set via `update leads set stage = 'in_conversation' where id = '...'` against the local DB), confirm the new pill renders next to the email-verification pill and not in place of it.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/cases/[id]/page.tsx"
git commit -m "feat(cases): show each contact's own stage pill on the case page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 13: Pipeline list row — stage badges (`buildStageBadges` + `CaseRow`)

**Files:**
- Create: `src/lib/ui/lead-stage-badges.ts`
- Create: `src/lib/ui/lead-stage-badges.test.ts`
- Modify: `src/components/case-row.tsx`

**Interfaces:**
- Consumes: `lead_stage` (Task 1).
- Produces: `buildStageBadges(stages: readonly LeadStage[]): LeadStage[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/ui/lead-stage-badges.test.ts
import { describe, it, expect } from 'vitest'
import { buildStageBadges } from './lead-stage-badges'

describe('buildStageBadges', () => {
  it('should return an empty array when given no stages', () => {
    expect(buildStageBadges([])).toEqual([])
  })

  it('should order active stages most-positive first', () => {
    expect(buildStageBadges(['waiting', 'contacted', 'hot_handoff'])).toEqual([
      'hot_handoff', 'contacted', 'waiting',
    ])
  })

  it('should deduplicate repeated stages', () => {
    expect(buildStageBadges(['contacted', 'contacted', 'waiting'])).toEqual(['contacted', 'waiting'])
  })

  it('should suppress lost/dead when at least one contact is still active', () => {
    expect(buildStageBadges(['contacted', 'lost'])).toEqual(['contacted'])
  })

  it('should show a single lost badge once every contact is terminal and at least one is lost', () => {
    expect(buildStageBadges(['lost', 'dead'])).toEqual(['lost'])
  })

  it('should show a single dead badge when every contact is terminal and none are lost', () => {
    expect(buildStageBadges(['dead', 'dead'])).toEqual(['dead'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/ui/lead-stage-badges.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```ts
// src/lib/ui/lead-stage-badges.ts
import type { Database } from '@/types/database'

export type LeadStage = Database['public']['Enums']['lead_stage']

// Mirrors the active-stage ranking in
// supabase/migrations/0054_recompute_case_status.sql -- keep both in sync.
const ACTIVE_STAGE_RANK: readonly LeadStage[] = ['hot_handoff', 'in_conversation', 'contacted', 'waiting']

// Turns the distinct stages present among a case's contacts into the
// ordered badge list for its row: most-positive first, and lost/dead
// suppressed unless every contact on the case is terminal (matches
// recompute_case_status's own all-terminal rule).
export function buildStageBadges(stages: readonly LeadStage[]): LeadStage[] {
  const distinct = new Set(stages)
  const active = ACTIVE_STAGE_RANK.filter((stage) => distinct.has(stage))
  if (active.length > 0) return active
  if (distinct.has('lost')) return ['lost']
  if (distinct.has('dead')) return ['dead']
  return []
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ui/lead-stage-badges.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire it into `CaseRow`**

In `src/components/case-row.tsx`, add the import:

```ts
import { buildStageBadges, type LeadStage } from '@/lib/ui/lead-stage-badges'
```

Extend the lead shape this component accepts:

```ts
interface CaseRowLead {
  id: string
  full_name: string
  title: string | null
  stage: LeadStage | null
}
```

Inside the component body, before the `return`, compute the badge list:

```ts
  const stageBadges = buildStageBadges(
    leads.map((l) => l.stage).filter((stage): stage is LeadStage => stage !== null),
  )
```

Render it right after the case's own status pill — only when there's more than one distinct badge, since a single badge would just repeat the pill already shown:

```tsx
      <StatusPill meta={CASE_STATUS[status]} className="ml-auto shrink-0 xl:ml-0" />

      {stageBadges.length > 1 ? (
        <span className="hidden shrink-0 items-center gap-1 lg:flex">
          {stageBadges.map((stage) => (
            <StatusPill key={stage} meta={CASE_STATUS[stage]} className="shrink-0" />
          ))}
        </span>
      ) : null}
```

`listCasesWithLeads` (`src/lib/db/crm.ts`) already selects `'*, leads(*)'`, and `crm/page.tsx` already passes `leads={kase.leads}` straight through — full `leads` rows (a superset of `CaseRowLead`) are structurally assignable where `CaseRowLead[]` is expected, so no changes are needed in either of those two files.

- [ ] **Step 6: Verify types and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/ui/lead-stage-badges.ts src/components/case-row.tsx`
Expected: no errors.

- [ ] **Step 7: Manual check**

Run the dev server, open `/crm` with at least one case whose contacts have mixed stages (set via the local DB, as in Task 12 Step 3), confirm the extra badge row appears only for that case and not for cases whose contacts share one stage.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ui/lead-stage-badges.ts src/lib/ui/lead-stage-badges.test.ts src/components/case-row.tsx
git commit -m "feat(crm): show every distinct contact stage on the pipeline row

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 14: Retire dead code

**Files:**
- Modify: `src/lib/db/cases.ts`
- Modify: `src/lib/db/cases.test.ts`

**Interfaces:**
- None — this task only removes code no caller reaches anymore after Tasks 9-10.

- [ ] **Step 1: Confirm nothing still calls the two functions**

Run: `grep -rn "claimCaseContacted\b" src --include='*.ts' --include='*.tsx'` and `grep -rn "claimCaseContactedFrom\b" src --include='*.ts' --include='*.tsx'`
Expected: the only remaining matches are each function's own definition and test file — every call site was replaced in Tasks 9-10.

- [ ] **Step 2: Delete the functions**

Remove `claimCaseContacted` and `claimCaseContactedFrom` (and their doc comments) from `src/lib/db/cases.ts`.

- [ ] **Step 3: Delete their tests**

Remove the corresponding `describe('claimCaseContacted', ...)` and `describe('claimCaseContactedFrom', ...)` blocks from `src/lib/db/cases.test.ts`.

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit && npx eslint src/lib/db/cases.ts src/lib/db/cases.test.ts && npx vitest run src/lib/db/cases.test.ts`
Expected: no errors, all remaining tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/cases.ts src/lib/db/cases.test.ts
git commit -m "chore(db): remove claimCaseContacted/claimCaseContactedFrom, superseded by recomputeCaseStatus

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 15: Full-suite verification

**Files:** none — verification only.

- [ ] **Step 1: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Lint the whole project**

Run: `npx eslint .`
Expected: no errors.

- [ ] **Step 3: Run the full unit suite**

Run: `npx vitest run`
Expected: all tests PASS, including every file touched in Tasks 4-14.

- [ ] **Step 4: Run the full integration suite**

Run: `npx supabase start` (if not already running), then `npx vitest run --config vitest.integration.config.ts`
Expected: all integration tests PASS, including Task 2's `recompute-case-status.integration.test.ts` and every pre-existing integration test (confirms `0053`/`0054`/`0055` didn't break `case-knowledge-attribution.integration.test.ts` or `analytics.integration.test.ts`).

- [ ] **Step 5: Update the roadmap**

Add an entry to `.claude/roadmap.md` per CLAUDE.md's rule (date, what changed, current status, remaining work) noting: per-contact case status shipped (spec + this plan), replacing the single shared `cases.status` writes across `write.ts`/`reply.ts`/`followup.ts`/`approveDraft`/`finalizeManualSend`/`resend-failed.ts` with per-lead `stage`/`wait_reason` plus `recompute_case_status`. No remaining decision — call out only if any step above surfaced a real gap (e.g., a test file location that didn't match this plan's assumption).
