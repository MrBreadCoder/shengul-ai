# Code Review — P2: Research + Write + Send + Follow-ups

**Reviewed:** 2026-07-19
**Plan:** `docs/superpowers/plans/2026-07-19-p2-research-write-send-followups.md`
**Scope:** Entire P2 implementation (Phases 1–7, Tasks 1–20), reviewed against the plan and `.claude/QUALITY.md` / `.claude/BEHAVIORS.md` / `.claude/ANTI_LAZY.md`. All changes were uncommitted in the working tree at review time.
**Method:** Three independent reviewer agents, each covering a phase group, with no shared context (fresh read of the plan + code each time), each running the relevant test suite / typecheck itself.
- Reviewer A — Phase 1–2 (Tasks 1–8): foundations + data access layer
- Reviewer B — Phase 3–5 (Tasks 9–17): sending infra, research stage, write/send/follow-up stage
- Reviewer C — Phase 6–7 (Tasks 18–20): `/inbox` human-approval UI, docs, full-suite verification

---

## Overall Assessment

**Ready to merge? No — blocked on 3 Critical issues, all confined to the `/inbox` human-approval path (Task 18).**

The automated pipeline (Phases 1–5: migration, LLM/research clients, all `lib/db/` modules, mailbox rotation/cap/jitter sender, research/write/follow-up pipelines, all QStash routes) is **clean**: no Critical or Important issues, full test suites pass, `tsc --noEmit` is clean, idempotency and atomic-cap-claim guarantees were verified correct by direct reading of the SQL and the claim-then-send call order in every code path that sends mail automatically.

The `/inbox` UI (Phase 6) is where real problems live. `src/app/inbox/actions.ts` — the one path a human actually clicks — bypasses the safety guarantees the rest of the system was carefully built around:

