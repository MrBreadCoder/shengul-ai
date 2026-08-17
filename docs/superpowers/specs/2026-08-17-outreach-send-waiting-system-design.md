# Design: Outreach send waiting system

**Status:** Approved for planning.

## Problem

`runWriteForCase` (`src/lib/pipeline/write.ts`) ends unconditionally:

```ts
await updateCaseStatus(supabase, input.caseId, 'contacted')
await enqueueCrmSync(input.caseId, 'contacted')
```

regardless of what actually happened in the leads loop above it. Two distinct failure modes share this root cause, traced end-to-end this session:

**1. A gate-blocked first touch silently loses the lead.** When every eligible mailbox on a campaign is still inside Mailreach's 14-day warmup gate (or at today's send cap, or unhealthy), `sendViaMailbox` throws `RATE_LIMITED`. `processLead` catches it, marks the claimed email row `failed`, and returns `'skipped'`. The loop finishes, and the case still gets marked `contacted` — as if outreach happened. Nothing retries it: `find_stuck_cases`'s `contacted` backstop branch (0041) explicitly excludes any lead that already has *a* step-0 outbound row, and a `failed` row satisfies that check just as well as a `sent` one. The lead is marked as contacted, was never actually emailed, and nothing will ever look at it again without a human noticing.

**2. A `human_approve` case with only drafts falsely reports as contacted — including to the client's CRM.** `runWriteForCase` reaches the same unconditional end whether every lead was `sent` or merely `drafted` (nothing sent, awaiting operator approval in `/inbox`). This is a previously flagged, unfixed roadmap item ("Cases show `contacted` before a human approves," flagged 2026-08-13) — but tracing its blast radius further this session found it's worse than a dashboard miscount: `enqueueCrmSync(input.caseId, 'contacted')` fires in the same breath, and `lib/crm/sync.ts` maps `'contacted'` to the note **"First outreach sent."**, pushed to the client's connected external CRM. A `human_approve` client with pending, unapproved drafts has "first outreach sent" asserted to their CRM before anyone sent anything.

Both are the same bug: **the write pipeline advances a case to a terminal state without confirming it actually reached one.**

## Scope decisions (from brainstorming)

