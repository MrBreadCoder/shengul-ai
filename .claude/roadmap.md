# Roadmap — AI B2B Lead Generation & Outreach System

**Companion to:** `architecture.md`
**Date:** 2026-07-18

Phases are ordered so each one produces something demonstrable and de-risks the next. Email acquisition (the #1 risk) is proven early, in P1, before we build the agents that depend on it.

---

## P0 — Foundations DONE

**Goal:** an authenticated Next.js app on Vercel + Supabase, with the full schema and mailbox connectivity, but no pipeline yet.

- [ ] Next.js app scaffolded, deployed to Vercel.
- [ ] Supabase project: Postgres schema for all tables in `architecture.md §5`.
- [ ] Supabase Auth + **Row-Level Security** policies (per-`client_id` isolation; operator role spans clients).
- [ ] Mailbox OAuth: connect a Gmail account (Gmail API) and an Outlook account (MS Graph); store tokens in `mailboxes`; send a test email from each.
- [ ] `events` audit-log helper used everywhere.
- [ ] QStash configured; a "hello" cron + signed-request verification proven end-to-end.
- [ ] Secrets management (Brightdata, Gemini, Emailable, QStash, OAuth) in place.

**Demo:** log in as an operator, connect a Gmail + Outlook mailbox, send a test email from each, see the event logged. (we dont have the needed credentals right now so just build he sytem we are going to test later)

FINISHED. DONE
---

## P1 — Apollo Discovery + Verify + CRM View

**Goal:** every active campaign pulls up to 50 new ICP-matching people a day from **Apollo.io**, gets each email revealed *and* verified by Apollo in the same call (no separate verifier), groups verified people into cases, and appears in `/crm`. This validates the riskiest assumption (real, verifiable emails) before any outreach is built.

**Replaces:** the original Brightdata+Gemini **Lead-Gen Agent** and the **Emailable**-based Email Acquisition + Verify system are both gone, merged into one deterministic, LLM-free Apollo pipeline. Full rationale and API details in `architecture.md §6 Stage 1` and `§12`. See implementation plan: `docs/superpowers/plans/2026-07-18-apollo-people-search-p1.md`.

- [x] Schema: `leads.source_id` (Apollo person id, dedup key, unique per campaign) + `cases.company_key` (deterministic company dedup key, unique per campaign).
- [x] Env: drop `EMAILABLE_API_KEY`, add `APOLLO_API_KEY` (requires an Apollo plan with API + master-key access — see `architecture.md §12`).
- [x] **Apollo client** (`src/lib/apollo/`): `searchPeople` (`POST /mixed_people/api_search`, ICP filters, no credits) + `bulkMatchPeople` (`POST /people/bulk_match?reveal_personal_emails=true`, ≤10 people/call, reveals email + Apollo's own verification status).
- [x] ICP → Apollo filter mapping (`personTitles`, `organizationLocations`, `employeeRange`, `keywords`, `personSeniorities` → `person_seniorities[]`, `contactEmailStatuses` → `contact_email_status[]`) + Apollo `email_status` → `lead_email_status` mapping (`verified`→verified, `catch_all`→risky, `unverified`/`update_required`→unverified, `unavailable`/missing→not_found). Filter params verified against `docs.apollo.io/reference/people-api-search` (2026-07-19), including `q_organization_domains_list[]` for pass-2 company targeting. Exclude filters added: `excludeOrganizationLocations` → Apollo's `organization_not_locations[]` (confirmed real via a third-party Organization Search docs mirror — Apollo's own reference page under-documents this endpoint); `excludeKeywords` has no confirmed Apollo API equivalent, so it's matched client-side against candidate `organizationName`/`title` post-fetch (`src/lib/apollo/exclude-keywords.ts`). Both surfaced in the `/campaigns` creation form. See `docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md`.
- [x] **Discovery pipeline**: `/api/pipeline/discover-fanout` (daily QStash cron) → one QStash message per active campaign → `/api/pipeline/discover`. Pulls up to `campaigns.daily_target` (default 50) new people per campaign per day, skips already-known Apollo ids before enriching (saves credits), inserts `leads`.
- [x] **Grouping** system: deterministic `company_key` (domain, else normalized company name) → case; 1+ Apollo-verified person activates a case. Optional LLM tiebreaker for ambiguous no-domain names remains backlog (unchanged from original design).
- [x] **Multi-threading**: discovery runs in two passes (`src/lib/pipeline/discover.ts`) — pass 1 picks at most 1 person per brand-new company; pass 2 runs a domain-scoped Apollo search targeting every company (today's or an earlier day's) sitting at exactly 1 verified contact, trying to find a second person there. A company with only 1 qualifying candidate still passes — case activation is unchanged. See `docs/superpowers/plans/2026-07-19-apollo-multi-thread-discovery.md`.
- [x] Campaign setup UI (`/campaigns`): client, name, value prop, booking link, Apollo ICP filters, daily Apollo quota.
- [x] **/crm** page: pipeline board of cases + per-case people list, read-mostly, RLS-scoped.

**Demo:** create a campaign with an ICP, run discovery (manually or via the daily cron), watch Apollo-verified leads group into cases and appear in `/crm`.
**Go/No-Go gate:** is Apollo's verified-email yield for the client's ICP acceptable? If not, backlog a secondary verifier or a dedicated `EmailFinder` — no schema change needed, since verification already lives behind `lead_email_status` + `leads.raw`.

---

## P2 — Research + Write + Send + Follow-ups

**Goal:** a case goes from "ready" to a sent cold email, with the 3/7/14-day follow-up cadence running.
**Implementation plan:** `docs/superpowers/plans/2026-07-19-p2-research-write-send-followups.md`.

**Phase 1 — Foundations (Tasks 1–3): DONE**
- [x] Migration `0005_p2_pipeline.sql` — idempotency indexes (`emails_outbound_step_uniq`, `sequences_lead_uniq`, `suppressions_client_email_uniq`) + atomic `claim_mailbox_send` / `reset_mailbox_daily_counters` RPCs; `src/types/database.ts` `Functions` updated.
- [x] Gemini LLM wrapper (`src/lib/llm/client.ts`): `generateJson` / `generateText`, timeout, token-usage logging, `AppError` mapping. Added `ai` + `@ai-sdk/google` deps (via `pnpm`, not `npm` — this repo is pnpm-only, `npm install` corrupts the tree).
- [x] `WebResearch` interface + Brightdata SERP client (`src/lib/research/`); relies on `fetchJson`'s own AbortController timeout (an earlier redundant `Promise.race` wrapper was removed in the code-review pass).

**Phase 2 — Data access layer (Tasks 4–8): DONE**
- [x] `src/lib/db/case-knowledge.ts` — `insertKnowledge` / `listKnowledgeForCase`.
- [x] `src/lib/db/emails.ts` — `claimOutboundEmail` (claim-then-send idempotency slot), `markEmailSent`, `markEmailFailed`, `listThreadEmails`, `hasInboundReply`.
- [x] `src/lib/db/sequences.ts` — `createSequence`, `getSequenceById`, `advanceSequence`, `stopSequence`.
- [x] `src/lib/db/suppressions.ts` — `isSuppressed`, `addSuppression`.
- [x] Mailbox/case/lead/campaign helpers added: `listMailboxesByIds`, `claimMailboxSend`, `getCaseById`, `updateCaseStatus`, `listCasesByStatus`, `getLeadById`, `listActiveLeadsForCase`, `getCampaignForCase`.
- Full suite green: 28 test files, 183 tests; `tsc --noEmit` and `eslint` clean.

**Phase 3 — Sending infrastructure (Tasks 9–10): DONE**
- [x] Mailbox provider threading: `SendEmailInput` gains `threadId?` / `inReplyToMessageId?` / `references?`; Gmail threads via `raw` payload `threadId` + `In-Reply-To`/`References` MIME headers; Outlook threads via Graph `internetMessageHeaders`.
- [x] Mailbox Sender (`src/lib/mailbox/sender.ts`): `sendViaMailbox` — least-used-first rotation across a campaign's mailboxes, atomic `claim_mailbox_send` cap claim (skips to the next mailbox on cap/unhealthy), jitter before send, refreshed-token persistence via `updateMailboxOauth`, throws `RATE_LIMITED` when every mailbox is exhausted.

**Phase 4 — Research stage (Tasks 11–12): DONE**
- [x] Research pipeline (`src/lib/pipeline/research.ts`): `runResearchForCase` — Brightdata web search → Gemini-generated cited dossier (Zod-validated) → `case_knowledge` rows → case `status = ready`, with a `pipeline.research.completed` event.
- [x] `/api/pipeline/research-fanout` (fans every `new` case to `/api/pipeline/research`) + `/api/pipeline/research` (claims `new → researching` before running, no-ops `case_not_new` on retry) + `scripts/schedule-research-cron.ts` (daily 07:00 UTC).
- Full suite green: 31 test files, 195 tests; `tsc --noEmit` and `eslint` clean.

**Phase 5 — Write, send & follow-ups (Tasks 13–17): DONE**
- [x] QStash `publishJsonWithDelay` (`src/lib/qstash/client.ts`) — same publish path as `publishJson`, plus a `delay` in seconds.
- [x] Follow-up sequencer (`src/lib/pipeline/followup.ts`): `FOLLOWUP_DELAYS_SECONDS` = `[3d, 7d, 14d]`, `MAX_FOLLOWUP_STEP = 3`. `runFollowupStep` guards on `state === 'active' && current_step === step - 1` (stale/duplicate QStash delivery → `skipped`), ends the sequence on any inbound reply (`completed`), stops+suppresses on a missing/suppressed lead email, drafts a Gemini nudge referencing the first outbound email, claims the `(lead, step, outbound)` slot before sending, and either enqueues the next delayed step or — after step 3 — stops the sequence and marks the case `dead`.
- [x] Email-Writer pipeline (`src/lib/pipeline/write.ts`): `runWriteForCase` builds a dossier-grounded prompt per active/verified lead, claims the `(lead, step 0, outbound)` slot before send, gates first-touch send on reply mode (`auto_send`/`hybrid` send immediately, `human_approve` leaves a `draft`), sends via `sendViaMailbox`, opens a `sequences` row, and enqueues the first follow-up via `publishJsonWithDelay`. Bug fixed vs. the original plan draft: uses `advanceSequence` (the `src/lib/db/sequences.ts` helper) to persist the QStash message id instead of a raw `supabase.from('sequences')` call, keeping all data access inside `src/lib/db/` per `QUALITY.md`.
- [x] `/api/pipeline/write-fanout` (fans every `ready` case to `/api/pipeline/write`, daily 08:00 UTC cron) + `/api/pipeline/write` (claims `ready → contacted` before running) + `scripts/schedule-write-cron.ts`.
- [x] `/api/pipeline/followup` — signature-verified, step validated against `MAX_FOLLOWUP_STEP`, delegates to `runFollowupStep` (idempotent via the sequence-state guard + claim slot, no extra route-level dedup needed).
- [x] Mailbox daily-reset: `resetDailyCounters` (`src/lib/db/mailboxes.ts`, calls the `reset_mailbox_daily_counters` RPC) + `/api/pipeline/mailbox-reset` + `scripts/schedule-mailbox-reset-cron.ts` (daily 00:00 UTC).

**Phase 6 — Human-approval UI (Task 18): DONE**
- [x] `listDraftEmailsForClient` + `getEmailById` added to `src/lib/db/emails.ts` (RLS-scoped — callers must pass the session-bound `createServerClient`, never the admin client).
- [x] `/inbox` (`src/app/inbox/`): `page.tsx` (loading/error/empty/success states via `loading.tsx` + `error.tsx` + the empty-drafts branch), `draft-row.tsx` (client component, `useTransition` around the approve action), `actions.ts` — `approveDraft` Server Action validates the session, re-validates the draft is still `status = 'draft' && direction = 'outbound'`, sends via the case's campaign mailboxes, marks it sent, revalidates `/inbox`.
- [x] **Code-review fixes (P2 review `docs/superpowers/reviews/2026-07-19-p2-code-review.md`, Critical #1–3):** `approveDraft` now (1) gates on `appUser.role === 'operator'` and writes through `createAdminClient()` so RLS can't silently no-op the status write, (2) atomically claims the draft (`draft → queued` via new `claimDraftForSend`, `.eq('status','draft')`) before sending — a lost race returns without a second send, and (3) mirrors `write.ts`'s post-send branch to create the `sequences` row and enqueue the step-1 follow-up (3/7/14-day cadence now fires for `human_approve` approvals), guarded on `sequence_step === 0`; failed sends mark the email `failed` and rethrow.

**Phase 7 — Docs + verification (Tasks 19–20): DONE**
- [x] `.claude/architecture.md` §10 updated for the finished P2 pipeline shape — Web-research row points at `WebResearch`/`src/lib/research/brightdata.ts`, LLM/QStash rows point at `src/lib/llm/client.ts` and `src/lib/qstash/client.ts`.
- [x] Stale root-level `architecture.md` cross-references corrected to `.claude/architecture.md` across `crm.ts`, `write.ts`, `group-lead.ts`, `company-key.ts`, `map-email-status.ts`; `CLAUDE.md` roadmap pointer now names `.claude/roadmap.md`.
- [x] Final verification pass: `tsc --noEmit` and `eslint` clean (1 pre-existing unrelated warning in `env.test.ts`).

**Code-review Important/Minor fixes (P2 review, items #4–9 + Minor):**
- [x] **#6 stuck-case recovery** — migration `0006_stuck_case_sweep.sql` adds `find_stuck_cases(cutoff, limit)` (SECURITY DEFINER): surfaces `researching` cases past a cutoff (unambiguously stranded) and `contacted` cases that still have an active/verified lead with no step-0 outbound email (so completed cases are excluded, avoiding wasted LLM re-runs). New `listStuckCases` DB helper + `/api/pipeline/stuck-sweep` route (resets `researching → new` / `contacted → ready` and re-publishes; claims/idempotency prevent double-sends) + `scripts/schedule-stuck-sweep-cron.ts` (every 15 min). The status-before-loop claim stays as the concurrency guard.
- [x] **#5 `/inbox` over-fetch** — replaced `listCasesWithLeads` with a narrow `listCaseCompanyNames` (`select('id, company_name')`), no longer pulling every case's full lead list just to build the name map.
- [x] **#8 function length / DRY** — extracted shared `scheduleFirstFollowup` into `followup.ts`; `write.ts` `processLead` and `/inbox` `approveDraft` both call it instead of duplicating the create-sequence + enqueue block.
- [x] **#7 rotation tests** — `sender.test.ts` gains multi-mailbox cases: least-used-first ordering, fall-through on a capped first candidate, and unhealthy-mailbox skip.
- [x] **Minor** — `logEventSafe` best-effort wrapper now used for post-action audit logs in `research`/`write`/`followup`; removed the redundant `Promise.race` timeout in `brightdata.ts` (fetchJson already enforces + clears it); `llm/client.ts` `withTimeout` now clears its timer on the fast path; added the "index 0 exists" comment to `sequences.ts`/`mailboxes.ts` `data[0]!`.

**Demo:** a `ready` case is written, sent from a rotated mailbox under its daily cap, and a 3/7/14-day follow-up is scheduled — firing on cadence when there is no reply, cancelling when a reply arrives, marking the case `dead` after step 3; a `human_approve` campaign's drafts appear in `/inbox` and send on approval; a case stranded mid-research/write is re-queued by the stuck-sweep cron.
- Full suite green: 39 test files, 248 tests; `tsc --noEmit` and `eslint` clean (1 pre-existing unrelated warning).

---

## P3 — Reply Handling + Knowledge Gap + Price Handoff DONE

**Goal:** the system holds a real conversation and knows when to escalate or hand off.
**Implementation plan:** `docs/superpowers/plans/2026-07-19-p3-reply-handling.md`.

**Phase 1 — Schema + DB helpers + provider read capability (Tasks 1–5): DONE**
- [x] Migration `0007_p3_reply_handling.sql` — `mailboxes.inbound_cursor` (opaque per-mailbox poll cursor), `emails.in_reply_to_email_id` (reply→inbound link), plus nullable-column unique indexes `emails_provider_message_id_uniq` / `emails_in_reply_to_uniq` / `knowledge_requests_email_uniq` (not partial indexes — required by supabase-js `upsert({ onConflict })`, which emits an unqualified `ON CONFLICT`). `src/types/database.ts` updated for both new columns.
- [x] `src/lib/db/emails.ts` — `insertInboundEmail` (dedup on `provider_message_id`), `claimReplyEmail` (dedup on `in_reply_to_email_id`, one reply per inbound); `src/lib/db/leads.ts` — `findContactedLeadByEmail` (most-recent case-attached lead by sender address — provider-agnostic, since Outlook synthesizes outbound thread ids).
- [x] `src/lib/db/sequences.ts` — `pauseActiveSequenceForLead` (active→paused, guarded), `stopSequenceForLead` (active/paused→stopped|completed); `src/lib/db/mailboxes.ts` — `listAllMailboxes` (admin-scoped, cron fan-out), `updateInboundCursor`.
- [x] `src/lib/db/knowledge-requests.ts` (new) — `createKnowledgeRequest` (dedup on `email_id`), `getKnowledgeRequestById`, `listOpenKnowledgeRequestsForClient` (RLS-scoped, for `/inbox`), `claimKnowledgeRequestAnswer` (atomic `open→answered` claim, admin client).
- [x] `MailboxProvider.fetchInbound` added to the interface (`InboundMessage` / `FetchInboundResult`). Gmail implementation uses the History API (`historyId` cursor, paginated, re-baselines on a 404 expired-cursor, skips `SENT`/`DRAFT` labels, walks MIME parts for `text/plain`) + added `gmail.readonly` scope. Outlook implementation uses Graph delta queries (`@odata.deltaLink` cursor, paginated via `@odata.nextLink`, skips drafts/senderless messages, plain-text body via `Prefer: outlook.body-content-type="text"`) + added `Mail.Read` scope. A pre-existing `provider.test.ts` compile-guard stub updated to implement `fetchInbound` too.
- Full suite green: 40 test files, 298 tests; `tsc --noEmit` and `eslint` clean (1 pre-existing unrelated warning in `env.test.ts`).

**Phase 2 — Mailbox reader, ingestion, Reply Agent, knowledge-answer, poll routes (Tasks 6–10): DONE**
- [x] Shared `parseMailboxTokens` (`src/lib/mailbox/tokens.ts`, extracted from `sender.ts`'s local copy — `sender.ts` now imports it, no behavior change) + `readInboundForMailbox` (`src/lib/mailbox/reader.ts`): runs a mailbox's `fetchInbound`, best-effort persists any refreshed access token (persistence failure is logged, not thrown — the messages were already fetched).
- [x] Ingestion pipeline (`src/lib/pipeline/inbound.ts`) — `ingestInboundForMailbox`: matches each inbound message to a contacted lead by sender address, inserts it (deduped on `provider_message_id`), pauses that lead's sequence, fans one QStash message per new inbound to `/api/inbound/reply`, advances the mailbox cursor only after the loop (safe on a mid-loop crash/retry since insertion is deduped).
- [x] Reply Agent (`src/lib/pipeline/reply.ts`) — `classifyReply` (Gemini via `generateJson`, dossier + thread grounded, never invents facts), `replyDisposition` (`human_approve`→draft, `auto_send`→send, `hybrid`→send iff confidence ≥ 0.75), `sendOrDraftReply` (claims the one-reply-per-inbound slot via `claimReplyEmail`, sends or leaves a draft), `runReplyForInbound` routes on intent: `price` → booking-link reply + suppress(`price_handoff`) + stop + `hot_handoff`; `not_interested` → suppress(`manual`) + stop + `lost`, no reply; `question`/`interested`/`other` answerable → reply per disposition; unanswerable → `createKnowledgeRequest`, never fabricates.
- [x] Knowledge-answer pipeline (`src/lib/pipeline/knowledge-answer.ts`) — `runKnowledgeAnswer`: after a human answers a `knowledge_request` in `/inbox`, generates a reply in the AI's voice grounded strictly on the human-supplied fact (`generateText`) and sends via the same `sendOrDraftReply` idempotency path (treated as fully confident since a human confirmed the fact).
- [x] Routes: `/api/inbound/poll-fanout` (cron entry, fans `listAllMailboxes` → one QStash message per mailbox at `/api/inbound/poll`) + `/api/inbound/poll` (Zod-validated `mailboxId`, 404 if the mailbox is gone, delegates to `ingestInboundForMailbox`) — both signature-verified, 401/400/500 mapped per `QUALITY.md`.
- Full suite green: 46 test files, 318 tests; `tsc --noEmit` and `eslint` clean (1 pre-existing unrelated warning in `env.test.ts`).

**Phase 3 — Reply route, cron script, knowledge-request UI (Tasks 11–13): DONE**
- [x] `/api/inbound/reply` route — signature-verified, Zod-validated `emailId`, delegates to `runReplyForInbound`, 401/400/500 mapped per `QUALITY.md`.
- [x] `scripts/schedule-inbound-poll-cron.ts` — registers the `/api/inbound/poll-fanout` QStash schedule (default `*/5 * * * *`, overridable via argv), mirrors `schedule-write-cron.ts`.
- [x] `/inbox` knowledge-request answer box — `answerKnowledgeRequest` Server Action (`src/app/inbox/actions.ts`, merged alongside the existing `approveDraft`): operator-gated, atomically claims the open request (`claimKnowledgeRequestAnswer`), stores the human fact as `case_knowledge` (kind `answer`, `created_by: 'human'`), then runs `runKnowledgeAnswer`. New `knowledge-request-row.tsx` client component (textarea + submit, `useTransition`). `page.tsx` now loads `listOpenKnowledgeRequestsForClient` alongside drafts and renders both sections (empty-state copy updated to cover "nothing needs attention" for either).
- Full suite green: 47 test files, 324 tests; `tsc --noEmit` and `eslint` clean (1 pre-existing unrelated warning in `env.test.ts`).

**Phase 4 — Docs + final verification (Task 14): DONE**
- [x] Marked P3 done in the roadmap header; `.claude/architecture.md` §10 updated with a `fetchInbound` note on the Gmail/Graph `MailboxProvider` rows.

**Demo (target):** reply to an outbound email with a question, an unknown fact, and a price ask — see answer, escalation box, and handoff behave correctly.

---
## P4 — Deliverability Hardening + Observability

**Goal:** safe to run at real volume across multiple clients.
**Implementation plan:** `docs/superpowers/plans/2026-07-22-p4-deliverability-hardening.md` — **all 18 tasks complete** (2026-07-22), covering the warmup ramp (per-client `standard`/`slow`/`none` profiles), bounce-rate mailbox health with a 6-hourly auto-pause sweep, DSN + out-of-office detection on the inbound path, centralised suppression enforcement in `sendViaMailbox`, per-mailbox and per-lead kill switches, and the runbook.

- [x] **Tasks 1-6 (schema, warmup math, health verdict, bounce/auto-reply detection, mailbox DB helpers, suppression lookup) — DONE**, unit-tested and typed, not yet wired into the send/inbound chokepoints (Tasks 7-9).
  - Task 1: `supabase/migrations/0012_p4_deliverability.sql` — `warmup_profile` enum (`clients` + `mailboxes`), `mailboxes.warmup_started_at`/`health_reason`/`health_changed_at`, drops `warmup_state`, adds `mailbox_send_stats(p_since)` RPC and re-signs `claim_mailbox_send(p_mailbox_id, p_effective_cap)`. Mirrored in `src/types/database.ts`; `src/lib/seed/generate.ts` and `supabase/seed.sql` updated for the dropped column. **Unverified against a real Postgres** — Docker still unavailable on this machine; `supabase db reset` was not run.
  - Task 2: `src/lib/mailbox/warmup.ts` — pure `effectiveDailyCap`/`warmupInsertFields`, `WARMUP_START_CAP=5`, `WARMUP_INCREMENT=3`. 10/10 tests.
  - Task 3: `src/lib/mailbox/health.ts` — pure `evaluateBounceHealth`, `MIN_SENDS_FOR_HEALTH=20`, warning at 3%, block at 5%, blocked never auto-recovers. 9/9 tests.
  - Task 4: `InboundMessage.headers` added to `src/lib/mailbox/provider.ts`, populated by both `gmail-provider.ts` and `outlook-provider.ts` (Graph delta `$select` now includes `internetMessageHeaders`); `src/lib/mailbox/bounce.ts` — `detectBounce`/`detectAutoReply` from DSN headers/sender/subject/status-code. 80/80 mailbox-suite tests (one pre-existing Outlook URL assertion updated for the new `$select` field).
  - Task 5: `src/lib/db/mailboxes.ts` — `claimMailboxSend` now takes `effectiveCap`; added `setMailboxHealth`, `mailboxSendStats`, `updateMailboxWarmup`; `MailboxSummary`/`listMailboxesForViewer` widened with the new columns. 28/28 tests.
  - Task 6: `src/lib/db/suppressions.ts` — `getSuppression` returns `{ email, reason } | null` via `maybeSingle()`, replacing the old exact-count query; `isSuppressed` rebuilt on top of it (signature unchanged, callers in `write.ts`/`followup.ts` untouched). 7/7 tests.
  - Full repo suite: 80 test files / 692 tests green. `tsc --noEmit` has exactly one expected error (`src/lib/mailbox/sender.ts` calling `claimMailboxSend` with 2 args) — that's Task 8's job to fix.
- [x] **Tasks 7-13 (bounce/park DB writes, sender enforcement, bounce pipeline + inbound wiring, health-sweep cron, kill-switch routes, per-client warmup) — DONE**. Full repo suite: 83 test files / 723 tests green, `tsc --noEmit` clean.
  - Task 7: `src/lib/db/emails.ts` `markLatestOutboundBounced` (claims the newest `sent`/`delivered` outbound row via a status-guarded update, so a concurrent DSN can't double-count) and `src/lib/db/leads.ts` `parkLead`. `findContactedLeadByEmail`/`stopSequenceForLead` already existed from P3 and needed no changes. 57/57 tests.
  - Task 8: `src/lib/mailbox/sender.ts` — `sendViaMailbox` now requires `purpose: 'outreach' | 'reply'` and gates every send on `getSuppression` (outreach blocked by any reason, reply blocked only by `'bounced'`); `rotationOrder` now only excludes `'blocked'` (`'warning'` still rotates); the daily-cap claim uses `effectiveDailyCap` per-candidate instead of the raw `daily_cap`; a `401` from the provider send blocks the mailbox via `setMailboxHealth(..., 'auth_failure')`. All four call sites (`write.ts`, `followup.ts`, `reply.ts`, `inbox/actions.ts`) updated to pass `purpose`; `reply.ts`'s catch also short-circuits on `FORBIDDEN` (hard-bounced address) instead of rethrowing into a QStash retry loop. 17/17 sender tests, 705/705 repo-wide.
  - Task 9: new `src/lib/pipeline/bounce.ts` `handleBounce` — hard bounce suppresses + stops the sequence + parks the lead + flips the email to `bounced`; soft bounce only logs; no parseable recipient or no matching contacted lead logs `bounce.unmatched` and returns `'unmatched'`. 5/5 tests.
  - Task 10: `src/lib/pipeline/inbound.ts` now runs `detectBounce` before `detectAutoReply` before the lead match on every inbound message (bounce wins because a DSN can itself carry `Auto-Submitted: auto-replied`); neither branch stores an `emails` row or touches the sequence, so a DSN/OOO can never look like a human reply. `IngestSummary` gained `bounces`/`autoReplies`. 7/7 tests.
  - Task 11: new `src/lib/pipeline/mailbox-health.ts` `runMailboxHealthSweep` (re-evaluates every mailbox from `mailboxSendStats` over the 7-day `HEALTH_WINDOW_DAYS`), wired to `POST /api/pipeline/mailbox-health` (QStash-signed) and `scripts/schedule-mailbox-health-cron.ts` (default every 6h). Not yet registered against a live QStash — run the script once per environment after deploy. 5/5 tests.
  - Task 12: three new operator-only routes under `src/app/api/mailboxes/[id]/` — `pause` (→ `blocked`/`operator_paused`), `resume` (→ `ok`, clears the reason), `warmup` (body `{ profile }`, restarts the ramp via `warmupInsertFields`). All 403 for client-role, 404 for an unknown mailbox. 3/3 tests.
  - Task 13: `src/lib/db/clients.ts` `updateClientWarmupProfile`; `PATCH /api/clients/[clientId]` now accepts `{ name?, warmupProfile? }` (at least one required) instead of name-only; both OAuth callbacks (`mailboxes/google/callback`, `mailboxes/outlook/callback`) now read the connecting client's `warmup_profile` and stamp `warmupInsertFields(...)` on the new mailbox row instead of leaving warmup columns at their DB defaults. 21/21 clients tests, 8/8 PATCH-route tests (pre-existing, still green against the widened schema).
- [x] **Tasks 14-18 (per-lead stop action, /settings + case/client UI, the deliverability runbook, final docs pass) — DONE (2026-07-22)**. Plan fully implemented, 18/18 tasks. Full repo suite: 84 test files / 729 tests green, `tsc --noEmit` clean, `eslint .` reports only the 2 pre-existing `_omit`-unused warnings (0 errors).
  - Task 14: new `src/app/(app)/cases/[id]/actions.ts` `stopLead` Server Action — RLS-scoped read (`getLeadById` via the session client) proves the caller can see the lead, then re-checks `client_id` for a client-role caller before writing through the admin client (suppress `reason: 'manual'` if the lead has an email, `stopSequenceForLead(..., 'stopped')`, `parkLead`). Available to both operator and client-role sessions — unlike `approveDraft`, deciding "don't contact this person" is the client's call. 6/6 tests.
  - Task 15: `/settings` now shows the day's ramp (`sent/cap today`, "warming up" when the ramp cap is below the configured `daily_cap`) and `health_reason` in plain words on each `MailboxRow`; new `mailbox-controls.tsx` adds a warmup-profile `<select>` (posts to the Task 12 `warmup` route) and a Pause/Resume button (posts to `pause`/`resume`) with `router.refresh()` on success.
  - Task 16: new `stop-lead-button.tsx` (confirm dialog, same pattern as the client pause/archive controls) wired into the `/cases/[id]` contacts grid — parked leads show a plain "Stopped" label instead of the button; new `warmup-profile-select.tsx` on `/clients/[id]` PATCHes the client's default ramp profile for mailboxes connected from now on (existing mailboxes are unaffected — override those on `/settings`).
  - Task 17: `docs/runbooks/deliverability.md` — cron schedule table, the warmup cadence table, the health-threshold table with the `blocked`-recovery steps (`auth_failure` → reconnect; `bounce_rate_high` → check `/analytics` + Logs, consider pausing the offending campaign before resuming), an explicit "spam complaints are not observable" section, the kill-switch table (person → mailbox → campaign → client), the bounce-classification summary, and stuck-sequence recovery steps.
  - Task 18 verification actually run: `pnpm vitest run` (729/729), `pnpm tsc --noEmit` (clean), `pnpm eslint .` (0 errors). `pnpm build` **fails** on two pre-existing missing secrets in `.env.local` (`MAILBOX_ENCRYPTION_KEY`, `EMAILABLE_API_KEY`) — present in `.env.example` but never filled in on this machine, and no real values were fabricated to force a green build. This is unrelated to any P4 code change; the previously-noted `BRIGHTDATA_SCRAPE_ZONE` gap has since been filled in `.env.local`.
  - Design decisions worth remembering: `warning` health is a **soft** state (mailbox keeps sending) — only `blocked` pulls a mailbox out of rotation; a `blocked` mailbox **never** auto-recovers, only an operator's explicit Resume or the auth-failure→reconnect flow clears it; `sendViaMailbox`'s new `purpose` parameter is the only thing that changes suppression enforcement (`'outreach'` blocked by any reason, `'reply'` blocked only by `'bounced'`); the health metric is fed by **hard bounces only** (`markLatestOutboundBounced`), never soft/unparseable ones.
  - `0012_p4_deliverability.sql` is still unverified against a real Postgres — Docker remains unavailable on this machine. Same caveat as `0008_analytics.sql` below.
- [x] **Analytics dashboard (`/analytics`)** — plan: `docs/superpowers/plans/2026-07-21-analytics-dashboard.md`. Migration `0008_analytics.sql` adds five `stable` **SECURITY INVOKER** aggregate functions (`analytics_overview`, `analytics_daily`, `analytics_by_campaign`, `analytics_mailboxes`, `analytics_event_counts`) so RLS decides each viewer's row set — operators aggregate every client, client-role users only their own; proven by `src/lib/db/analytics.integration.test.ts`. `src/lib/db/analytics.ts` wraps the RPCs, `src/lib/analytics/{range,rates,sparkline}.ts` hold the pure logic, and `/analytics` is a Server Component rendering stat tiles, per-campaign and per-mailbox tables, an agent-activity breakdown, and inline-SVG sparklines (no chart library, no new dependencies). `realtime-refresher.tsx` subscribes to Supabase Realtime `postgres_changes` on `emails`/`leads`/`cases` and debounces a `router.refresh()`, so the server recomputes the metrics live. Window semantics: leads/cases/events by `created_at`, outbound email by `coalesce(sent_at, created_at)`, "sent" includes `bounced`; columns marked SNAPSHOT (active sequences, case-status board) ignore the date range by design. Reached from the CRM header link.
  - **Still unverified against a database** (no Docker on the dev machine): `0008_analytics.sql` has never been applied, `pnpm test:integration` has never run, and the Realtime auto-refresh has not been exercised in a browser. Run `pnpm supabase start && pnpm supabase db reset`, then `set -a; . ./.env.local; set +a; pnpm test:integration`, then the browser checks in plan Task 8 Step 3 before treating this as done.
- [x] Runbook: renew subscriptions, rotate tokens, recover stuck sequences — `docs/runbooks/deliverability.md` (Task 17 above).

**Demo:** run several campaigns concurrently within caps; dashboard shows the funnel and mailbox health; kill-switch halts a campaign instantly.

---

## Later / Backlog (post-MVP)

- ~~Dedicated `EmailFinder` provider, or a secondary verifier (e.g. Emailable) layered on top of Apollo, if verified-address yield or accuracy is low.~~ The Emailable half **shipped 2026-07-21** as a deliverability guard — see the entry below. A dedicated `EmailFinder` provider remains backlog.
- Upstash Workflow for durable multi-step agent runs (only if needed).
- A/B testing of subject lines / openers.
- Client-facing notifications (email/Slack) beyond in-app.
- More reply intents (reschedule, referral to colleague, out-of-office detection).
- Self-serve client onboarding + billing (explicitly out of scope for MVP).

---

## Code Review Fixes (2026-07-20)

Fixed 10 code-review findings across the inbound/reply pipeline (all verified against current code, tests updated, `tsc`/`eslint`/`vitest` clean):
- Gmail history pagination now only advances the cursor on a terminal page; a `MAX_HISTORY_PAGES` truncation preserves the original cursor for retry.
- `answerKnowledgeRequest` recovers from a claim lost to a prior crashed attempt (answered but no reply yet) instead of a permanent no-op.
- Knowledge-answer textarea has an `aria-label`.
- `findContactedLeadByEmail` now requires outbound-sent evidence via the receiving mailbox (not just `case_id`) and fails closed (null) on an ambiguous multi-lead match instead of picking the newest.
- LLM call timeout now rejects with `EXTERNAL_TIMEOUT` before aborting, so the race can't resolve to a generic abort error.
- `updateMailboxOauth` supports an optional compare-and-swap on the previously read oauth snapshot; `readInboundForMailbox` uses it and skips the write entirely when tokens didn't change.
- Inbound ingest retries pause + publish for an already-stored (but incomplete) inbound row instead of skipping forever after a crash.
- `sendOrDraftReply` no longer swallows `RATE_LIMITED`: it rethrows and leaves the row `queued` for a QStash retry instead of marking it failed permanently.

Skipped as not applicable / out of scope: full thread/message-correlation matching (superseded by the outbound-evidence approach; existing code comment already documents thread ids as unreliable on Outlook) and a durable outbox/claim-state redesign for inbound processing (the idempotent-retry approach above achieves the same outcome without a schema change).

## Multi-Agent Case Research (in progress, 2026-07-20)

Replacing the single shared search+LLM research call per case with one agent
per subject (company + each active lead). Plan: `docs/superpowers/plans/2026-07-20-multi-agent-case-research.md`.
Design: `docs/superpowers/specs/2026-07-20-multi-agent-case-research-design.md`.

**Tasks 1–5 of 8: DONE**
- [x] `src/lib/http/fetch-text.ts` — raw-text HTTP fetch with timeout + `AppError` (scrape returns markdown, not JSON).
- [x] `env.BRIGHTDATA_SCRAPE_ZONE` added (`env.ts`, `.env.example`, `env.test.ts` fixture); also added to `vitest.config.ts`'s stub env block (the plan didn't mention this file, but its module-scope `loadEnv(process.env)` stub needed the new key too, or every test importing `@/lib/env` would throw at import time).
- [x] `WebResearch` interface gains `scrape(url): Promise<string>`; `ResearchLead` moved into `provider.ts` as a shared type.
- [x] `brightdataResearch.scrape` implemented via Brightdata Web Unlocker (`data_format: markdown`), truncated to `MAX_SCRAPE_CHARS = 6_000`.
- [x] `generateWithTools` added to `src/lib/llm/client.ts` — multi-step tool-calling wrapper (`stopWhen: stepCountIs(maxSteps)`) reusing the existing `withTimeout`/`logUsage`/`AppError` pattern.

**Tasks 6–7 of 8: DONE**
- [x] `src/lib/research/tools.ts` — `buildResearchTools` wraps `WebResearch.search`/`scrape` as AI-SDK tools; failures return `{ error }` results instead of throwing, so the model can route around a bad call instead of the whole agent loop dying.
- [x] `src/lib/research/agent.ts` — `runResearchAgent`: gather phase (`generateWithTools`, 4-step search+scrape budget, role-specific system prompt for `company` vs `person`) → extract phase (`generateJson`, same anti-hallucination rules as the original `research.ts`). `ResearchAgentRole` discriminated union, `AgentDossierEntry` inferred from the Zod schema.
- [x] `src/lib/pipeline/research.ts` rewritten: `runResearchForCase` now builds `[companyRole, ...leadRoles]`, runs them via `Promise.allSettled`, merges fulfilled entries, logs `pipeline.research.agent_failed` per rejected agent. All-agents-failed leaves the case in `researching` (for the stuck-sweep to retry) instead of flipping to `ready` with an empty dossier; `route.ts`'s call signature is untouched.
- Fixed two `noUncheckedIndexedAccess` type errors the plan's test snippets didn't anticipate for this repo's tsconfig (`tools.test.ts` indexing into `ToolSet`, `agent.test.ts` indexing into `mock.calls[0]`) — resolved with a documented `!`/optional-chaining, not a suppression.
- Full suite green: 50 test files, 358 tests. `tsc --noEmit` and `eslint` clean (1 pre-existing unrelated warning in `env.test.ts`).

**Task 8 of 8: DONE**
- [x] Full suite: 50 test files, 358 tests, all green. `tsc --noEmit` clean. `eslint` clean (1 pre-existing unrelated warning in `env.test.ts`).
- [x] Route smoke check: `src/app/api/pipeline/research/route.ts` still calls `runResearchForCase(admin, { research: brightdataResearch }, { clientId, caseId, companyName, companyDomain, valueProp, leads })` unchanged — no edit needed.

Multi-agent case research is complete: `runResearchForCase` now runs one Brightdata search+scrape agent per subject (company + each active lead) concurrently via `Promise.allSettled`, each extracting cited `case_knowledge` entries, replacing the old single shared search+LLM call.

## Bugfix: server env schema crashed the browser (2026-07-21)

Symptom: `Runtime AppError — Invalid environment configuration: <all 15 vars> received undefined` at `src/lib/env.ts:30`, even with a fully populated `.env.local`.

Root cause: `src/lib/supabase/client.ts` is imported by Client Components (`app/login/page.tsx`, `app/analytics/realtime-refresher.tsx`) and imported `@/lib/env`, whose module-scope `loadEnv(process.env)` then ran in the browser. Next.js inlines `NEXT_PUBLIC_*` only for literal `process.env.X` member access — passing the whole `process.env` object yields `{}` client-side, so every var read as undefined. Confirmed by finding the env module compiled into `.next/static/chunks`, while SSR of `/login` returned 200.

- [x] `src/lib/env-parse.ts` — shared `parseEnv(schema, source)` (Zod → `AppError('CONFIG_ERROR')`), so both env modules keep one error shape.
- [x] `src/lib/env-public.ts` — client-safe `publicEnvSchema` / `loadPublicEnv` / `publicEnv`, reading each `NEXT_PUBLIC_*` var by literal member access so Turbopack inlines it.
- [x] `src/lib/env.ts` — server schema now `publicEnvSchema.extend({...})`; throws a named `CONFIG_ERROR` if `typeof window !== 'undefined'` so a future client import fails with the real cause instead of 15 misleading issues.
- [x] `src/lib/supabase/client.ts` uses `publicEnv`; no other client-reachable module imports `@/lib/env`.
- [x] Tests: `env-public.test.ts` (5 cases incl. server vars stripped), `env.test.ts` gains a client-bundle guard case. Suite green: 55 files, 404 tests. `tsc --noEmit` clean.
- [x] Verified in the running dev server: served chunk `src_1nc4wlu._.js` contains the inlined Supabase URL and no longer contains the server env module; no server secret names appear in `.next/static`.

---

## UI overhaul + case/mail/knowledge surfaces (2026-07-21)

The app had no styling system at all: every page was inline `style={{}}` objects on `font-family: Arial`, no `src/components/`, no Tailwind. Three data surfaces the DB already supported were unreachable from the UI — `listKnowledgeForCase()` and `listThreadEmails()` existed but nothing rendered them.

**Foundation**
- [x] Tailwind v4 (`@tailwindcss/postcss`, no JS config) + shadcn/ui (`new-york`, zinc base, CSS variables) + Geist Sans/Mono via the `geist` package + Phosphor icons.
- [x] `src/app/globals.css` — full token system in oklch: light + dark palettes, product surfaces (`--surface`, `--surface-raised`, `--surface-sunken`, `--hairline`, `--faint`), a 9-colour semantic case-status palette kept deliberately separate from `--primary`, one radius scale, one motion curve (`--ease-out-quint`), `prefers-reduced-motion` collapse.
- [x] shadcn ships lucide imports but lucide was never a dependency (would have broken the build). Rewrote the 4 affected primitives onto Phosphor so the project has exactly one icon family.
- [x] Dark is the default, with a no-flash inline script + class-based toggle holding no React state.

**Shell**
- [x] Authenticated routes moved into a `(app)` route group so `/login` stays chrome-free.
- [x] `src/components/shell/` — fixed desktop rail, mobile drawer with Escape + route-change close, live inbox badge counting drafts + open questions.

**New surfaces (the gap in the product, not just the styling)**
- [x] `/cases/[id]` — case detail: header with status, contacts grid, and tabs for Mail (full thread, inbound visually distinct), Knowledge, Questions (incl. resolved ones with the operator's answer), Activity (event timeline). uuid-validated params; a missing or out-of-scope case both render `not-found`, so RLS leaks no existence.
- [x] `/mail` — client-wide message browser, direction + status filters as plain links (works with JS off, shareable URLs).
- [x] `/knowledge` — cross-case knowledge library, kind + author filters, agent vs human attribution, source/citation links.
- [x] db reads added: `listEmailsForCase`, `listEmailsForClient`, `listKnowledgeForClient`, `listEventsForCase`, `listLeadsForCase`, `listKnowledgeRequestsForCase`.

**Rebuilt**
- [x] `/crm` pipeline board (status columns from a single `CASE_STATUS_ORDER` constant, cards link into case detail), `/inbox` (blocked questions ranked above drafts, toast feedback, optimistic sent state), `/campaigns`, `/settings`, `/analytics`, `/login`.
- [x] `loading.tsx` + `error.tsx` for all 8 route segments, using layout-matching skeletons rather than spinners; empty states on every list.

**Security fix found during the rebuild**
- [x] `/settings` listed mailboxes via `createAdminClient()` with no client filter, so any signed-in client-role user could read every other client's connected mailbox addresses. `mailboxes_select` RLS (`is_operator() or client_id = current_client_id()`) was already correct and simply bypassed. Now goes through `listMailboxesForViewer()` on the RLS-scoped server client, which also surfaces query errors instead of rendering a misleading empty state.

Suite green: 56 files, 431 tests. `tsc --noEmit` clean, `eslint` clean (2 pre-existing unrelated warnings), `next build` passes with 31 routes.

---

## Cross-Cutting (every phase)

- Write complete code — no placeholders, no stubs (per project `QUALITY.md` / `ANTI_LAZY.md`).
- Each new provider goes behind its interface (`architecture.md §10`).
- Every agent action and state change writes to `events`.
- RLS verified on every new table/query.
- Idempotency on every QStash-triggered route.

## Client Admin Page + Account-Creation Links (2026-07-21)

Gives the operator a `/clients` page to see every client and its linked
logins, plus a way to provision a client login without ever handling a raw
password.

- [x] `src/lib/db/clients.ts` — client CRUD + `listClientRoleAppUsers`, `listClients` moved here from `campaigns.ts`.
- [x] `src/lib/supabase/list-auth-users.ts` — paginated `auth.admin.listUsers()` wrapper for joining `app_users` to an email.
- [x] `POST /api/clients` — operator-only client creation.
- [x] `POST /api/clients/[clientId]/invite` — generates a Supabase `generateLink({ type: 'invite' })` URL, links the resulting auth user to the client via `app_users`, with auth-user cleanup if the link insert fails.
- [x] `/auth/callback` + `/set-password` — exchanges the invite code for a session and lets the invited user set their password, reusing the existing `/login` page afterward.
- [x] `/clients` admin page, nav entry (operator-only, same pattern as `/campaigns`).
- [x] Regression test added confirming campaign creation was already, and remains, operator-only (`src/app/api/campaigns/route.test.ts`).
- [x] `supabase/migrations/0009_analytics_client_filter.sql` — optional `p_client_id` filter added to `analytics_overview`/`analytics_daily`, mirroring the existing `p_campaign_id` pattern; RLS/`SECURITY INVOKER` semantics for client-role viewers unchanged.
- [x] `/analytics` gains an operator-only "Client" filter (`AnalyticsFilters`), scoping every stat tile, the daily trend, and the campaign table to one client at a time; the Campaign dropdown narrows to that client's campaigns to avoid an always-empty combined filter.
- [x] `/clients` page links each client row straight to `/analytics?client=<id>`.

**Operational notes:**
- Supabase Dashboard → Authentication → URL Configuration must allow-list `${APP_URL}/auth/callback`, or invite links will fail to redirect.
- Migration `0009_analytics_client_filter.sql` must be applied (`supabase db push` / `supabase migration up`) to the target project before the client analytics filter works.

## Client Detail Workspace — Group A: lifecycle DB + API (2026-07-21)

Per `docs/superpowers/plans/2026-07-21-client-detail-workspace.md`, Tasks 1–8 (Group A). Group B (pipeline guards on `research`/`write`/`runFollowupStep`) is now also done (below); the `/clients/[id]` UI (Groups C+) is not yet done.

- [x] `src/lib/db/clients.ts` — `updateClientName`, `updateClientStatus`, `deleteClientCascade` (relies on existing `on delete cascade` FKs).
- [x] `src/lib/db/campaigns.ts` — `pauseActiveCampaignsForClient`, `resumeCampaignsForClient` (bulk, scoped to campaigns actually in the opposite state).
- [x] `src/lib/supabase/auth-admin.ts` (new) — `banAuthUsers`/`unbanAuthUsers` (100-year `ban_duration` convention, reversible) and `deleteAuthUsers`.
- [x] `PATCH /api/clients/[clientId]` — rename.
- [x] `POST /api/clients/[clientId]/pause` — stop operations (reversible, login unaffected).
- [x] `POST /api/clients/[clientId]/resume` — restore operations; unbans client-role auth users only when resuming from `archived`.
- [x] `POST /api/clients/[clientId]/archive` — stop operations + ban login, accounts kept.
- [x] `DELETE /api/clients/[clientId]` — name-confirmed permanent delete: cascades the DB row, then deletes the now-orphaned Supabase Auth users.
- All routes operator-gated, `events` row written per mutation (best-effort, never blocks the response).

Suite green: 67 files, 501 tests (61 new/changed across the 7 touched files). `tsc --noEmit` clean. Commits intentionally skipped for this batch per instruction — all 8 tasks landed as uncommitted working-tree changes.

## Client Detail Workspace — Group B: pipeline guards (2026-07-21)

Tasks 9–11. Investigation finding from the plan: pausing a client already stopped new discovery (`discover/route.ts` already checked campaign status), but a case already sitting at `ready`, or a follow-up sequence already mid-flight, would keep sending even after the client was paused — `research`/`write` never checked `campaign.status`, and `runFollowupStep` didn't either.

- [x] `research/route.ts` — campaign fetched and checked (`status === 'active'`) *before* the case is claimed into `researching`; returns `{ skipped: 'campaign_not_active' }` otherwise, no DB write.
- [x] `write/route.ts` — same reordering before the case is claimed into `contacted`; the old `campaign_not_found` 404 is now folded into the same `campaign_not_active` skip (no route/test depended on the 404 shape).
- [x] `src/lib/pipeline/followup.ts` (`runFollowupStep`) — a paused/archived campaign no longer sends the nudge. Instead it reschedules the *same* step via `publishJsonWithDelay` at a new `PAUSED_CAMPAIGN_RETRY_SECONDS` (1 day) and calls `advanceSequence` with the unchanged `current_step`, so the chain doesn't silently die — follow-ups have no periodic fanout sweep to catch a stranded sequence the way `research`/`write` do.
- Removed now-redundant `campaign?.` optional chaining in both routes and `followup.ts` — `campaign` is narrowed non-null past each new guard.

Suite green: 67 files, 504 tests (+3 from Group A's 501). `tsc --noEmit` clean. Commits skipped per instruction.

## Client Detail Workspace — Group C: AnalyticsView extraction (2026-07-21)

Task 12, refactor-only (no behavior change for `/analytics`). Pulls the whole data-fetch-and-render body of `/analytics` into a shared async Server Component so Group D's `/clients/[id]` page can embed the exact same stat tiles / daily trend / campaign table / mailbox table / event log, forced to one client, without duplicating ~250 lines of JSX.

- [x] `src/app/(app)/analytics/analytics-view.tsx` (new) — `AnalyticsView({ searchParams, scope })` where `scope` is `{ kind: 'global' }` or `{ kind: 'client'; clientId }`; in client scope the client filter is fixed by the route (not the URL), the client picker itself is hidden, and mailboxes/campaigns are pre-filtered to that client.
- [x] `src/app/(app)/analytics/filters.tsx` — `AnalyticsFilters` gained `basePath` (default `/analytics`) and `fixedParams` props so the client detail page's embed can route filter changes to `/clients/[id]?tab=analytics&...` instead of `/analytics?...`; `buildHref` moved from a module-level function to a per-render closure over those two props.
- [x] `src/app/(app)/analytics/page.tsx` — now a thin wrapper: `PageHeader` + `RealtimeRefresher` + `<AnalyticsView searchParams={searchParams} scope={{ kind: 'global' }} />`.

Verified: `pnpm build` succeeds (all 27 routes compile, including Group A's new `/api/clients/[clientId]/*` endpoints), `tsc --noEmit` clean, full suite still 504/504 (no tested function signature changed, JSX-only move). Manual check: unauthenticated `GET /analytics` still 307s to `/login` (same as pre-refactor) — full authenticated visual parity not verified live since no Supabase session was available in this environment. Commits skipped per instruction.

## Client Detail Workspace — Group D: the `/clients/[id]` detail page (2026-07-21)

Tasks 13–15. `/clients/[id]` now mirrors `/cases/[id]`'s header+tabs shape exactly, per the plan's "all clients should be like the case UI we have" spec line — replacing the old flat `/clients` list that inlined invite dialogs and user badges into every row.

- [x] `src/app/(app)/clients/[id]/page.tsx` (new) — header (company mark, name + `RenameClientDialog`, created-at, campaign/login counts, `CLIENT_STATUS` pill, `ClientLifecycleActions`, `DeleteClientDialog`) above a `Tabs` shell (`Campaigns` / `Analytics` / `Users`), tab driven by `?tab=` via a validated `z.enum`, each `TabsTrigger` a real `Link` so every tab is a shareable, JS-optional URL. `not-found.tsx` (invalid uuid or missing client — RLS-style no-existence-leak, since only `role === 'operator'` reaches this page at all), `loading.tsx` (`PageSkeleton`), `error.tsx` (`ErrorPanel`) added alongside.
- [x] `rename-client-dialog.tsx`, `delete-client-dialog.tsx` (3-step: open → type exact name to arm → click armed button, no 4th confirm), `client-lifecycle-actions.tsx` (state-dependent Pause/Resume/Archive/Reactivate buttons) — each a small client component calling the Group A routes (`PATCH`/`DELETE`/`pause`/`resume`/`archive`) directly and `router.refresh()`-ing on success.
- [x] **Follow-up (2026-07-21):** Pause and "Stop + block login" (archive) upgraded from single-click to 2-step confirm — both change externally-visible behaviour immediately (stop sending, ban a login), unlike Resume/Reactivate which only restore a safer prior state. `ConfirmLifecycleDialog` (new, local to `client-lifecycle-actions.tsx`) opens a `Dialog` stating the exact blast radius, requires a second click on a differently-worded confirm button ("Yes, pause operations" / "Yes, stop and block login"), and shows an inline error without closing on failure. Resume/Reactivate stay single-click.
- [x] Campaigns tab embeds `NewCampaignForm` inline (Task 14): its props widened to `{ clients }` (unchanged, `/campaigns` page) `| { fixedClientId; fixedClientName }` (new) — when fixed, the client dropdown is skipped entirely and `clientId` state is pre-seeded, so creating a campaign from the client page never shows a client picker and never redirects (`router.refresh()`, same as before).
- [x] Analytics tab renders `AnalyticsView` (Group C) with `scope: { kind: 'client', clientId }` — identical stat tiles/trend/campaign/mailbox/event-log sections as the global `/analytics` page, forced to this client, filter changes stay on `/clients/[id]?tab=analytics`.
- [x] Users tab reuses the existing `InviteUserDialog`.
- [x] `/clients` list page (Task 15) simplified: each row is now a single `Link` card straight to `/clients/[id]` (name, status pill, created-at) — the inline `InviteUserDialog`, user-email badges, and "View analytics" button/link are gone from the list entirely, now living on the detail page instead. `listClientRoleAppUsers`/`listAllAuthUsers` no longer queried on this page.

Verified: `pnpm build` succeeds — `/clients/[id]` now a registered dynamic route (28 routes total) — `tsc --noEmit` clean (including the `isFixed`-narrowed union access in `NewCampaignForm`, via TS's aliased-condition control-flow analysis), full suite still 504/504 (no existing tested function signatures changed). Manual check: unauthenticated `GET /clients` and `GET /clients/<uuid>` both 307 to `/login`, no 500s. Full authenticated visual parity (rename dialog, lifecycle buttons, tab navigation, campaign creation without redirect) not exercised live — no Supabase session available in this environment. Commits skipped per instruction.

Not done from the original plan: Task 16 (a dedicated "append a dated roadmap section" step) — superseded by this entry, written in the project's own recap style rather than the plan's literal suggested text.

## Gemini thinking level for research + reply agents (2026-07-21)

The Gemini wrapper (`src/lib/llm/client.ts`) never configured a thinking level — `gemini-3-flash-preview` ran at its implicit default on every call. Added an opt-in `thinkingLevel` (`'minimal' | 'low' | 'medium' | 'high'`) to `generateJson`/`generateText`/`generateWithTools`, forwarded as `providerOptions.google.thinkingConfig.thinkingLevel`; omitted entirely (no `providerOptions` sent) when a caller doesn't set it, so existing callers (`write.ts`, `followup.ts`, `knowledge-answer.ts`, the extraction half of `research/agent.ts`) are unaffected.

- [x] `src/lib/research/agent.ts` — gather step (`runResearchAgent`'s `generateWithTools` call) set to `thinkingLevel: 'medium'`: deciding what to search/scrape next and judging a genuine personalization hook is the judgment-heavy half; the extraction step stays at the default since it's mechanical. `GATHER_MAX_OUTPUT_TOKENS` bumped 2,400 → 3,000 as headroom.
- [x] `src/lib/pipeline/reply.ts` — `classifyReply` set to `thinkingLevel: 'medium'`: triaging intent and judging whether the dossier truly supports an answer (vs. inventing one) is the same kind of judgment call. `MAX_OUTPUT_TOKENS` bumped 1,200 → 1,600 and given its own `CLASSIFY_TIMEOUT_MS` (30s, up from the shared 20s default) passed explicitly via `timeoutMs` so the client's shared `DEFAULT_TIMEOUT_MS` — used by `write.ts`/`followup.ts`/`knowledge-answer.ts` — stays untouched.
- Not touched: `write.ts`, `followup.ts`, `knowledge-answer.ts` — more templated generation where the extra reasoning cost/latency is less likely to pay off; left at the model default pending evidence otherwise.

Verified: `tsc --noEmit` clean, full suite 526/526 (`client.test.ts` gained coverage for the new `thinkingLevel` passthrough and a first `generateWithTools` describe block, which previously had none; `agent.test.ts`/`reply.test.ts` each gained one assertion that their call sites request `'medium'`). Commits skipped per instruction.

## Client-Scoped Logging — Tasks 1-3 of 10 (2026-07-21)

Plan: `docs/superpowers/plans/2026-07-21-client-scoped-logging.md`. Foundation only — the write helpers exist but no call site uses them yet (Tasks 5-6), and there is no read surface yet (Tasks 4, 7-9).

- [x] **Task 1 — schema + types.** `supabase/migrations/0010_event_logging.sql`: enums `log_severity` (`info|warn|error`) and `log_source` (`app|pipeline|gemini|apollo|brightdata|mailbox|qstash|db`); `events.severity`/`events.source` added NOT NULL with defaults `'info'`/`'app'` so all ~35 existing call sites keep working unmigrated; backfill by `type` pattern; three indexes for the Logs tab, clients-list dots, and the retention purge; `public.events_error_counts(p_since)` RPC (SECURITY INVOKER, aliased `e.` throughout) to avoid an N+1 on the clients list. Mirrored into the hand-maintained `src/types/database.ts` (events `Row`/`Insert`, `Functions`, `Enums`). New `src/types/logs.ts` holds `LogSeverity`/`LogSource`, the display-order constants, `LogSeverityFilter` (`problems` default view) and `ClientErrorCount`.
- [x] **Task 2 — severity-aware helpers.** New `src/lib/events/error-context.ts` `describeError(unknown)` normalises anything a catch block can receive into `{ code, message }`, truncated to 300 chars so one row can't carry a provider stack trace. `src/lib/events/log-event.ts` gained optional `severity`/`source` on `LogEventInput` (defaulting `'info'`/`'app'`) plus `logError`/`logWarn`, which stamp `errorCode`/`errorMessage` into the payload and route through `logEventSafe` — every caller is inside a catch block about to rethrow, so a logging failure must never replace the real error.
- [x] **Task 3 — `withExternalLogging`.** New `src/lib/events/with-external-logging.ts` wraps one vendor call, logs an error row attributed to the client on failure, and **rethrows the original error unchanged** so callers still branch on its `AppError` code. Retries and status-code handling deliberately stay with the caller.

Deviation from plan: the Task 3 test's `vi.mock('./log-event', () => ({ logError: logErrorMock }))` as written throws `Cannot access 'logErrorMock' before initialization` — the factory is hoisted above the const and dereferences it eagerly. Changed to the lambda form already used elsewhere in the repo (`logError: (...args) => logErrorMock(...args)`).

Not done: `supabase migration up --local` was never run — Docker was not available in this environment, so `0010_event_logging.sql` is written but unapplied and unverified against a real Postgres. Apply it before Task 4.

Verified: `tsc --noEmit` clean, `eslint` 0 errors (2 pre-existing unrelated warnings), full suite 539/539 (up from 526: +5 `error-context.test.ts`, +5 `log-event.test.ts`, +4 `with-external-logging.test.ts`, less 1 rewritten). Commits skipped per instruction.

## Client-Scoped Logging — Tasks 4-6 of 10 (2026-07-21)

The write path is now live end-to-end: every Gemini, Apollo, BrightData and mailbox failure is attributed to a client. The read surfaces (Tasks 7-9) and the retention cron (Task 10) are still outstanding — `listEventsForClient` / `countRecentErrorsByClient` / `deleteExpiredEvents` exist but nothing calls them yet.

- [x] **Task 4 — DB reads + purge.** `src/lib/db/events.ts` gained `listEventsForClient` (keyset-paginated by `created_at`, not offset: the pipeline inserts at the head of this feed continuously and offset paging would skip or repeat rows), `countRecentErrorsByClient` (one grouped RPC call — the clients list renders every client at once, so a per-client count would be an N+1), and `deleteExpiredEvents` (separate `info` vs `warn|error` retention windows, `now` passed in so both cutoffs derive from one instant). First test file for this module: 13 tests.
- [x] **Task 5 — Gemini.** `src/lib/llm/client.ts` now logs `llm.failed` (`severity: 'error'`, `source: 'gemini'`, payload `{ model, operation, durationMs }`) from all three catch blocks before rethrowing, and tags `llm.completed` with `source: 'gemini'`. `logUsage` switched from `logEvent` to `logEventSafe` — the generation already succeeded, so an audit-write failure must not reject the call and make a QStash retry pay for the same generation twice. No exported signature changed.
- [x] **Task 6 — Apollo, BrightData, mailbox.**
  - `discover.ts`: `runFirstPass`/`runSecondPass` take the full `campaign` instead of just `icp` (they need `clientId` to attribute); all three Apollo calls wrapped in `withExternalLogging` → `apollo.search.failed` (with `pass`/`page`) and `apollo.enrich.failed` (with `batchSize`). The three existing `logEvent` calls tagged `source: 'pipeline'`, the two failure ones also `severity: 'error'`.
  - `research/tools.ts`: `buildResearchTools` gained a second `ResearchToolContext` parameter (structurally satisfied by `LlmCallContext`, so `agent.ts` passes the context it already has without this module depending on the LLM client). The tools still return `{ error }` rather than throwing — that is deliberate, so one bad fetch is a datum the model routes around — but the failure is now recorded as `brightdata.search.failed` / `brightdata.scrape.failed` before being downgraded.
  - `mailbox/sender.ts`: provider send wrapped → `mailbox.send.failed`. The no-healthy-mailbox guard logs `mailbox.none_healthy` via `logWarn` — an expected daily-cap/health condition the pipeline handles, but the operator still needs to see that this client stopped sending.

Deviation from plan: Task 6's new `describe('apollo failure attribution')` block sits outside `describe('runDiscoveryForCampaign')`, so the plan's version would have inherited leaked mock state from the tests above rather than a clean `beforeEach`. Gave it its own `beforeEach` with explicit setup.

Verified: `tsc --noEmit` clean, `eslint` 0 errors (same 2 pre-existing warnings), full suite 561/561 (up from 539: +13 `db/events.test.ts`, +3 `llm/client.test.ts`, +2 each in `discover`/`tools`/`sender`). Every step ran red before green. Commits skipped per instruction.

## Emailable deliverability guard — shipped 2026-07-21

Second-opinion verification layered on Apollo's `email_status`. Only Emailable
`state: 'deliverable'` activates a lead; `risky`, `unknown`, `undeliverable`
and any unrecognized state are parked. Runs at discovery, so a rejected lead
never consumes Research Agent or Email-Writer cost. Blanket fail-open on any
Emailable failure, by explicit operator decision — see `architecture.md §12`.

Spec: `docs/superpowers/specs/2026-07-21-emailable-verification-design.md`
Plan: `docs/superpowers/plans/2026-07-21-emailable-verification.md`

- [x] `0011_lead_email_verification.sql` — `leads.email_verification` + `emailable` log source.
- [x] `fetchJson` accepts a redacted `logUrl` so the query-string API key never reaches the events table.
- [x] `src/lib/emailable/` — client, Zod response schema, and the pure decision table.
- [x] `enrichCandidates` gates activation; `DiscoverySummary` reports `emailableChecked` / `Deliverable` / `Rejected` / `FailedOpen`.
- [ ] Review `emailableRejected` after the first week of live runs and decide whether the strict policy needs loosening for accept-all domains.

Deviations from the plan, found during TDD:
- `client.test.ts`'s `it.each` for vendor error statuses could not include `249` — the Fetch spec treats any status in [200,299] as `response.ok`, so `249` takes the schema-validation-failure branch (no `status` in the thrown context), not the `!response.ok` branch. Split into its own test asserting only `code: 'EXTERNAL_ERROR'`.
- The abort test in `client.test.ts` used real timers against `verifyEmail`'s internal 10s `TRANSPORT_TIMEOUT_MS`, exceeding Vitest's 5s default test timeout. Switched to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`, with the rejection assertion attached before advancing timers to avoid a transient unhandled-rejection warning.
- `discover.test.ts`'s pre-existing `insertedRows()` mock helper hardcoded `email_status: 'verified'` on every returned row regardless of input, so the new park-on-`undeliverable`/`risky`/`unknown` tests couldn't prove `groupVerifiedLead` was skipped. Changed the helper to pass through the row's real `email_status`.

Not done: `pnpm supabase db reset` was never run — Docker was not available in this environment, so `0011_lead_email_verification.sql` is written but unapplied and unverified against a real Postgres. Apply it before the next migration is authored.

Verified: `tsc --noEmit` clean, `eslint` 0 errors (3 pre-existing unrelated warnings), full suite 628/628 (up from 583: +2 `log.test.ts`, +4 `fetch-json.test.ts`, +22 `emailable/client.test.ts`, +18 `emailable/map-verification.test.ts`, +10 `discover.test.ts` net of the mock fix). Every task ran red before green. Commits skipped per instruction.

## Apollo company firmographics on cases (2026-07-23)

Apollo's People Enrichment call (`bulkMatchPeople`, already made during
discovery) returns a full `organization` object that the client discarded
down to `name`/`primary_domain`/`website_url`. Now captures core
firmographics — industry, employee count, founded year, description,
city/state/country — at zero extra API cost, and writes them into
`case_knowledge` (`kind: 'company'`) so they appear in the Case page's
existing Knowledge tab and automatically flow into the AI email writer's
dossier prompt. No migration, no new Apollo endpoint.

Spec: `docs/superpowers/specs/2026-07-23-apollo-company-firmographics-design.md`
Plan: `docs/superpowers/plans/2026-07-23-apollo-company-firmographics.md`

- [x] `src/lib/apollo/client.ts` / `types.ts` — `organizationSchema` and
  `ApolloEnrichedPerson` widened with the seven firmographic fields.
- [x] `src/lib/apollo/format-company-summary.ts` — pure formatter, one
  plain-text sentence, `null` when nothing was captured.
- [x] `src/lib/db/case-knowledge.ts` — `insertCompanyKnowledgeIfMissing`,
  check-before-insert so a case gets at most one company-knowledge row.
- [x] `src/lib/pipeline/group-lead.ts` — parses firmographics off
  `lead.raw` (Zod, safe against pre-feature/legacy leads), writes the
  summary, isolated in its own try/catch (`logWarn` →
  `pipeline.company_knowledge_failed`) so a write failure never fails an
  already-successful case grouping.
- [x] `src/lib/pipeline/discover.ts` — passes `lead.raw` through to
  `groupVerifiedLead`.
- [x] `src/lib/ui/log.ts` — Logs tab sentence for the new failure event type.

Full suite: 808/808 tests green (+19 from this feature: +2 `client.test.ts`,
+7 `format-company-summary.test.ts` (new file), +4 `case-knowledge.test.ts`,
+4 `group-lead.test.ts`, +1 `discover.test.ts`, +1 `log.test.ts`). `tsc
--noEmit` clean. `eslint .` 0 errors (3 pre-existing unrelated warnings).
Commits skipped per instruction.

## Client knowledge base — Tasks 1–6 of 17 (2026-07-23)

Foundation layer for the per-client operator-only knowledge base (scraped
website pages + PDFs, pgvector-backed retrieval) that will ground the
write/followup/reply/knowledge-answer AI pipelines beyond the freeform
`campaigns.value_prop` string. Tasks 7–17 (DB access layer, routes, QStash
pipeline consumer, retrieval helper, pipeline call-site wiring, UI) remain.

Spec: `docs/superpowers/specs/2026-07-23-client-knowledge-base-design.md`
Plan: `docs/superpowers/plans/2026-07-23-client-knowledge-base.md`

- [x] Task 1 — `supabase/migrations/0014_client_knowledge.sql`:
  `client_knowledge_sources`/`client_knowledge_chunks` tables, fully
  operator-only RLS (deliberately not in the shared client-or-operator
  policy), `match_client_knowledge_chunks` SECURITY DEFINER RPC, private
  `client-knowledge-pdfs` storage bucket. `src/types/database.ts` extended
  with the two table types, two enums, and the RPC's `Functions` entry.
  **Not applied to a real Postgres** (no Docker in this environment, same
  gap noted for `0011_lead_email_verification.sql`) — apply before authoring
  the next migration.
- [x] Task 2 — `embedTexts` added to `src/lib/llm/client.ts`
  (`gemini-embedding-001`, 768-dim Matryoshka truncation to match the
  `vector(768)` column, `RETRIEVAL_DOCUMENT`/`RETRIEVAL_QUERY` task types,
  same `withTimeout`/`AppError` pattern as `generateJson`/`generateText`).
  `client.test.ts`'s existing `vi.mock('ai', ...)`/`vi.mock('@ai-sdk/google', ...)`
  factories were extended in place (added `embedMany` and
  `textEmbeddingModel`) rather than adding a second `vi.mock('ai', ...)` call
  for the same module, which the plan's snippet would have introduced —
  vitest hoists one factory per module per file.
- [x] Task 3 — `src/lib/knowledge/chunk-text.ts`: pure sliding-window
  chunker, 1000 chars / 100 overlap.
- [x] Task 4 — `src/lib/knowledge/sitemap.ts`: `<loc>` regex extraction,
  sitemap-index depth-2 traversal, Brightdata homepage-crawl fallback,
  500-URL cap, throws `VALIDATION_ERROR` when discovery finds nothing.
- [x] Task 5 — `unpdf` added as a dependency; `src/lib/knowledge/pdf-extract.ts`
  extracts merged PDF text via `getDocumentProxy`/`extractText`, capped at
  12,000 chars, wraps parse failures as `VALIDATION_ERROR`.
- [x] Task 6 — `src/lib/storage/client-knowledge-pdfs.ts`: private-bucket
  upload/delete/signed-url helpers mirroring `src/lib/storage/logos.ts`,
  10MB cap, `application/pdf` only.

Full suite: 837/837 tests green (+29 from these tasks: +4 `client.test.ts`,
+6 `chunk-text.test.ts` (new), +6 `sitemap.test.ts` (new), +3
`pdf-extract.test.ts` (new), +10 `client-knowledge-pdfs.test.ts` (new)).
`tsc --noEmit` clean. `eslint .` 0 errors (3 pre-existing unrelated
warnings). Every task's test ran red before green. Commits skipped per
instruction.

## Client knowledge base — Tasks 7–12 of 17 (2026-07-23)

Continuation of the knowledge-base feature: DB access layer, AI-pipeline
retrieval helper, and the five operator-only routes that drive
discovery → selection → parallel scrape → PDF upload → delete. Tasks
13–17 (re-scrape route, four pipeline call-site edits, UI) remain.

Spec: `docs/superpowers/specs/2026-07-23-client-knowledge-base-design.md`
Plan: `docs/superpowers/plans/2026-07-23-client-knowledge-base.md`

- [x] Task 7 — `src/lib/db/client-knowledge.ts`: full CRUD + status-transition
  helpers for `client_knowledge_sources`, `embedAndStoreChunks`/
  `deleteChunksForSource` for `client_knowledge_chunks`,
  `matchClientKnowledgeChunks` wrapping the RPC.
- [x] Task 8 — `src/lib/knowledge/client-context.ts`: `retrieveClientKnowledge`
  — embeds the query, calls the RPC, formats a `- (Source) content` block,
  never throws (degrades to `''` on any embedding/RPC failure).
- [x] Task 9 — `discover-sitemap` route: operator-only, returns candidate
  URLs for the picker, writes nothing.
- [x] Task 10 — `pages` route: inserts pending sources, fans out one QStash
  job per newly-inserted row to the scrape consumer.
- [x] Task 11 — `pipeline/knowledge-scrape` route: QStash-signature-verified
  consumer; scrapes, delete-then-inserts chunks (idempotent across retries
  and re-scrapes), marks ready/failed.
- [x] Task 12 — `knowledge/pdf` (upload, inline extract+chunk+embed) and
  `knowledge/[sourceId]` (delete, best-effort storage cleanup for PDFs)
  routes.

Three bugs found and fixed in the plan's own test fixtures while executing
(all pre-existing in the plan document, not introduced here):
  - `client-knowledge.test.ts`'s `matchClientKnowledgeChunks` test asserted
    the raw snake_case RPC rows equal the function's return value, but the
    function (correctly, matching `MatchedChunk`) maps to camelCase —
    fixed the assertion to check the mapped shape instead of loosening the
    mapping.
  - `pipeline/knowledge-scrape/route.test.ts` used `sourceId: 's1'` against
    a route whose Zod schema requires `.uuid()`, and separately hardcoded
    content-length assertions off by one (`24` vs. actual `23`). Fixed to
    a real UUID (also had to be RFC4122-variant-correct — Zod v4's
    `.uuid()` checks the variant nibble, so an arbitrary `1111-...` string
    isn't accepted either) and corrected the length.
  - `knowledge/pdf/route.test.ts` similarly hardcoded `charCount: 19` for
    a string whose real length is `18`.
  All three were caught because the red-then-green discipline surfaced a
  failure that shouldn't have been there — not assumed passing.

Full suite: 882/882 tests green (+45 from these tasks: +16
`client-knowledge.test.ts` (new), +6 `client-context.test.ts` (new), +4
`discover-sitemap/route.test.ts` (new), +5 `pages/route.test.ts` (new), +4
`pipeline/knowledge-scrape/route.test.ts` (new), +5 `pdf/route.test.ts`
(new), +5 `[sourceId]/route.test.ts` (new)). `tsc --noEmit` clean.
`eslint .` 0 errors (3 pre-existing unrelated warnings). Commits skipped
per instruction.

## Client knowledge base — Tasks 13–17 of 17 (feature complete) (2026-07-23)

Final slice: re-scrape route, grounding wired into all four AI copy
pipelines, and the full "Knowledge Base" tab UI. This closes out the
client-knowledge-base plan — every task (1–17) is now implemented.

Spec: `docs/superpowers/specs/2026-07-23-client-knowledge-base-design.md`
Plan: `docs/superpowers/plans/2026-07-23-client-knowledge-base.md`

- [x] Task 13 — `[sourceId]/rescrape` route: website-page-only (400 for
  PDFs), resets to `pending`, republishes to the scrape consumer.
- [x] Task 14 — `retrieveClientKnowledge` wired into `write.ts`,
  `followup.ts`, `reply.ts`, `knowledge-answer.ts`: each builds a
  per-call query (dossier facts + relevant thread/answer text + value
  prop), fetches once per case/step/inbound (not per-lead), and appends
  an "About our company" block to the prompt immediately after the
  value-prop line whenever non-empty. `classifyReply`'s args and
  `buildNudgePrompt`/`buildAnswerPrompt`/`buildClassifyPrompt` signatures
  now require `clientKnowledge: string`.
- [x] Task 15 — `knowledge-sitemap-picker.tsx` (discover → checklist →
  batched add) and `knowledge-pdf-upload.tsx` client components.
- [x] Task 16 — `KNOWLEDGE_SOURCE_STATUS` added to `lib/ui/status.ts`;
  `knowledge-source-actions.tsx` (re-scrape/delete), `knowledge-sources-list.tsx`
  (server-rendered table, empty state), `knowledge-realtime-refresher.tsx`
  (same debounced-`router.refresh()` pattern as `analytics/realtime-refresher.tsx`,
  scoped to `client_id`).
- [x] Task 17 — "Knowledge Base" tab wired into `/clients/[id]`: tab schema
  extended, sources fetched only when that tab is open (same convention as
  the existing Logs tab), trigger + content block added between Users and
  Logs.

No plan-fixture bugs surfaced in this slice (unlike Tasks 7–12) — none of
the four pipeline test files assert on exact prompt strings or exact
`generateJson`/`generateText`/`classifyReply` call args, so the new
`clientKnowledge` parameter threaded through cleanly.

Full suite: 886/886 tests green (+4 from Task 14's new
`retrieveClientKnowledge` mock lines exercising existing pipeline test
cases — Tasks 15–17 are UI-only, and this repo has no `.test.tsx` files
by convention, verified instead via `tsc`/`eslint`/`pnpm build`). `tsc
--noEmit` clean. `eslint .` 0 errors (3 pre-existing unrelated warnings).
`pnpm build` succeeds — all five new `/api/clients/[clientId]/knowledge/*`
routes, `[sourceId]/rescrape`, and `/api/pipeline/knowledge-scrape` appear
in the route list. Commits skipped per instruction.

**Caveats carried over from Tasks 1–12, still open:** `0014_client_knowledge.sql`
has never been applied to a real Postgres (no Docker in this environment) —
apply and verify before the next migration is authored. Manual
end-to-end verification (real sitemap discovery → scrape → pgvector
retrieval showing up in a generated email) was not performed — it
requires live `QSTASH_TOKEN`/`BRIGHTDATA_API_KEY`/`GEMINI_API_KEY`
against real services, which this environment does not have configured.

## Client knowledge base — similarity floor on retrieval (2026-07-23)

`retrieveClientKnowledge` (`src/lib/knowledge/client-context.ts`) previously
injected up to `DEFAULT_LIMIT` (6) chunks from `match_client_knowledge_chunks`
unconditionally — the SQL RPC only does `ORDER BY ... LIMIT`, no relevance
cutoff, so a thin/off-topic knowledge base could still inject weakly-related
chunks into every write/reply/followup/knowledge-answer prompt.

- [x] Added `MIN_SIMILARITY = 0.5` (cosine) in `client-context.ts`; matches
  below the floor are filtered out client-side after the RPC call, before
  formatting into the prompt block. Empty after filtering → `''`, same as
  the existing no-match path.
- [x] TDD: two new tests in `client-context.test.ts` (`should drop chunks
  whose similarity is below the floor`, `should return an empty string when
  every matched chunk is below the floor`) — watched both fail (RED) before
  implementing, then pass (GREEN).

Full suite: 888/888 tests green. `tsc --noEmit` clean. Commit skipped per
instruction (not requested).

## Public marketing page at `/` (2026-07-24)

`/` used to be a bare `redirect('/crm')` behind the auth middleware, so the
product had no public front door. It is now a marketing page for Beacon, with a
single conversion target: `https://cal.com/shengul-yavuz`.

- [x] Route moved to `src/app/(marketing)/` (route group, same `/` URL) with its
  own `loading.tsx` and `error.tsx`. The old redirect behaviour is preserved for
  operators: the page checks the session first and sends a signed-in user to
  `/crm`, so only anonymous visitors ever see it.
- [x] `src/lib/supabase/middleware.ts` treats `/` as public — matched with
  `pathname === '/'`, never `startsWith('/')`, which would open the whole app.
- [x] Sections in `src/components/landing/`: floating glass nav (mobile overlay
  with a morphing hamburger), asymmetric split hero, the cost-of-outbound band,
  a three-movement explainer, a five-cell bento, the reputation panel, an FAQ
  built on native `<details>`, closing CTA and footer.
- [x] **Copy sells the outcome, not the machinery** (revised same day on
  feedback). No vendor names (Apollo, Emailable, Gemini, Supabase, Upstash,
  Vercel), no event-type strings, no percentages or spec figures, no jargon
  (ICP, dossier, sequence, campaign). The infrastructure logo strip was deleted
  outright. Every line is written to the buyer's morning, not to the pipeline.
- [x] **No multi-client framing anywhere on the page** — the agency/read-only
  client-view side of the product is internal, so the page never mentions
  serving clients, per-client scoping or client kill switches.
- [x] The hero's console preview renders the product's real `StatusPill` and
  `CompanyMark` components against invented company names, labelled "Example
  data" in the frame. No data is ever fetched on a public page.
- [x] Palette is namespaced under `.landing` in `globals.css` and locked to
  dark, so the marketing page does not flip when an operator sets the console to
  light. Accent is the console's own jade; radius system is pills plus 28px
  trays with 22px cores.
- [x] Motion via `motion/react` (already a dependency, no new packages):
  scroll-entry reveals and hover physics on transform/opacity only, all gated on
  `useReducedMotion`.
- Verified: `tsc --noEmit` clean, `eslint` clean, 113 test files / 1006 tests
  green, and against the dev server `/` returns 200 anonymously while `/crm`
  still 307s to `/login`. Not verified: any visual/browser pass (no browser
  tooling in this environment) and Lighthouse.

---

## Brand rename — Beacon → Shengul AI (2026-07-25)

- [x] Product name changed to **Shengul AI** everywhere it is user-visible:
  root metadata title/template (`src/app/layout.tsx`), marketing page OpenGraph
  title, landing nav and footer wordmarks plus the copyright line, `/login` and
  `/set-password` headers, and the console sidebar's default mark
  (`src/components/shell/app-shell.tsx`). The monogram badge was dropped
  entirely (same-day follow-up) — the wordmark now stands alone in all five
  places. A client-role user's own `CompanyMark` logo is unaffected; when no
  client brand is set the console sidebar simply shows no mark.
- [x] Typeface switched from Geist Sans to **Inter** (`next/font/google`,
  `--font-inter`, `display: swap`); `--font-sans` in `globals.css` now points at
  it. Geist Mono is retained for `--font-mono`.
- Left alone deliberately: `Beacon Hill Analytics` in `src/lib/seed/fixtures.ts`
  (a fictional lead company, not the brand) and the "Beacon" mention in the
  comment header of the already-applied migration `0013_client_branding.sql`.
- Verified: `tsc --noEmit` clean and `next build` succeeds (confirms the Inter
  font fetch resolves at build time). Not verified: visual/browser pass.

---

## AEO / SEO discoverability pass (2026-07-25)

Closes every failing item from the AEO audit of `/` (Findable 13/25, Quotable
8/25, Understandable 8/25, Trustworthy 15/25).

- [x] **The three "passing" files did not exist.** `middleware.ts` matched
  `/robots.txt`, `/sitemap.xml` and `/llms.txt`, found no session, and 302'd
  them to `/login` — the audit scored a 200 HTML login page as "file present".
  All three are excluded from the matcher now (alongside `opengraph-image`,
  `twitter-image`, `icon`, `apple-icon`, `manifest.webmanifest`) and are really
  served: `src/app/robots.ts`, `src/app/sitemap.ts`, `src/app/llms.txt/route.ts`.
- [x] **AI crawlers named explicitly** in `robots.ts`: GPTBot, OAI-SearchBot,
  ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai,
  PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, Amazonbot,
  meta-externalagent, DuckAssistBot, cohere-ai, CCBot, YouBot, Bytespider — each
  `Allow: /` with the console paths disallowed.
- [x] **Canonical URLs**: `metadataBase` from the validated `APP_URL`
  (`src/lib/seo/site-url.ts`) plus `alternates.canonical` on the root layout,
  `/` and `/login`.
- [x] **Meta description** on `/` was 232 chars (over the 160 limit) — rewritten
  to 156. A unit test now fails the build if either description leaves the
  50–160 window.
- [x] **Open Graph / Twitter**: all four tags on every page. The 1200×630 card
  is generated by Satori (`src/components/seo/og-image.tsx` +
  `opengraph-image.tsx` / `twitter-image.tsx`). Note: a page inside a route
  group does *not* inherit the root `opengraph-image` file, so `/` declares
  `openGraph.images` explicitly — verified `og:image` was silently absent
  before that.
- [x] **JSON-LD** `@graph` on `/` (`src/lib/seo/json-ld.ts`): Organization,
  ImageObject, WebSite, WebPage and FAQPage, cross-referenced by `@id`.
  Serialiser escapes `<`, `>`, `&` so page copy cannot break out of the script
  tag.
- [x] **Freshness signals**: `datePublished`/`dateModified` in JSON-LD and
  `lastmod` in the sitemap, both from the hand-maintained `CONTENT_UPDATED_AT`
  in `src/lib/seo/site.ts` — **bump it whenever the landing copy changes**, it
  is deliberately not `new Date()` so a no-op redeploy cannot claim freshness.
- [x] **FAQ**: `FAQ_ITEMS` extracted to `src/components/landing/faq-items.ts`
  so the accordion, the `FAQPage` schema and `llms.txt` all read one source.
- [x] **H1** lengthened to "More meetings booked, none of the outbound work."
  and the title tag aligned to the same phrase; still exactly one H1.
- [x] **Sign-in pages excluded from the index**: `/login` gains a layout
  carrying `noindex, follow` + its own description; `/set-password` gains
  `noindex, nofollow`. Neither is listed in the sitemap.
- [x] **In-body links** (nav and footer do not count): new `InlineLink`
  component used in `how-it-works`, `privacy`, `safeguards` and `closing-cta`,
  giving 5 contextual links inside `<main>`.
- **Not fully closed:** "Internal links" caps out until the site has real
  subpages — it is one page, so four of the five in-body links are same-page
  anchors. A `/privacy` and `/security` page carved out of the existing
  sections is the actual fix.
- Verified: `tsc --noEmit` clean, `eslint` clean (6 pre-existing warnings),
  116 test files / 1032 tests green, `next build` succeeds, and against
  `next start`: `/robots.txt`, `/sitemap.xml`, `/llms.txt`, `/opengraph-image`
  all 200 (the last a real 1200×630 PNG), one `<h1>`, and og:image + canonical
  present on `/`. Not verified: live crawler re-score (needs a deploy).