1. Approving a draft never schedules a follow-up sequence (the plan's headline "3/7/14-day cadence" never fires for `human_approve` campaigns).
2. It writes through the session-bound Supabase client with no operator-role check, and under this repo's own RLS write policies that write can silently no-op while the real email still sends — a non-operator can trigger a live send that never gets marked `sent`, inviting a second real send on re-click.
3. It has no atomic claim-before-send transition, unlike every other send path in the codebase — a double-click or retry can send twice.



**Bottom line:** everything that runs unattended (cron → fanout → per-entity route → send) is solid and safe to rely on. The one thing a human clicks is not, and should not ship to a `human_approve` client until fixed.

---

## Consolidated Issue List (by severity)

### Critical — Must Fix

1. **No follow-up sequence created on manual approval** — `src/app/inbox/actions.ts:34-46`
   `approveDraft` sends the draft and calls `markEmailSent`, then stops. It never calls `createSequence` + `publishJsonWithDelay`, unlike the automated path (`src/lib/pipeline/write.ts:101-132`, called after every successful send). `createSequence` is called nowhere except `write.ts:114`. Every first-touch email a human approves via `/inbox` is sent with **no follow-up cadence ever scheduled**, contradicting the plan's stated goal.
   **Fix:** in `approveDraft`, after `markEmailSent`, mirror `write.ts`'s post-send branch: create the `sequences` row and enqueue the first `publishJsonWithDelay('/api/pipeline/followup', ...)` call, guarded on `email.sequence_step === 0`.

2. **Missing operator-role check + RLS write-policy mismatch → silent failure and double-send risk** — `src/app/inbox/actions.ts:18-46`, `src/lib/db/emails.ts:28-46`, `src/lib/db/mailboxes.ts:28-35`
   `emails_write` / `mailboxes_write` RLS policies (`supabase/migrations/0002_rls_policies.sql:39-41`) restrict UPDATEs to operators. `approveDraft` writes through `createServerClient()` (session-bound), not `createAdminClient()` (used by every pipeline route, e.g. `src/app/api/pipeline/write/route.ts:18`). A Postgres `UPDATE` whose `USING` clause excludes all rows silently affects 0 rows — it does not error. `markEmailSent` / `updateMailboxOauth` only check `{ error }`, never affected-row count.
   Concretely: `claimMailboxSend`'s RPC is `SECURITY DEFINER` (bypasses RLS) so a non-operator's click still triggers a **real** Gmail/Outlook send, but `markEmailSent`'s UPDATE is silently blocked — the row stays `status = 'draft'`, the page re-renders the same draft, and a second click sends a second real email. Every other mutating route in the codebase (`src/app/api/campaigns/route.ts:27`, `src/app/api/mailboxes/google/connect/route.ts:9`, etc.) explicitly checks `appUser.role !== 'operator'`; `actions.ts` does not.
   **Fix:** add an explicit operator-role check and switch to `createAdminClient()` for the write portion (matching the pipeline-route pattern), *or* add an RLS write policy for the owning client and make the DB functions check affected-row count so a blocked write throws instead of failing silently.

3. **No atomic claim-before-send transition — TOCTOU double-send window** — `src/app/inbox/actions.ts:21` (plan lines 3628–3661)
   `approveDraft` reads `email.status !== 'draft'` then unconditionally calls `sendViaMailbox` — no atomic `UPDATE ... WHERE status='draft'` transition analogous to `claimOutboundEmail`'s upsert-based claim used everywhere else. Two concurrent invocations (double-click, two tabs, a Server Action retry) can both pass the read check and both send. **Note:** this code matches the plan's own reference implementation at Task 18 Step 4 verbatim — this is a gap in the plan itself, not an implementer deviation.
   **Fix:** atomically transition `draft → sending` (`.update({status:'sending'}).eq('id', emailId).eq('status','draft').select()`, treat an empty result as already-handled) before calling `sendViaMailbox`.

### Important — Should Fix

4. **Task 19 doc update incomplete** — `.claude/architecture.md:272-277`, `.claude/roadmap.md:48,87-89`
   `.claude/architecture.md` §10 still lists Brightdata web research as "— (unimplemented, P2)," unchanged from before P2 existed. The roadmap's own Phase 7 section says "NOT STARTED" and the P2 heading was never marked `DONE`. Test-count entries in the roadmap are accurate, but the doc-content half of Task 19 was not done.
   **Fix:** update architecture.md §10's Web-research/LLM rows to point at `src/lib/research/{provider,brightdata}.ts` and `src/lib/llm/client.ts`; flip roadmap Phase 7 status.

5. **`/inbox` page over-fetches to build a name lookup** — `src/app/inbox/page.tsx:12-16`
   Calls `listCasesWithLeads` (`select('*, leads(*)')` for every case/lead across the client) purely to build an `id → company_name` map, pulling far more PII/data than the page needs.
   **Fix:** add a narrow `listCaseCompanyNames` (`select('id, company_name')`) or join `company_name` directly into the drafts query.

6. **Case can get permanently stranded on partial mid-loop failure** — `src/app/api/pipeline/write/route.ts:28-39`, `src/app/api/pipeline/research/route.ts:27-42`
   The route flips case status (`ready → contacted`, `new → researching`) *before* looping over leads; a transient failure on lead 2-of-3 aborts the loop, and a QStash retry now no-ops (`case_not_ready`/`case_not_new`) because status already advanced. Leads 3+ are never retried and the case is stuck with no automatic recovery. **This mirrors the plan's own reference route/pipeline structure** — a plan-level gap, not an implementation defect.
   **Fix (needs a decision from the plan owner):** either don't advance status until after the loop completes, or add a stuck-state sweeper cron that re-queues cases with no forward progress past an age threshold.

7. **Mailbox rotation/fallback path untested for the multi-mailbox case** — `src/lib/mailbox/sender.test.ts`
   All 3 tests use a single mailbox. There is no test proving least-used-first ordering picks the lower `sent_today` candidate, or that a `claimMailboxSend` returning `null` for the first candidate correctly falls through to the next. Verified correct by reading, but untested for the case explicitly called out as safety-critical.
   **Fix:** add a 2+-mailbox test asserting ordering and fallback-on-cap.

8. **`runFollowupStep` / `processLead` exceed the ~40-line guideline** — `src/lib/pipeline/followup.ts:58-170` (~112 lines), `src/lib/pipeline/write.ts:68-139` (~70 lines)
   Both mix guard checks, LLM call, claim, send, and sequence bookkeeping in one function.
   **Fix:** extract helpers (e.g. `attemptSend`, `scheduleNextOrTerminate`) — organizational only, no behavior change.

9. **`hasInboundReply` is currently unreachable in production** — `src/lib/db/emails.ts:73-86`
   No route/webhook anywhere in the codebase ever inserts an inbound email row, so the reply-cancels-sequence behavior — correctly coded and unit-tested — can't actually fire yet. Not a defect in this plan's scope; flagged so the "cancels on reply" demo claim isn't taken as end-to-end proven.

### Minor — Nice to Have

- `src/lib/db/sequences.ts:23`, `src/lib/db/mailboxes.ts:60` — `data[0]!` missing the "why it's safe" comment that `cases.ts`/`emails.ts` carry for the identical pattern (inconsistency, not a real safety gap).
- `src/lib/research/brightdata.ts:23-27` — redundant `Promise.race`/`rejectAfter(8000)` wrapper around `fetchJson`, which already enforces its own 8000ms timeout; adds complexity and a documented test workaround for no real benefit.
- `src/lib/llm/client.ts:51-55` and `src/lib/research/brightdata.ts:23-27` — `rejectAfter`'s `setTimeout` is never `clearTimeout`'d when the main promise wins the race (soft dangling-timer risk, not functional).
- `logEvent` calls in `research.ts`/`write.ts`/`followup.ts` aren't wrapped in a best-effort try/catch the way fanout/reset routes are — an audit-log failure after a successful send would 500 the route (idempotency makes retries harmless, but it's noisy). Pre-existing pattern from `discover.ts`, not new.
- `outlook-provider.ts:139-141` synthesizes a placeholder `providerMessageId`/`threadId` since Graph's `sendMail` returns no body — Outlook-originated threads won't functionally thread via `In-Reply-To`/`References` in a real mail client. Explicitly called out and accepted as a known limitation in the plan itself.
- `research.ts:19` — `sourceUrl` validated as `z.string().nullable()` rather than `z.string().url().nullable()`; matches the plan's reference code verbatim.
- Stale comments referencing the old root-level `architecture.md` path in `company-key.ts:6`, `crm.ts:11`, `group-lead.ts:21`, `write.ts:63`, `map-email-status.ts:20` (file moved to `.claude/architecture.md`; nothing breaks, just stale cross-references).
- `CLAUDE.md:13` says "UPDATE THE roadmap.md" with no path, ambiguous now that it lives at `.claude/roadmap.md` (interpreted consistently so far).
- `error.tsx` doesn't log/report the caught error anywhere — consistent with the rest of the app having no error-reporting integration, not a new gap.