- Fix at the root: `contacted` (+ its CRM sync) is written only when at least one lead was actually sent — never merely attempted, drafted, or blocked.
- Three of the non-send outcomes are transient and worth auto-retrying: Mailreach gate, daily send cap, no healthy mailbox. These share one new case state, `waiting`, and ride the *existing* 5-minute write-fanout cron — no new cron.
- Two outcomes are not time-based and must not be auto-retried: `awaiting_manual_approval` (resolves when a human clicks Approve in `/inbox`) and `no_viable_leads` (every lead permanently disqualified — suppressed/unemailable; resolves only if discovery adds a new lead later, an external event this design doesn't drive).
- The Mailreach-gate check moves before AI generation, so a gated case's retries cost a cheap DB read, not a wasted LLM call, on every 5-minute tick until the gate lifts.
- `sender.ts`'s send-time enforcement (`rotationOrder`, the atomic `claim_mailbox_send`/`claim_mailbox_send_uncapped` RPCs) is unchanged and remains the actual point of enforcement — this design adds an earlier, cheaper *probe* in front of it, not a replacement for it.

## 1. State model

New `case_status` value **`waiting`**, inserted after `writing` (mirrors the 0040 precedent — a real state, not a repurposed existing one). New `case_wait_reason` enum, and a nullable `cases.wait_reason` column, guarded by a check constraint so the two columns can never disagree (same pattern as `app_users`' role/client_id constraint in 0001):

```sql
-- supabase/migrations/0049_case_waiting_state.sql

-- New case-status value for "write was attempted this tick and did not reach
-- a terminal outcome, but will (or may) be retried" — distinct from 'ready'
-- (never attempted) and 'writing' (actively running this instant). See
-- docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PG12+ so long
-- as the new value is not *used* in the same transaction (0011, 0040) —
-- nothing below references 'waiting' as a case_status literal, so this is
-- safe under `supabase db push`.
alter type case_status add value if not exists 'waiting' after 'writing';

-- Why each case is waiting. The first three are mailbox-availability
-- conditions the 5-minute write-fanout cron re-checks automatically;
-- 'awaiting_manual_approval' clears when a human approves a draft in /inbox;
-- 'no_viable_leads' clears only if a later discovery pass adds a new lead to
-- the case. See AUTO_RETRY_WAIT_REASONS in src/lib/db/cases.ts.
create type case_wait_reason as enum (
  'mailreach_gate',
  'daily_cap',
  'no_healthy_mailbox',
  'awaiting_manual_approval',
  'no_viable_leads'
);

alter table cases add column wait_reason case_wait_reason;

-- Keeps the two columns from ever disagreeing: a reason with no 'waiting'
-- status, or 'waiting' with no reason, are both invalid states. Same
-- cross-column guard pattern as app_users' role/client_id check (0001).
alter table cases add constraint cases_wait_reason_matches_status
  check ((status = 'waiting') = (wait_reason is not null));
```

`src/types/database.ts` — `case_status` gains `'waiting'` after `'writing'`; new `case_wait_reason` enum entry; `cases`' `Row`/`Insert` gain `wait_reason: Database['public']['Enums']['case_wait_reason'] | null` (optional on `Insert`, defaults null).

**Look right so far?**

## 2. Shared eligibility probe (`src/lib/mailbox/eligibility.ts`, new file)

One function, reused by `write.ts` as an up-front probe. It composes the *existing* gate primitive (`isEligibleForCampaignSend`, unchanged) with health and daily-cap awareness — the fuller picture `write.ts` needs to decide whether to even attempt a case, without duplicating `sender.ts`'s gate math:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listMailboxesByIds, type MailboxRow } from '@/lib/db/mailboxes'
import { isEligibleForCampaignSend, MAILREACH_CAMPAIGN_GATE_DAYS } from '@/lib/mailbox/mailreach-gate'
import { effectiveDailyCap } from '@/lib/mailbox/warmup'

export type OutreachEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'mailreach_gate'; retryAfter: Date }
  | { eligible: false; reason: 'daily_cap'; retryAfter: Date }
  | { eligible: false; reason: 'no_healthy_mailbox' }

const MS_PER_DAY = 86_400_000

// Mirrors claim_mailbox_send's own predicate exactly (0012:
// `health <> 'blocked' and sent_today < least(daily_cap, greatest(p_effective_cap, 0))`)
// — a read-only echo, not the enforcement point. sender.ts's atomic RPC stays
// the real gate; this can race harmlessly (a mailbox counted "capped" here
// may have already reset by the time write.ts's own send attempt runs, and
// vice versa) since a wrong "eligible: true" here just falls through to
// sender.ts's real, atomic check.
function isCapReady(mailbox: MailboxRow, now: Date): boolean {
  const cap = Math.min(mailbox.daily_cap, Math.max(effectiveDailyCap({
    profile: mailbox.warmup_profile,
    warmupStartedAt: mailbox.warmup_started_at,
    startCap: mailbox.warmup_start_cap,
    increment: mailbox.warmup_increment,
    targetCap: mailbox.warmup_target_cap,
    dailyCap: mailbox.daily_cap,
    now,
  }), 0))
  return mailbox.sent_today < cap
}

function nextMidnightUtc(now: Date): Date {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
  return next
}

function gateLiftsAt(mailbox: MailboxRow): Date {
  // Only called for a mailbox already known to be gated (mailreach_started_at
  // non-null, enrolled) — see call site.
  return new Date(Date.parse(mailbox.mailreach_started_at!) + MAILREACH_CAMPAIGN_GATE_DAYS * MS_PER_DAY)
}

export async function getOutreachEligibility(
  supabase: SupabaseClient<Database>,
  input: { mailboxIds: string[]; clientMailreachEnabled: boolean; now: Date },
): Promise<OutreachEligibility> {
  const mailboxes = input.mailboxIds.length > 0 ? await listMailboxesByIds(supabase, input.mailboxIds) : []
  const healthy = mailboxes.filter((m) => m.health !== 'blocked')
  if (healthy.length === 0) return { eligible: false, reason: 'no_healthy_mailbox' }

  const gateOk = (m: MailboxRow): boolean =>
    isEligibleForCampaignSend({
      mailreachEnabled: m.mailreach_enabled,
      clientMailreachEnabled: input.clientMailreachEnabled,
      mailreachStartedAt: m.mailreach_started_at,
      now: input.now,
    })

  const gatePassed = healthy.filter(gateOk)
  if (gatePassed.length === 0) {
    // Every healthy mailbox is gated — mailreachElapsedDays/isEligibleForCampaignSend
    // guarantee mailreach_started_at is non-null for each (that's the only way
    // gateOk can be false), so gateLiftsAt is always well-defined here.
    const retryAfter = healthy.reduce(
      (earliest, m) => (gateLiftsAt(m) < earliest ? gateLiftsAt(m) : earliest),
      gateLiftsAt(healthy[0]!),
    )
    return { eligible: false, reason: 'mailreach_gate', retryAfter }
  }

  if (gatePassed.some((m) => isCapReady(m, input.now))) return { eligible: true }

  // Every gate-cleared mailbox is at today's cap. A diagnostic label only —
  // the retry cadence is the same 5-minute tick regardless of reason.
  return { eligible: false, reason: 'daily_cap', retryAfter: nextMidnightUtc(input.now) }
}
```

`gateLiftsAt` computes the lift time directly from `mailreach_started_at` + the gate constant — no need for `mailreachElapsedDays` here, so it's not imported.

**Look right so far?**

## 3. `write.ts` — up-front check, honest end-of-loop status

```ts
import { getOutreachEligibility } from '@/lib/mailbox/eligibility'
import { updateCaseStatus, updateCaseWaiting } from '@/lib/db/cases' // updateCaseWaiting defined in §4
```

`RunWriteInput` gains two fields so the caller's already-loaded case row tells `runWriteForCase` what NOT to redundantly re-log:

```ts
export interface RunWriteInput {
  // ...existing fields...
  currentStatus: Database['public']['Enums']['case_status']
  currentWaitReason: Database['public']['Enums']['case_wait_reason'] | null
}
```

`runWriteForCase`: the existing `getClientById` call moves to the top (was already happening once per case, right after `listActiveLeadsForCase` — reused here rather than fetched twice), and the eligibility probe runs before touching leads or knowledge:

```ts
export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const client = await getClientById(supabase, input.clientId)

  const eligibility = await getOutreachEligibility(supabase, {
    mailboxIds: input.mailboxIds,
    clientMailreachEnabled: client?.mailreach_enabled ?? false,
    now: new Date(),
  })
  if (!eligibility.eligible) {
    const changed = input.currentStatus !== 'waiting' || input.currentWaitReason !== eligibility.reason
    await updateCaseWaiting(supabase, input.caseId, eligibility.reason)
    // Logged only on an actual transition — a still-gated case re-checked
    // every 5 minutes for hours must not spam the event log each tick.
    if (changed) {
      await logEventSafe({
        clientId: input.clientId,
        caseId: input.caseId,
        actor: ACTOR,
        type: 'pipeline.write.waiting',
        payload: {
          reason: eligibility.reason,
          retryAfter: 'retryAfter' in eligibility ? eligibility.retryAfter.toISOString() : null,
        },
      })
    }
    return { caseId: input.caseId, drafted: 0, sent: 0 }
  }

  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)
  // client already loaded above.

  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    // ...unchanged per-lead loop, processLead(...) call included...
  }

  if (sent > 0) {
    await updateCaseStatus(supabase, input.caseId, 'contacted')
    await enqueueCrmSync(input.caseId, 'contacted')
  } else if (drafted > 0) {
    // human_approve, or hybrid's first-touch step — nothing sent yet, a
    // human owns the next move in /inbox. approveDraft (§5) is what
    // eventually advances this case to 'contacted'.
    await updateCaseWaiting(supabase, input.caseId, 'awaiting_manual_approval')
  } else {
    // Every active lead was permanently disqualified this attempt (missing
    // email, suppressed) — processLead checks suppression before generation,
    // so this path never paid for an LLM call either. Not 'contacted' (never
    // sent), and not left at 'writing' (would misread as stuck and get
    // endlessly re-queued by stuck-sweep for a condition that won't change
    // on its own). 'no_viable_leads' is deliberately excluded from the
    // auto-retry set (§4) — nothing about waiting 5 more minutes changes a
    // suppression list.
    await updateCaseWaiting(supabase, input.caseId, 'no_viable_leads')
  }

  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.write.completed',
    payload: { caseId: input.caseId, sent, drafted, leadCount: leads.length },
  })
  return { caseId: input.caseId, drafted, sent }
}
```

A gated lead no longer creates an `emails` row at all — generation is skipped for the whole case up front, so there's nothing to claim and nothing to mark `failed`. `markEmailFailed` inside `processLead`'s catch stays exactly as-is, for the cases it still legitimately covers: a per-lead send that clears the up-front probe but still fails at the real, atomic send (auth revoked, provider error, or the harmless race noted in §2 where the probe said "ready" a few hundred milliseconds before the real cap check disagreed).

**Look right so far?**

## 4. `src/lib/db/cases.ts` — new/changed functions

```ts
export const AUTO_RETRY_WAIT_REASONS: readonly Database['public']['Enums']['case_wait_reason'][] = [
  'mailreach_gate',
  'daily_cap',
  'no_healthy_mailbox',
]

