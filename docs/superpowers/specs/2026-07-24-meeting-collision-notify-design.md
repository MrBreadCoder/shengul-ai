# Meeting Collision Notice

**Date:** 2026-07-24
**Status:** Approved design, not yet implemented

## Problem

Discovery's pass 2 (`docs/superpowers/plans/2026-07-19-apollo-multi-thread-discovery.md`)
deliberately finds a second contact at the same company, and every lead
attached to a case shares that case's `campaign_id, company_key` — so it's
routine for two different people at one company to be in independent outreach
threads at the same time. Today, when one of them replies with booking/price
intent, the Reply Agent (`src/lib/pipeline/reply.ts`) sends them a
booking-link reply, stops *their* sequence, and flips the case to
`hot_handoff` — but the *other* contact(s) at that company are never told.
Their sequence keeps running untouched, so a follow-up can land in their
inbox after a colleague has already booked a call, which reads as sloppy and
risks two people from the same company independently trying to schedule two
separate meetings.

Goal: the first time a case reaches `hot_handoff`, automatically pause and
notify any other contact at that company who hasn't replied yet, so they hear
about the colleague's booking from us before their own sequence fires again.

## Trigger

"Accepted" = the existing Reply Agent classifies a reply as `price` intent
(the current, already-shipped proxy for booking intent — this codebase has
no Calendly/Cal.com webhook, so there is no stronger signal available yet).
This is the same branch that already sends the booking-link reply and calls
`updateCaseStatus(caseId, 'hot_handoff')`.

## Data model

One new nullable column, claimed atomically so the notice fires exactly once
per case even if two contacts at the same company hit `hot_handoff` in the
same instant:

```sql
alter table cases add column collision_notified_at timestamptz;
```

Claim pattern (mirrors the race-safe `.eq('state','active')` guards already
used by `advanceSequence`/`stopSequenceForLead` in `src/lib/db/sequences.ts`):

```sql
update cases set collision_notified_at = now()
where id = :caseId and collision_notified_at is null
returning *;
```

If the update returns no row, this case's fan-out has already fired (or is
already in flight) — the caller no-ops. No new table: the fan-out payload
(case id, triggering lead id, target lead id, mailbox id) is small enough to
pass directly in the QStash message body, same as other jobs in this
pipeline.

New event type for observability: `case.collision_notified`, logged once per
notified lead with `{ caseId, leadId, triggeringLeadId }`.

## Trigger & selection logic

New function `triggerCollisionNotice(supabase, caseId, triggeringLeadId)`,
called from `reply.ts`'s `price` branch immediately after
`updateCaseStatus(caseId, 'hot_handoff')`:

1. Attempt the atomic claim above. No row updated → return (no-op).
2. Query other qualifying leads via a new
   `listOtherActiveLeadsForCollisionNotice(supabase, caseId, excludeLeadId)`
   in `src/lib/db/leads.ts` (alongside `getVerifiedLeadCompanies`,
   `listActiveLeadsForCase`): same `case_id`, `id != excludeLeadId`,
   `leads.status = 'active'`, joined to `sequences` where
   `sequences.state = 'active'`. A lead whose sequence is already
   `paused`/`stopped` has already engaged on their own thread and is
   excluded — only contacts on a fully untouched sequence get the notice.
3. Empty result (single-contact company) → return (no-op).
4. Otherwise, enqueue one QStash message per qualifying lead to
   `/api/pipeline/collision-notify`, each carrying
   `{ caseId, leadId, triggeringLeadId, mailboxId }`.

## Fan-out route

New route `POST /api/pipeline/collision-notify`, QStash-signature-verified
like the other pipeline routes, body validated with a Zod schema matching the
payload above.

Handler:

1. Load the target lead, the triggering lead (for the first name), the case
   (for company name), and the campaign (for `reply_mode`).
2. Guard: if the target lead's sequence is no longer `active` (they replied
   in the gap between enqueue and processing), skip — a real reply always
   wins over a canned notice.
3. Build the notice body from the deterministic template below.
4. Thread it as a reply on the target lead's existing outbound thread, using
   the same `replySubject(thread)` convention `reply.ts` already uses — this
   is a continuation of their conversation, not a new cold email.
5. Send-or-draft per `campaign.reply_mode`, exactly like `sendOrDraftReply`
   today: `auto_send` sends immediately, `human_approve` drafts into
   `/inbox`.
6. `stopSequenceForLead(leadId, 'stopped')` — terminal, matching how
   `not_interested`/`price` already stop a sequence without touching
   `leads.status`.
7. Log `case.collision_notified`.

Any failure (mailbox send error, missing row) throws `AppError`, and QStash
retries that single message. The case-level claim is untouched by a
per-lead failure, so retries are safe and one contact's failure can't affect
another's notice.

## Message content

Deterministic template — no LLM call, matching how `reply.ts` already builds
the price-handoff reply (`buildBookingReply`) without generation, since this
is fixed-shape content with no case-specific question to answer. Matching
`buildBookingReply`'s actual style (plain sentences, no signature block — it
has none today), the template is two sentences, no sign-off:

```
Hi {targetFirstName} — looks like {triggeringFirstName} already grabbed
time with us. Happy to keep it to one call, or loop you in too if that'd
be useful — just let us know either way!
```

`{firstName}` = first whitespace-delimited token of `leads.full_name`.

## Testing

- `cases.test.ts`: new claim helper — claims once, no-ops on a repeat call.
- `leads.test.ts`: new `listOtherActiveLeadsForCollisionNotice` — excludes
  the triggering lead, excludes non-`active`-sequence leads, excludes
  parked/suppressed leads.
- New `collision-notify` route test: happy send path, `human_approve` draft
  path, skip-if-target-already-replied guard, QStash signature rejection,
  malformed payload rejection.
- `reply.ts` test: price branch calls `triggerCollisionNotice` (mocked) with
  the right case/triggering-lead ids after `updateCaseStatus`.

## Out of scope

- Any real calendar-booking confirmation (Calendly/Cal.com webhook) — the
  trigger stays tied to `price`-intent classification until such an
  integration exists.
- Handling more than one qualifying contact differently from each other —
  every qualifying lead gets the identical templated notice.
- Re-notifying if a *third* contact also reaches `hot_handoff` later on the
  same case — the once-per-case claim intentionally suppresses this; no
  further notices are sent once a case has fired.