---

## Per-Phase Detail

### Phase 1–2 — Foundations + Data Access Layer (Tasks 1–8)

**Test results:** `npx vitest run` (targeted): 10 test files / 98 tests passed. Full suite at time of this review: 38 files / 226 tests passed. `tsc --noEmit`: clean.

**Assessment: Ready to merge — Yes.** No Critical or Important issues.

**Strengths:**
- Migration `0005_p2_pipeline.sql` matches the plan's index/RPC spec exactly; `claim_mailbox_send` is a single atomic `UPDATE ... RETURNING`, not read-then-write.
- Idempotency wiring (`claimOutboundEmail`, `createSequence`, `addSuppression`) all correctly `upsert(..., ignoreDuplicates: true)` against the right unique constraint and return `null` on conflict rather than throwing.
- Every DB function wraps `{ data, error }` into `AppError('DB_ERROR', ...)` with structured context; no bare `Error`, nothing swallowed.
- `llm/client.ts` sets explicit token ceilings, logs usage only after success, reads both AI-SDK usage-field shapes defensively, never logs prompt/response bodies.
- `research/brightdata.ts` validates the SERP response with Zod and never throws on empty results.
- Reasonable forward-looking additions beyond the plan's literal list (`getEmailById`, `listDraftEmailsForClient`, `resetDailyCounters`) — correctly staged for Phase 6/17, not scope-narrowing.
- Test quality strong throughout: Arrange-Act-Assert, `it('should ... when ...')`, boundary-only mocking, every success + error path covered.
- No `any`, `console.log`, `TODO`/`FIXME`/`HACK`, or commented-out code found.