// Every other call site sets a non-waiting status, so unconditionally
// clearing wait_reason here is always correct — and required: the
// cases_wait_reason_matches_status check constraint (0049) rejects any row
// where status != 'waiting' but wait_reason is still set.
export async function updateCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
  status: CaseStatus,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status, wait_reason: null, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case status', { caseId, status, cause: error.message })
  }
}

export async function updateCaseWaiting(
  supabase: SupabaseClient<Database>,
  caseId: string,
  reason: CaseWaitReason,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status: 'waiting', wait_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case to waiting', { caseId, reason, cause: error.message })
  }
}

export async function listCasesByStatus(
  supabase: SupabaseClient<Database>,
  status: CaseStatus | CaseStatus[],
  limit: number,
): Promise<CaseRow[]> {
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .in('status', Array.isArray(status) ? status : [status])
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list cases by status', { status, cause: error.message })
  }
  return data ?? []
}
```

(`.eq` → `.in` is a behavior-preserving generalization — `research-fanout/route.ts`'s existing `listCasesByStatus(admin, 'new', ...)` call is untouched and works identically against `.in('status', ['new'])`.)

**Look right so far?**

## 5. Wiring the retry: `write-fanout` and `write` routes

`src/app/api/pipeline/write-fanout/route.ts` — widen the query, then drop the one wait reason that isn't time-based before publishing:

```ts
import { listCasesByStatus, AUTO_RETRY_WAIT_REASONS } from '@/lib/db/cases'