Only Minor findings (see consolidated list above: `!` comment inconsistency, redundant timeout wrapper, uncleaned timers).

### Phase 3–5 — Sending Infra + Research + Write/Send/Follow-ups (Tasks 9–17)

**Test results:** 13 test files / 45 tests passed (targeted run). `tsc --noEmit`: clean. No `console.log`/`TODO`/`FIXME`/`HACK` found across reviewed files.

**Assessment: Ready to merge — With fixes** (the fixes are Important-severity, not Critical; see #6 and #7 above).

**Strengths:**
- Claim-before-send ordering verified correct in both `write.ts` and `followup.ts` — `claimOutboundEmail` always precedes `sendViaMailbox`.
- Rotation genuinely sorts least-used-first and falls through on a failed claim; jitter is a real randomized `setTimeout`, not decorative.
- Follow-up cadence math (`FOLLOWUP_DELAYS_SECONDS` = 3/7/14 days, step-index arithmetic) verified correct under manual trace for steps 1→2→3→exhausted.
- The implementation improves on the plan's own reference code in places — e.g. `write.ts` uses the typed `advanceSequence` DB helper instead of the plan's inline `supabase.from(...)` call, and `followup.test.ts` fixes a subtle bug present in the plan's own draft test (didn't override `current_step` before asserting the "stop after final step" case).
- QStash signature verification confirmed first in all 6 routes, before any parsing/DB access, matching the `discover`/`discover-fanout` reference pattern.
- Gmail/Outlook threading logic correctly conditional (headers added only when a prior message exists) and tested both ways.

### Phase 6–7 — Inbox UI + Docs + Verification (Tasks 18–20)

**Test results:** Full suite 38 files / 226 tests passed. `tsc --noEmit`: clean. `eslint`: 1 pre-existing unrelated warning (unused var in `env.test.ts`), 0 errors. `next build` skipped (not required for this review).

**Assessment: Ready to merge — No.** 3 Critical issues confined to `src/app/inbox/actions.ts` (see Consolidated Issue List #1–3).

**Strengths:**
- `/inbox` is the only route in the app with both `loading.tsx` and `error.tsx` — genuinely implements all four UI states, ahead of `/crm` and `/settings`.
- Correct Server Component → Server Action discipline; no client-side fetch to an API route anywhere.
- `draft-row.tsx` correctly wraps the approve handler in `useTransition` with a disabled/pending state.
- `error.tsx` shows a generic message only, no leaked internals.
- Tenant isolation on the **read** path is sound — RLS `emails_select` policy scopes rows correctly; a crafted id for another tenant returns `null`.
- `.claude/roadmap.md` phase write-ups are detailed and accurate for Phases 1–6, including real test counts per phase.

---

## Recommendations (priority order)

1. **Block on Critical #1–3** before any `human_approve` client is exposed to `/inbox`: add sequence creation on approval, add an operator-role check + admin-client write path, add an atomic claim-before-send transition.
2. Re-open Task 19 Step 2 specifically for `.claude/architecture.md` §10 (five-minute fix) and flip the roadmap's Phase 7 status.
3. Add a narrow case-name lookup query instead of `listCasesWithLeads` on `/inbox`.
4. Decide, as the plan owner, how to handle stuck-case recovery for the pre-existing status-before-loop pattern in `research`/`write` routes (Important #6) — this predates P2's implementation and also affects the P1 pattern it was copied from.
5. Add a 2+-mailbox test for `sender.ts` rotation/fallback (Important #7).
6. Add an RLS integration test that signs in as a non-operator and asserts an `emails`/`mailboxes` UPDATE silently no-ops — this class of bug is structurally invisible to unit-level mocked tests.
7. When inbound-mail ingestion ships, add an end-to-end test for `write → followup(reply arrives) → completed`.

---

## Verification Commands Run (for reference)

```
npx tsc --noEmit                    # clean, all three reviewers
npx vitest run                      # 38 files / 226 tests passed (full suite)
npx eslint .                        # 1 pre-existing warning, 0 errors
```