const cases = await listCasesByStatus(admin, ['ready', 'waiting'], FANOUT_LIMIT)
const dispatchable = cases.filter((c) => c.status === 'ready' || AUTO_RETRY_WAIT_REASONS.includes(c.wait_reason!))
// ...existing for-loop over `dispatchable` instead of `cases`; failedCaseIds/
// logEvent payload unchanged in shape.
```

`src/app/api/pipeline/write/route.ts` — the entry guard currently rejects anything but `'ready'`, which would silently no-op every case the widened fanout now dispatches. It also passes `kase.status`/`kase.wait_reason` through so `runWriteForCase` can suppress a redundant log on an unchanged tick:

```ts
const kase = await getCaseById(admin, caseId)
if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
clientId = kase.client_id
const resumable = kase.status === 'ready'
  || (kase.status === 'waiting' && AUTO_RETRY_WAIT_REASONS.includes(kase.wait_reason!))
if (!resumable) return NextResponse.json({ ok: true, skipped: 'case_not_ready' })

// ...campaign/active checks unchanged...

await updateCaseStatus(admin, caseId, 'writing') // clears wait_reason too (§4)

const summary = await runWriteForCase(admin, {
  // ...existing fields...
  currentStatus: kase.status,
  currentWaitReason: kase.wait_reason,
})
```

Net effect: a gated case is picked up again within 5 minutes of the gate lifting or the daily cap resetting, using cron infrastructure that already exists. `awaiting_manual_approval` and `no_viable_leads` cases are never dispatched by the fanout at all — `resumable` is false for both, so even a stray/duplicate publish for one is a cheap, harmless no-op.

**Look right so far?**

## 6. Closing the CRM/status loop: `approveDraft`

`src/app/(app)/inbox/actions.ts` — a human approving the first-touch draft is the event that actually contacts the lead for an `awaiting_manual_approval` case. Extends the existing `FIRST_TOUCH_STEP` block (already there for `scheduleFirstFollowup`) rather than adding a new one:

```ts
if (email.sequence_step === FIRST_TOUCH_STEP) {
  try {
    await scheduleFirstFollowup(supabase, { clientId: email.client_id, caseId: email.case_id, leadId: email.lead_id })
    const kase = await getCaseById(supabase, email.case_id)
    if (kase && kase.status !== 'contacted') {
      await updateCaseStatus(supabase, email.case_id, 'contacted')
      await enqueueCrmSync(email.case_id, 'contacted')
    }
  } catch (error) {
    // ...existing logEventSafe, unchanged...
  }
}
```

The `kase.status !== 'contacted'` guard makes a second lead's approval on the same case a no-op rather than a redundant CRM push — mirrors `PRE_CONTACT_STATUSES`' purpose in `send-actions.ts` (§7) without needing the same allow-list, since here we only ever move *into* `contacted`, never risk moving backward out of a later stage (`in_conversation`+ cases don't have pending step-0 drafts to approve).

**Look right so far?**

## 7. Two ripple fixes found by tracing every `case.status === 'contacted'` read

- **`src/app/(app)/cases/[id]/send-actions.ts`** — `PRE_CONTACT_STATUSES` (governs whether a manual send from the case page promotes the case to `contacted`) is `['new', 'researching', 'ready', 'writing']`. Without `'waiting'` added, a human manually rescuing a gated/waiting lead from the case page — exactly the safety-valve move this design exists to make unnecessary but must not break — would send the email yet leave the case permanently stuck reading `waiting`. Fix: add `'waiting'` to the list.
- **`src/app/(app)/crm/page.tsx`** — `STATUS_FILTERS` (kanban filter chips) doesn't include `'waiting'` (or the pre-existing `'writing'`, an unrelated gap this design doesn't touch). Cases still appear under "All" without this, just aren't isolatable. Fix: insert `'waiting'` between `'ready'` and `'contacted'`, matching pipeline order.

## 8. Visibility: status meta, colors, log message

`src/lib/ui/status.ts` — `CASE_STATUS` is `Record<CaseStatus, StatusMeta>`, so TypeScript forces this addition at compile time the moment the enum changes:

```ts
waiting: { label: 'Waiting', color: 'var(--status-waiting)' },
```

`src/app/globals.css` — new token in both palettes, hue placed between `writing` (250) and `contacted` (265), following the file's existing hand-tuned progression:

```css
/* light, alongside --status-writing/--status-contacted */
--status-waiting: oklch(0.575 0.13 258);
/* dark */
--status-waiting: oklch(0.715 0.13 258);
/* @theme bridge, both blocks */
--color-status-waiting: var(--status-waiting);
```

A single status label doesn't distinguish *why* a case is waiting, which matters: `no_healthy_mailbox` needs an operator now; `mailreach_gate` doesn't need anyone. Case list/detail rows showing `waiting` render a second, reason-driven line — reusing the same "what would a client/operator actually want to know" pattern as `EMAIL_STATUS`/`MAILBOX_HEALTH`:

```ts
export const CASE_WAIT_REASON: Record<CaseWaitReason, StatusMeta> = {
  mailreach_gate: { label: 'Mailbox still warming up', color: 'var(--status-writing)' },
  daily_cap: { label: 'Daily send cap reached', color: 'var(--status-writing)' },
  no_healthy_mailbox: { label: 'No healthy mailbox — needs attention', color: 'var(--status-lost)' },
  awaiting_manual_approval: { label: 'Drafts ready for approval', color: 'var(--status-ready)' },
  no_viable_leads: { label: 'No contactable leads', color: 'var(--status-dead)' },
}
```

(Exact placement in the case list/detail components — `case-row.tsx` and the case detail page — is an implementation-time detail, not a new architectural decision; both already render `CASE_STATUS[kase.status]` today and just need the reason line added conditionally when `status === 'waiting'`.)

`src/lib/ui/log.ts` — `mailbox.none_healthy`'s message already receives `warmupGatedCount` in its payload (`sender.ts:165`) but never renders it, so a warmup-caused block reads identically to an actually-broken mailbox:

```ts
'mailbox.none_healthy': (p) => {
  const total = readNumber(p, 'mailboxCount')
  const gated = readNumber(p, 'warmupGatedCount')
  if (gated > 0 && gated === total) return `No healthy mailbox available — all ${total} configured mailboxes still in Mailreach warmup.`
  if (gated > 0) return `No healthy mailbox available — ${total} configured, ${gated} still warming up, the rest capped or blocked.`
  return `No healthy mailbox available — ${total} configured, all capped or blocked.`
},
```

Per-client CRM-only, not translated: this is `/clients/[id]`'s operator log feed, out of scope for i18n per the project's client-facing-only translation rule.

**Look right so far?**

## 9. Explicitly out of scope

- A dashboard-level proactive alert/count specifically for `no_healthy_mailbox` cases (e.g. a home banner). The per-client logs feed + the new `Waiting` kanban filter make it discoverable today; a push-style alert is a reasonable follow-up but a separate, smaller feature, not required to close the lost-lead gap.
- Any change to `sender.ts`'s `rotationOrder` or the atomic `claim_mailbox_send`/`claim_mailbox_send_uncapped` RPCs — send-time enforcement is unchanged; this design only adds a cheaper probe in front of it.
- Reviving a `no_viable_leads` case automatically when discovery later adds a fresh lead to the same company. Whatever discovery's existing company-matching does today for a `contacted` case, it continues to do unchanged for a `waiting`/`no_viable_leads` one — this design doesn't touch discovery.
- Backfilling historical `contacted` cases that were actually gate-blocked or all-drafted before this change ships. They stay mislabeled unless a human corrects them; `find_stuck_cases`'s existing `contacted` backstop (0041) remains as the safety net it already was for pre-fix stragglers.
- A stuck-sweep branch for `waiting` cases. `waiting` is a deliberate, stable resting state, not a stuck claim like `researching`/`writing` — it's swept by write-fanout (the 3 auto-retry reasons) or by a human action (`approveDraft`), never by age.

## 10. Testing

- **`src/lib/mailbox/eligibility.test.ts`** (new): no mailboxes → `no_healthy_mailbox`; all blocked → `no_healthy_mailbox`; all gated → `mailreach_gate` with `retryAfter` = earliest `mailreach_started_at + 14d` across the gated set; gate-cleared but all at cap → `daily_cap` with `retryAfter` = next UTC midnight; mixed healthy/blocked with at least one gate-and-cap-clear → `eligible: true`; boundary at exactly `sent_today === effectiveCap` → not ready (matches `<`, not `<=`, in `claim_mailbox_send`'s own predicate).
- **`src/lib/pipeline/write.test.ts`**: ineligible case → `generateJson` never called (mock assertion), `updateCaseWaiting` called with the probe's reason, case status/summary returns `{ sent: 0, drafted: 0 }`; ineligible on an already-`waiting`-with-same-reason case → `logEventSafe` NOT called (no-churn assertion), `updateCaseWaiting` still called (idempotent write); `sent > 0` → `contacted` + `enqueueCrmSync('contacted')` (existing test, kept); `sent === 0, drafted > 0` → `updateCaseWaiting(..., 'awaiting_manual_approval')`, `enqueueCrmSync` NOT called; `sent === 0, drafted === 0` (all suppressed/no-email) → `updateCaseWaiting(..., 'no_viable_leads')`.
- **`src/lib/db/cases.test.ts`**: `updateCaseStatus` always includes `wait_reason: null` in the update payload; `updateCaseWaiting` sets both `status` and `wait_reason`; `listCasesByStatus` with an array uses `.in`, with a single value behaves identically to today (existing test kept).
- **`src/app/api/pipeline/write-fanout/route.test.ts`**: fetches `['ready', 'waiting']`; a `waiting`/`mailreach_gate` case is dispatched; a `waiting`/`awaiting_manual_approval` case and a `waiting`/`no_viable_leads` case are both filtered out before publish.
- **`src/app/api/pipeline/write/route.test.ts`**: a `waiting`/`daily_cap` case is accepted (not `case_not_ready`) and `currentStatus`/`currentWaitReason` are passed through to `runWriteForCase`; a `waiting`/`awaiting_manual_approval` case is still rejected as `case_not_ready` (defense in depth even if fanout's filter is ever bypassed).
- **`src/app/(app)/inbox/actions.test.ts`**: approving a first-touch draft on a `waiting`/`awaiting_manual_approval` case → case flips to `contacted`, CRM sync fires; approving a second lead's first-touch draft on an already-`contacted` case → `updateCaseStatus`/`enqueueCrmSync` NOT called again.
- **`src/app/(app)/cases/[id]/send-actions.test.ts`**: manual send on a `waiting` case → promotes to `contacted` (existing `PRE_CONTACT_STATUSES` test extended with the new status, not replaced).
- **`src/lib/ui/log.test.ts`** (or wherever `log.ts` is covered): `mailbox.none_healthy` message branches on `warmupGatedCount` — all-gated, partially-gated, and zero-gated payload shapes each produce distinct text.
- Migration: a plain apply/rollback-shape check (consistent with how 0040/0041/0042 were verified — no dedicated migration test file exists for those either) plus one integration assertion that inserting a `waiting` row without `wait_reason` (or a non-`waiting` row with one) is rejected by the new check constraint.
- `pnpm typecheck && pnpm lint && pnpm test` all clean before calling this done.
