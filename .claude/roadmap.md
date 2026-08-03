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
- [x] `/auth/callback` + `/set-password` — verifies the invite token and lets the invited user set their password, reusing the existing `/login` page afterward.
- [x] `/clients` admin page, nav entry (operator-only, same pattern as `/campaigns`).
- [x] Regression test added confirming campaign creation was already, and remains, operator-only (`src/app/api/campaigns/route.test.ts`).
- [x] `supabase/migrations/0009_analytics_client_filter.sql` — optional `p_client_id` filter added to `analytics_overview`/`analytics_daily`, mirroring the existing `p_campaign_id` pattern; RLS/`SECURITY INVOKER` semantics for client-role viewers unchanged.
- [x] `/analytics` gains an operator-only "Client" filter (`AnalyticsFilters`), scoping every stat tile, the daily trend, and the campaign table to one client at a time; the Campaign dropdown narrows to that client's campaigns to avoid an always-empty combined filter.
- [x] `/clients` page links each client row straight to `/analytics?client=<id>`.

**Operational notes:**
- `APP_URL` must be the **canonical** production origin (the host the apex/`www` redirect settles on). It is the origin baked into every invite link. No Supabase redirect allow-listing is required — see the invite-link outage note at the end of this file.
- Migration `0009_analytics_client_filter.sql` must be applied (`supabase db push` / `supabase migration up`) to the target project before the client analytics filter works.
  - **2026-07-26 — confirmed NOT applied on the live project (`axtrfreoydwokehypbpr`), and it takes the whole `/analytics` page down, not just the client filter.** `src/lib/db/analytics.ts` calls the 4-arg `analytics_overview` / `analytics_daily`; only the 3-arg 0008 signatures exist remotely, so PostgREST answers `404 PGRST202` ("no matches found in the schema cache"), `getOverviewMetrics` / `getDailyMetrics` throw `AppError('DB_ERROR')`, and `app/(app)/analytics/error.tsx` renders "Analytics unavailable". This is unrelated to how much data exists — the zero-data path already renders the `EmptyState` correctly. Probed with the service-role key: `analytics_by_campaign` / `analytics_mailboxes` / `analytics_event_counts` return 200, `invite_links` (0017) exists, so 0009 is the only skipped migration. Fix: run `supabase/migrations/0009_analytics_client_filter.sql` in the Supabase SQL editor (it is idempotent — `drop function if exists` then `create function`).

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
- [x] **Remove a login** (2026-07-26): `DELETE /api/clients/[clientId]/users/[userId]` + `RemoveUserDialog` on each Users-tab row. Deletes the Supabase Auth user *and* the `app_users` row permanently, freeing the address to be invited again. Type-the-email confirmation, re-checked server-side. Every identity check runs before any delete — the row must exist, be `role: 'client'`, and belong to the client in the path; each failure answers 404 rather than 403 so probing ids for another client's users reveals nothing. The auth user is deleted **before** the `app_users` row (the reverse of the client-level delete): the Users tab is rendered from `app_users`, so dropping that row first and then failing would hide a login that still exists with its email permanently consumed — invisible and unretryable. `deleteAuthUser` treats an already-missing user as success so a retry after a partial failure converges. Audited as `client.user_removed`.
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

---

## Legal documents — rewritten and published (2026-07-25) DONE

**Problem found:** `docs/legal/` held three Termly-generated `.txt` files describing a
different product entirely — "Founderside AI, an AI-powered startup co-founder", with
Stripe billing, a 14-day free trial, Google Analytics, social login, a public forum and
Flash cookies. None of that exists in this system. The files were also never wired into
the app, so nothing linked to them and no route served them.

**What replaced them.** Copy now lives as typed data in `src/lib/legal/documents/` and is
served at `/legal/<slug>`; `docs/legal/README.md` records the move and the factual claims
each document makes about the system. Seven documents, three of which did not exist before:

- [x] **Privacy Notice** (`privacy-policy`) — rewritten around the fact that most personal
  data here belongs to prospects, not account holders. Real subprocessor list, a per-table
  retention schedule, a corrected CCPA category table (the old one marked Identifiers,
  Customer Records, Internet Activity and Professional Information all "NO"), GDPR legal
  bases with the legitimate-interests balancing recorded, and the **Google API Limited Use
  disclosure** that `gmail.readonly` requires for OAuth verification.
- [x] **If you received an email from us** (`outreach-privacy-notice`) — NEW. The Article 14
  notice for people whose data came from Apollo rather than from themselves. Leads with how
  to make it stop, because that is what the reader came for.
- [x] **Cookie Notice** (`cookie-policy`) — cut to the four cookies actually set (Supabase
  session, PKCE verifier, two OAuth state nonces). The old one documented a Google Analytics
  install and an advertising stack that do not exist, and claimed email tracking pixels the
  product deliberately does not send.
- [x] **Terms of Service** (`terms-of-service`) — consumer template converted to a B2B
  managed-services agreement. Removed: PayPal/card payment terms, subscriptions and free
  trial, the perpetual irrevocable licence over user "contributions" (which would have
  covered clients' confidential knowledge-base uploads), the "personal, non-commercial use"
  restriction, and the unfilled blank in the arbitration clause (`___ days` → 30, AAA
  Commercial rather than Consumer rules). Added: deliverability disclaimer, AI-output terms,
  IP infringement indemnity, confidentiality, data export on termination, and a fee cap of
  12 months' fees rather than $100.
- [x] **Acceptable Use Policy** (`acceptable-use-policy`) — NEW, incorporated into the terms.
  Anti-spam obligations, lawful-basis representation, opt-out handling, sending-conduct rules
  and enforcement. Without it every recipient-facing obligation defaulted to us.
- [x] **Data Processing Addendum** (`data-processing-addendum`) — NEW. Article 28 terms,
  SCC Module Two elections, Annex I/II content inline, CCPA service-provider certification.
- [x] **Subprocessors** (`subprocessors`) — NEW. Supabase, Vercel, Apollo, Emailable,
  Bright Data, Google, Microsoft, Upstash — the old policy named only Stripe and Google
  Analytics, neither of which is used.

**Wiring.**
- [x] `/legal` index + `/legal/[slug]` under `(marketing)`, prerendered via
  `generateStaticParams` with `dynamicParams = false`, plus `loading.tsx` / `error.tsx`.
- [x] **Middleware fix:** `/legal` and `/legal/*` added to the public paths. Without it an
  anonymous visitor — the entire audience for the outreach notice — was redirected to
  `/login`. The predicate moved to `src/lib/auth/public-paths.ts` so the app's public
  surface is unit-tested rather than read carefully.
- [x] Footer carries all seven documents; its `#how` / `#privacy` anchors became `/#how` /
  `/#privacy` so they still work from a legal page.
- [x] Sitemap lists `/legal` and all seven documents, each with its own `lastModified`.
- [x] Contact details (entity, address, phone, support address) carried over **verbatim** in
  `src/lib/legal/contact.ts` — deliberately untouched.

**Tests:** `registry.test.ts` fails the build on a duplicate slug, a ragged table row, an
out-of-window meta description, a duplicate section anchor, or a cross-reference to a
document that does not exist. Plus `linkify`, `format-date` and `public-paths` suites.

**Verified:** `tsc --noEmit` clean, `eslint` clean, 120 test files / 1063 tests green,
`next build` succeeds with all 8 legal pages prerendered, and against `next start`:
`/legal` and every document 200 **anonymously**, an unknown slug 404, `/crm` still 307 to
`/login`, sitemap lists all 8 URLs, cross-document links and the contact block render.

**Not done — needs a human:** the legal positions (legitimate-interests basis, arbitration
clause, liability cap, SCC elections) need counsel review before they are relied on. Open
question flagged to the operator: the documents still identify the site as
`foundersideai.com`, because the contact addresses are on that domain and contact details
were out of scope — confirm whether that is still the operating domain for Shengul AI.

---

## WebMCP — tools for browsing agents DONE

**Date:** 2026-07-25. Closes the three Lighthouse *Agentic Browsing* audits
(`webmcp-registered-tools`, `webmcp-form-coverage`, `webmcp-schema-validity`). The layer
above `llms.txt` and JSON-LD: those hand a *crawler* the page's facts, this hands the
*agent standing on the page* typed, callable tools.

**API sources.** `document.modelContext.registerTool(tool, { signal })` per the W3C draft
(`webmachinelearning.github.io/webmcp`), with a `navigator.modelContext` fallback for
Chrome's origin trial (deprecated in Chrome 150). Neither is in `lib.dom.d.ts`, so the
shapes are hand-written in `src/types/webmcp.ts`.

**Security decision — read-only tools, declarative mutations.** A WebMCP tool runs in-page
as the signed-in operator, so a prompt-injected agent calling a mutating tool would act with
the full session. Every registered tool is therefore `readOnlyHint: true`, and every
mutation stays a declarative form annotation: the agent fills it, the operator presses
submit. No form carries `toolautosubmit` — the attribute is deliberately left out of the JSX
augmentation so using it is a compile error, not a code-review catch.

- [x] `src/lib/webmcp/define-tool.ts` — one Zod schema generates the JSON Schema the agent
  reads *and* validates the arguments it sends, so the two cannot drift (which is exactly
  what `webmcp-schema-validity` audits). Bad input returns `isError` rather than rejecting,
  so the agent self-corrects; a throwing handler is escalated via `reportError` and the agent
  gets a bare failure — a transcript is not a stack-trace sink.
- [x] `model-context.ts` / `register.ts` / `use-webmcp-tools.ts` — probe, registration under
  one `AbortSignal` (one `abort()` in React cleanup unregisters everything), and the hook.
  Registration never throws: no browser has WebMCP yet and a missing API must not take a
  page down. **Lazily imported** — the eager cost is one property read, and the descriptors
  plus Zod (2.8 KB gzipped chunk, was landing in the marketing page's critical path) are
  only fetched once the browser is known to support WebMCP.
- [x] **Marketing `/`** — `getProductOverview`, `answerFaq`, `getBookingLink`. Answers come
  from the same constants `/llms.txt` renders; `WHAT_IT_DOES` / `LIMITS` / the overview
  paragraph moved to `src/lib/seo/product-facts.ts` so the crawler and the agent cannot get
  different answers. `answerFaq` is a lexical scorer (`faq-match.ts`), not a model call —
  a network hop would be slower than the agent just reading `/llms.txt`.
- [x] **App** — `listClients` (`/clients`), `listCampaigns` (`/campaigns`),
  `getMailboxHealth` (`/settings`, plus derived `remainingSendsToday`). Each answers from
  data the page already fetched under the viewer's own scope, passed in as props: a
  `WebMcpTool` carries an `execute` function so descriptors cannot cross the server/client
  boundary, only the data can. Projections in `src/types/webmcp-app.ts`, `snake_case` →
  `camelCase` mapped explicitly. `listCampaigns` exposes `mailboxCount`, never `mailbox_ids`.
- [x] **Eight annotated forms** (`toolname` + `tooldescription`, `toolparamdescription` on
  every field): `createClient`, `createCampaign`, `renameClient`, `setClientWebsite`,
  `createClientInviteLink`, `discoverClientWebsitePages`, `addKnowledgePageUrl`,
  `answerKnowledgeRequest`. Controlled inputs that had no `name` got one — a required field
  without a `name` is a `webmcp-schema-validity` failure. The campaign form's Radix `Select`
  gained `name="clientId"`, which makes its hidden native select a named required field; the
  submit handler still reads `clientId` from state.
- [x] **Four forms deliberately left unannotated**, each with a comment saying why, so nobody
  "completes the coverage" later: `/login` and `/set-password` (an annotated credential form
  advertises a password sink to any agent driving the browser), the SMTP connect dialog (takes
  the mailbox password the whole pipeline sends with), and sign-out (no input, and the only
  thing an agent could do with it is destroy its own access to every other tool). Lighthouse
  listing these under `webmcp-form-coverage` is the intended state — that audit is
  informational and does not fail.

**Verified:** `tsc --noEmit` clean, `eslint` clean (0 errors; the 6 warnings are pre-existing
`_omit` test bindings), 127 test files / 1145 tests green. `next build` succeeds with no
warnings; all eight `toolname` values present in the build output; React confirmed to forward
`toolname` / `tooldescription` / `toolparamdescription` to the DOM verbatim via
`renderToStaticMarkup`. Against `next start`: `/` 200 with JSON-LD intact and the tools chunk
**not** preloaded, `/login` 200 and carrying no `toolname`.

**Not done:** no end-to-end check against a browser that actually implements WebMCP — none
was available here, so registration is proven by unit tests over `resolveModelContext` and
`registerWebMcpTools` rather than by a live agent call. Worth re-running Lighthouse's Agentic
Browsing category once Chrome's flag is on.

---

## Fix — QStash workers were being redirected to `/login` (405, all retries burned)

**Symptom:** every QStash message to a worker route failed with `HTTP status 405`,
`X-Matched-Path: /login`, `Content-Length: 0`, `X-Vercel-Cache: HIT`. Observed on
`/api/pipeline/knowledge-scrape` (`{"sourceId": ...}`), but it applied to every route under
`/api/pipeline/` and `/api/inbound/`, which is the entire background pipeline: discover,
research, write, followup, collision-notify, stuck-sweep, log-retention, mailbox-health,
mailbox-reset, inbound poll and reply.

**Root cause:** `isPublicPath` listed only `/api/cron` as a machine-callable prefix, so the
middleware's session check caught the worker routes. QStash sends no cookies, so
`supabase.auth.getUser()` returned no user and the middleware answered
`NextResponse.redirect(/login)` — a **307**, which preserves the method and body. QStash's
HTTP client follows redirects, so the POST landed on the statically-cached `/login` page,
which has no `POST` handler → 405. Each message then retried three times into the same wall.
The session check never rejected these requests; it re-routed them.

**Fix:** `/api/pipeline/` and `/api/inbound/` added to `PUBLIC_PATH_PREFIXES` in
`src/lib/auth/public-paths.ts`. They are public *to the middleware only* — every route under
both prefixes calls `verifyQstashSignature` at entry, which is strictly stronger auth than a
cookie for a caller that has no cookies. `/api/cron` gained a trailing slash to match the
other prefixes, so a future `/api/cron-admin` cannot be exposed by prefix collision.

**Test:** `should keep pipeline routes behind the session check` encoded the bug and was
replaced with `should allow signed-request worker routes` (asserts pipeline + inbound), plus
prefix-collision cases for `/api/pipelines-admin` and `/api/inbound-admin`.

**Verified:** `public-paths.test.ts` 8/8 green — confirmed failing on the old source first
(`expected false to be true` for `/api/pipeline/write`), passing after the fix.

**Backlog left by the outage:** messages that already exhausted their retries are gone.
Knowledge sources stuck in a non-`ready` state need to be re-queued (the re-scrape action
re-publishes through the same route); sequence-side work is picked back up by `stuck-sweep`
once it can run.

---

## Outage note — invite links opened the marketing page instead of signing the user in (2026-07-26)

**Symptom:** a client invite link
(`…supabase.co/auth/v1/verify?token=…&type=invite&redirect_to=https://shengulai.com`)
landed on the marketing home page with the session in the URL fragment
(`https://www.shengulai.com/#access_token=…&type=invite`). No cookie, no session, no
`/set-password`. Every invited client was dead on arrival.

**Root cause — two defects, and fixing only the visible one would not have worked:**

1. `redirect_to` was **not** `${APP_URL}/auth/callback`, which is what the invite route asked
   for. GoTrue validates `redirectTo` against the project's redirect allow-list and, when it
   does not match, silently substitutes the **Site URL** rather than erroring. The Site URL is
   the marketing origin, so the invite was pointed at `/` by the auth server itself.
2. Even with the allow-list fixed, the flow could not work. `admin.generateLink` produces an
   **implicit-flow** link — the server requesting it holds no PKCE code verifier, so GoTrue's
   `/verify` endpoint completes the verification itself and 302s to `redirect_to` with the
   tokens in the URL **fragment**. A fragment is never sent to the server, so
   `/auth/callback`'s `exchangeCodeForSession` would have found no `?code=` and bounced to
   `/login` anyway.

**Fix:** stop using the hosted verify link. `POST /api/clients/[clientId]/invite` now drops the
`redirectTo` option entirely and builds its own first-party link from
`data.properties.hashed_token`:
`${APP_URL}/auth/callback?token_hash=…&type=invite&next=/set-password`. `/auth/callback` gained
a `token_hash`/`type` branch that calls `supabase.auth.verifyOtp(...)` and writes the session
cookies server-side; the `?code=` PKCE branch stays for OAuth. `type` is validated against a
closed union first — `EmailOtpType` in `@supabase/auth-js` is widened with `(string & {})` and
validates nothing.

This removes the redirect allow-list from the invite path completely: no Supabase Dashboard
configuration is involved any more, only `APP_URL`.

**Tests:** `src/app/auth/callback/route.test.ts` gained the token_hash success, expired-token,
unknown-type, code-fallthrough and open-redirect cases; the invite route test now asserts the
exact first-party link and that the response never contains `/auth/v1/verify`. 20/20 green in
those two files, 1153/1153 across the suite, `tsc --noEmit` clean.

**Operator follow-up:** invite links issued before this fix are unusable — re-issue them.

---

## Invite links: reusable for a fixed window instead of single-use (2026-07-26)

**Symptom, after the earlier invite fix shipped:** a freshly issued link answered
`/login?error=invite_expired`. The evidence was in the auth user's own timestamps —
`invited_at 17:14:21.574`, `confirmed_at 17:14:28.283`. The token was not expired or
malformed, it was **spent**, 6.7 seconds after it was created, by the first GET that reached
`/auth/callback`. A fresh `verifyOtp` against the same project succeeded, confirming the
mechanism itself was healthy.

**Root cause:** Supabase email tokens are single-use, and the URL that gets pasted into mail
and chat is now our own route, so *any* fetch redeems it. Mail and chat platforms (Safe
Links, Gmail, Slack unfurls, antivirus proxies) fetch links the moment they are sent, which
burns the invite before the recipient ever clicks. 6.7s is equally consistent with the
operator pasting it themselves — and that ambiguity is the point: the flow could not tell a
human apart from a scanner, and either one locked the other out.

**Fix:** the URL no longer carries a Supabase token. `invite_links`
(`0017_invite_links.sql`) stores a SHA-256 of a 32-byte CSPRNG token — the raw value only
ever exists in the link — against the user, the client, the issuer and an `expires_at`.
Redemption looks the row up by hash, checks expiry, then mints a *fresh* magiclink token
server-side and spends it immediately (`lib/auth/mint-session.ts`). The token that gets
consumed lived for microseconds and never left the server, so the link stays usable until it
lapses. A scanner fetching it no longer locks anyone out.

**Window:** `INVITE_TTL_MINUTES` in `lib/auth/invite-ttl.ts`, **120** (2 hours), defined in
exactly one place. Wide enough to survive email — a recipient reading their mail an hour later
still gets in — at the cost of the link being a bearer credential for that long. The TTL and
its wording live in `invite-ttl.ts` rather than `invite-token.ts` because the latter imports
`node:crypto` and so cannot be pulled into the Client Component that quotes the window;
`formatInviteTtl` keeps copy reading "2 hours" rather than "120 minutes".

**Expiry UX:** a lapsed link no longer redirects to `/login`. `/auth/invite-expired` says so
and tells the visitor to ask for a new one, distinguishing `expired` (ask again) from
`invalid` (never real / truncated in transit / superseded), because telling a stranded user
the wrong one wastes their time. Added to `PUBLIC_PATH_PREFIXES` and to the robots disallow
list.

**Also caught by the compiler, not by a test:** `invite_links.created_by` initially had a
plain `references app_users(id)`, which defaults to NO ACTION — removing an operator would
have failed outright while any invite they issued was outstanding. Now `on delete cascade`.
Separately, `seed-dev.ts`'s `TABLES_IN_DELETE_ORDER` was annotated `readonly TableName[]`,
which widened it to every table in the schema and made its `.neq('id', ...)` filter
type-check against tables it never touches; switched to `as const satisfies`.

**Reissuing:** `deleteInviteLinksForUser` runs before every insert, so a reissue cannot leave
two live links against one account. Re-inviting an address that already has an account still
returns 409 — remove the login from the Users tab first, then invite again.

**Tests:** 48 across the callback route, invite route and token helpers — including that the
link survives a second open inside the window, that the raw token never reaches the database,
that expired and unknown tokens land on different messages, and that a failed link insert
deletes the auth user rather than consuming the address.

---

## AI Resources — sendable client collateral (shipped 2026-07-26)

**Spec:** `docs/superpowers/specs/2026-07-26-ai-resources-design.md`.
**Plan:** `docs/superpowers/plans/2026-07-26-ai-resources.md`.

**All 21 tasks done.** 1345 tests across 141 files, typecheck, lint and build all green.

What landed:

- **Two tables** — `client_resources` (sendable collateral, soft-deleted so sent mail keeps its
  audit trail) and `email_attachments` (what each email actually carried).
- **Attachment plumbing through all three providers** — Gmail `multipart/mixed`, Graph
  `fileAttachment`, nodemailer, behind one `SendEmailInput.attachments` field.
- **Ordinal-based AI selection in `reply.ts`** — the model picks numbers off a menu, never uuids,
  and every ordinal is treated as untrusted.
- **Knowledge uploads widened** from PDF-only to pdf/txt/md.
- **The client-writable RLS reversal**, with `src/lib/auth/can-manage-client.ts` as the real
  boundary, plus the three-tab `/knowledge` UI and the `/inbox` attach-and-edit flow.

Migration `0018_client_resources.sql` adds `client_resources`
and `email_attachments`, opens the two knowledge tables to client-role sessions, adds the
`'file'` enum value, and creates the private `client-resources` bucket.
`src/lib/mailbox/attachments.ts` holds the 3-file / 3 MB ceiling and upload-time filename
sanitization; `SendEmailInput.attachments` is now serialized by all three providers — Gmail via a
`multipart/mixed` branch in `encodeMessage`, Outlook via Graph `fileAttachment` entries, SMTP via
nodemailer — and `sendViaMailbox` passes it straight through without touching rotation, the
atomic cap claim, or jitter. Every provider re-asserts `assertNoHeaderInjection` on the filename
and mime type before it reaches a header.

Also landed: `src/lib/storage/client-resources.ts` (validate/upload/download/delete/sign against
the private bucket), `src/lib/db/client-resources.ts` (CRUD, with `getActiveResourcesByIds`
client-scoped so a forged id cannot resolve across tenants, and `deactivateClientResource` written
as a claim so a concurrent soft-delete cannot double-remove the storage object),
`src/lib/db/email-attachments.ts` (idempotent upsert on the `(email_id, resource_id)` unique
index), and `src/lib/resources/menu.ts` — the whole AI-selection surface: menu building, one-line
prompt formatting, and `resolveAttachments`, which treats every model ordinal as untrusted
(out-of-range dropped, repeats collapsed, count and byte budget enforced in code, not in the
prompt). All five new modules are at 100% statement/branch/function/line coverage.

Tasks 11–15 wired the pipelines and opened knowledge curation to clients.
`src/lib/resources/load-attachments.ts` turns resource ids into wire-ready attachments, ordered by
the caller rather than the database, and fails loudly on a missing storage object — an email whose
body promises "attached are the examples" must not go out empty. `reply.ts` now puts the numbered
menu in the classify prompt, takes `attachResourceIds` ordinals back, resolves them server-side,
records `email_attachments` before the draft branch (so `/inbox` can show and edit the AI's picks),
and loads the bytes inside the existing try so a storage failure lands in the same `markEmailFailed`
retry path as a send failure. A price handoff passes `resourceIds: []` unconditionally, and
`write.ts` / `followup.ts` still mention attachments nowhere. `knowledge-answer.ts` takes the
operator's selection instead — no LLM choice — re-resolved against the client so a tampered form
value cannot attach another tenant's file, and tells the prompt which files ride along so the body
references them rather than contradicting the envelope.

`src/lib/auth/can-manage-client.ts` is the whole authorization boundary for client-role writes:
both relaxed knowledge routes use the admin client, so RLS is not what stops cross-tenant writes —
`canManageClient` / `canManageOwnRow` are. Knowledge uploads widened from PDF-only to pdf/txt/md:
`client-knowledge-pdfs.ts` → `client-knowledge-files.ts` (mime allowlist, `extractKnowledgeText`
routing text files past the PDF extractor, uploaded extension preserved), `insertPdfSourceReady` →
`insertFileSourceReady` with an explicit `sourceType`, and `api/.../knowledge/pdf` →
`.../knowledge/file`. The bucket id stays `client-knowledge-pdfs` — renaming it would mean
migrating every existing object for nothing. Deleting a source is now owner-or-operator, checked
after the 404 so a non-owner learns nothing extra.

Tasks 16–21 built the routes and the UI. `POST /api/clients/[clientId]/resources` removes the
uploaded object again when the row insert fails, so a bucket object can never outlive the row that
points at it; `DELETE .../[resourceId]` soft-deletes through the `deactivateClientResource` claim
and leaves the storage object alone (see the review pass below). `/knowledge` gained a tab strip and two
sub-routes: *Sources* and *Resources*, each with its own `loading.tsx` / `error.tsx`, a client
column for operators, per-row delete gated on `canManageOwnRow`, and an upload control only for a
client-role user (an operator has no single client to scope an upload to and uploads from
`/clients/[id]`). `ResourcePicker` enforces the 3-file / 3 MB budget in the UI — an unselected row
is disabled when it would breach either cap, a selected row never is, so a choice is always
reversible — and emits hidden inputs so it composes with a plain `<form action={serverAction}>`.

`/inbox` is where the two halves meet. The knowledge-request row gained both slots the spec asked
for: attach resources (sent to the lead) and add knowledge (a file the agent learns from, uploaded
best-effort to the knowledge route after the answer lands, so it can neither delay nor block the
reply the prospect is waiting on — see the review pass below). The draft row shows what the agent
chose and lets an operator correct it through `updateDraftAttachments`, in its own form so editing
can never trigger the send. `approveDraft` re-reads `email_attachments` from the database rather
than trusting form state. `src/lib/knowledge/ingest-file.ts` is the one implementation of
file → storage → text → source row → chunks, behind the upload route.

Open question deferred from Task 1: `client_resources.created_by` was written as a plain FK to
`app_users(id)` (matching `0014`), not the plan's `on delete cascade`, because cascade would
silently destroy a client's collateral when an operator removes one login and would fight the
`on delete restrict` on `email_attachments.resource_id`. Consequence: removing a login that has
uploads fails loudly with a FK violation — same as knowledge sources today. Spec §5.1 wants the
uploads to survive and become operator-only-editable, which needs a nullable `created_by` with
`on delete set null`; decide before the removal flow is exercised against real resource rows.

Lets the agent send files — portfolio PDFs, design mockups, one-pagers — to a lead that asked
for them, as real MIME attachments on a reply. Resources are deliberately **not** knowledge:
they are never chunked, embedded, or retrieved by `retrieveClientKnowledge()`. The only thing
the AI ever learns about a resource is its `title` and operator-written `description`, offered
as a numbered menu in the reply prompt; the model returns ordinals, not uuids.

**Constrained to replies.** `write.ts` (first touch) and `followup.ts` (3/7/14d) build no menu
and pass no attachments, so no code path exists for a cold email to carry one — the deliverability
guard is structural, not a flag. Ceiling is 3 MB / 3 files per email, which keeps Gmail, Graph
and SMTP all on their simple send paths (no Graph upload sessions).

**Reverses `0014`'s operator-only RLS.** Clients can now upload and manage their *own* knowledge
sources and resources on `/knowledge`; operators keep full control everywhere. These are the first
tables in the codebase a client-role session can write to; `.claude/architecture.md` §5 and §11 were
updated alongside. Because the routes use the admin client, RLS stops protecting them —
`canManageClient` / `canManageOwnRow` are the real boundary and get their own tests.

**Consequence to watch:** a client-role login now sees the knowledge base operators curated for
them, including any internal framing in a scraped page or uploaded PDF. Existing content wants a
sweep before this reaches a real client.

### Review pass (2026-07-27)

Ten findings from a full review of the branch, all fixed. Four changed real behaviour:

1. **The inbox knowledge file could not exceed 1 MB.** It was submitted through
   `answerKnowledgeRequest`, and Server Actions cap request bodies at 1 MB by default — which
   almost every real PDF exceeds, so a file that was supposed to be optional and best-effort took
   the whole answer down with it, and the prospect's reply never sent. The file now goes to
   `POST /api/clients/[clientId]/knowledge/file` (a Route Handler, no such cap) from
   `knowledge-request-row.tsx`, *after* the answer succeeds, so a slow or rejected upload can
   neither delay nor block the reply. `ingestKnowledgeFile` is still the one implementation; only
   the caller moved. The action no longer reads `knowledgeFile` at all.
2. **A deleted resource silently vanished from an email that promised it.** `loadResourceAttachments`
   filtered its results through `getActiveResourcesByIds` and dropped whatever failed to resolve,
   so a resource soft-deleted between the pick and the send produced a mail whose body said
   "attached are the examples" carrying nothing — the exact outcome its own docstring promised to
   prevent. It now raises `NOT_FOUND` naming the missing ids. `approveDraft` resolves attachments
   **before** `claimDraftForSend`, so this fails while the draft is still a draft the operator can
   fix, instead of after the claim where the only move left is `markEmailFailed`.
3. **The interactive paths never validated their picks.** `updateDraftAttachments` and
   `answerKnowledgeRequest` checked only the id count, so an over-budget or cross-client selection
   was written happily and only surfaced at send time as a dead email. Both now call
   `resolveSelectedResources` (`src/lib/resources/select.ts`) before writing anything —
   existence, tenant, count and byte budget — and `answerKnowledgeRequest` does it before the
   claim, so a rejected form leaves the request open for a corrected resubmit. The automated path
   keeps trimming rather than failing: `applyAttachmentBudget` was extracted out of
   `resolveAttachments` and is now also applied defensively in `knowledge-answer.ts`, which logs
   `droppedResourceIds`.
4. **`/inbox` capped resources globally instead of per client.** One 200-row ceiling was spent in
   `created_at` order across every visible client, so one busy client starved the rest of an empty
   picker. `listActiveResourcesForClients` queries per client — in parallel, scoped to the clients
   that actually have a row on the page — and gives each the full limit.

The rest: the stale-attachment case is now escapable in the UI (`ResourcePicker` renders an
explicit removable row for a selected id that is no longer in the library, and `draft-row` offers
the editor whenever *anything* is attached, not only when the library is non-empty — otherwise a
draft could be permanently stuck to a file it can no longer send); Gmail's multipart text part is
base64 rather than a `7bit` declaration that model-written em dashes make untrue; `DraftRow` gets
the three fields it renders instead of the whole row, keeping `storage_path` out of the browser
payload; the knowledge storage key takes its extension from the sanitized filename; deleting a
resource no longer removes the storage object, since the row is retained precisely so already-sent
mail resolves; and the `client_resources` / `client_knowledge_sources` update+delete policies now
check `client_id = current_client_id()` alongside `created_by`, so a reassigned user cannot keep
editing rows in the tenant they left.

---

## Resource content — the agent reads the files it sends (shipped 2026-07-28)

Spec: `docs/superpowers/specs/2026-07-27-resource-content-design.md`.
Plan: `docs/superpowers/plans/2026-07-27-resource-content.md` — all 12 tasks done.

`formatResourceMenu` used to emit `ordinal — title — description`, and that
string was everything the model knew about a file. Selection was a hunch, and a
deck that already answered the lead's question still escalated to a human.

A QStash worker (`/api/pipeline/resource-read`) now derives `content` and a
capped `content_summary` for every upload: `extractPdfText` where a PDF has a
usable text layer, Gemini vision for images and for PDFs whose text trims below
`RESOURCE_PDF_TEXT_FLOOR` (200), raw utf-8 for txt/md/svg, and `unsupported` for
GIF, which Gemini's image input rejects. `generateJson` grew an optional `files`
field to carry the bytes; the no-files path is byte-identical, pinned by a test.
The content is chunked and embedded into the existing knowledge index through a
companion `client_knowledge_sources` row (`source_type = 'resource'`, linked by
`resource_id`), so `retrieveClientKnowledge` picks it up with no new RPC or
index — and `match_client_knowledge_chunks` now returns `resource_id`, so a
matched chunk from a menu resource renders `- (Deck, attachable #1) …` and the
model attaches the file its answer leaned on. A resource outside the 40-entry
menu, or the `knowledge-answer` path that builds no menu, renders plain: an
unlabelled line reads as ordinary company knowledge, so the model answers from
it without claiming an attachment it has no ordinal to make.

This **reverses** `0018`'s rule that a resource is never chunked, embedded or
retrieved. Consequences handled:

- **Companion rows are not knowledge UI.** Both list queries carry
  `.is('resource_id', null)`, and `DELETE /knowledge/[sourceId]` refuses a
  resource-backed source with 400 — deleting it there would strand the resource
  reporting `ready` with no chunks behind it.
- **Deactivating a resource deletes its source** (chunks cascade). Deliberately
  *outside* the deactivation claim: nothing spans both statements in one
  transaction, so a cleanup that fails after a successful deactivation leaves an
  inactive row with live chunks, and the retry that would fix it gets `null`
  back from the claim. Gating on the claim made that state permanent. Deleting
  by `resource_id` is idempotent, so the concurrent-delete case costs a no-op —
  only the event log stays behind the claim. Otherwise the agent keeps answering
  from a file it can no longer attach.
- **`description` became optional.** The agent derives *what* a file contains, so
  that field narrowed to a "when to send" hint; a blank and an absent field both
  store as null.
- **Failure never blocks an upload.** A publish failure marks the row `failed`
  and still returns the resource; the worker records a derivation failure and
  returns 200, since a file we cannot read is not a fault to retry forever. The
  UI shows all four content states and offers Re-read on `failed`.
- **A failed read takes its old content with it.** The worker deletes the
  companion source before it marks the row `failed`, so a re-read that breaks
  cannot leave chunks from the previous success retrievable behind a row whose
  menu line has lost its summary — content no operator could see or explain.
- **One read per row at a time.** `POST …/read` answers 409 while the row is
  already `pending`. Two workers on one resource would race the
  delete-then-insert that keeps its chunks unique: one delete can land between
  the other's delete and insert, leaving duplicates or nothing.
- **Menu values cannot spell a separator.** `formatResourceMenu` strips `—` and
  `|` as well as newlines from the title, the hint and the summary. The summary
  is model-written from bytes the file supplied, so a row could otherwise forge
  a `when to send:` or `contains:` field it was never given.
- **An unreadable worker payload is a 400.** A 500 would put a body that can
  never parse through QStash's entire retry budget.
- **A blank model answer never marks a row ready.** `visionSchema` and
  `textSchema` trim before `.min(1)`, so whitespace-only `content`/`summary`
  fails validation instead of producing a menu line with no `contains:` and
  vision content that chunks to nothing.
- **What the model may claim is bound to a file.** The reply prompt permits
  answering from a company-knowledge line tagged `attachable #N` (untagged lines
  stay background), and the `/inbox` knowledge-answer prompt now lists each
  attachment with its own derived summary — a file with none reads
  `contents not read` and may be named but not described.

Two UI strings were qualified alongside this: `image/gif` uploads fine but
`chooseReadStrategy` returns `unsupported` for it, so "the agent reads each one"
overpromised on the client and Resources pages and in the upload hint.

`retrieveClientKnowledge` moved to an options object to carry the ordinal map —
that touched two more call sites than the plan listed (`write.ts` and
`followup.ts`), both converted; neither passes a map, since neither builds a menu.

Deploy order matters: apply `0019`, deploy so `/api/pipeline/resource-read`
exists, then run `tsx scripts/backfill-resource-content.ts` once per
environment — `0019` defaults pre-existing rows to `pending` with no job behind
them. Publishing to a route that is not deployed yet would burn QStash retries
and mark rows failed.

---

## Client notes + client-written email (shipped 2026-07-28)

Spec: `docs/superpowers/specs/2026-07-28-client-notes-and-manual-send-design.md`.
Plan: `docs/superpowers/plans/2026-07-28-client-notes-and-manual-send.md` — all
10 tasks done. Migration `0020` — additive, no backfill, no deploy ordering
constraint. **`0020` still has to be applied per environment** (no `supabase`
CLI in this tree; apply it the way `0019` was applied). Until it is, the case
page throws on `listNotesForCase` and every manual send fails on `sent_by`.

- **Notes** (`notes` table, RLS mirroring `client_resources`): case-anchored,
  `lead_id` set when the note is about one person. The whole client reads; only
  the author edits. Written through the *session-scoped* client — the policies
  are the boundary, unlike `emails`, where clients have no write policy and an
  explicit `canManageClient` check does the work. No prompt reads a note, so a
  client can record something unflattering without it reaching outbound copy.
  Panel sits above Contacts on the case page; a person note can be started from
  the About selector or from that contact's card (`?note=<leadId>#notes`, with
  the panel keyed on the target so a second click re-seeds the selector).
  `case_id` is not null even on a person note: `leads.case_id` is nullable
  (`on delete set null`, 0001), so anchoring on the lead alone would leave notes
  attached to no visible surface. Author labels are "You"/"Teammate" —
  `app_users` holds no email, and resolving one would mean an auth-admin lookup
  on a page a client-role user loads.
- **Manual send** (`sendManualEmail`): a client writes to a lead on their own
  case, through the campaign's mailboxes, with resource attachments. Three
  decisions carry the weight:
  - A manual email with no step-0 outbound **claims that slot**. Otherwise the
    write cron cold-emails the same person days later, and `find_stuck_cases`
    (0006) drags the case back to `ready` precisely because it has no step-0
    email. Claiming it also starts the 3/7/14 cadence off the client's own
    message and moves a pre-contact case to `contacted`.
  - An interjection sets `sequences.skip_next_step`, consumed at fire time by
    `runFollowupStep`, which sends nothing and enqueues the step after — the
    cadence continues rather than dying. A reply still beats a pending skip; a
    paused campaign postpones it; two manual sends consume one skip; skipping the
    final step stops the sequence without marking the case `dead`.
    `consumeFollowupSkip` deliberately does not advance `current_step` — on a
    publish failure the retry sends a real nudge, and losing a skip is strictly
    better than a silently dead cadence.
  - The cap bypass is a **separate** `claim_mailbox_send_uncapped` RPC, never a
    parameter on the capped one, so the agent's path cannot accidentally become
    uncapped. `sent_today` still increments and `health <> 'blocked'` still
    applies.

  Attachments resolve **before** the row is claimed (matching `approveDraft`): a
  correctable selection must fail while the form is on screen, not after the
  point of no return. A send failure marks the row `failed` and rethrows;
  post-send bookkeeping is best-effort and logged, because the mail is already
  out and a QStash outage must not read as a failed send.
- `emails.sent_by` records who typed a message; the case thread and `/mail` show
  "Sent by a person" against it.

60 new tests (1461 → 1521), `pnpm typecheck`, `pnpm lint` and `pnpm build` all
clean. Per the plan's global constraints there are no component tests: the notes
panel and the composer are covered by typecheck, lint and a production build, and
need a manual pass in `pnpm dev` once `0020` is applied. The spec's RLS
integration cases for `notes` are still outstanding — that suite runs against
live credentials via `pnpm test:integration`, outside the per-task cycle.

---

## Mailreach warmup integration — Tasks 1-5 DONE

**Plan:** `docs/superpowers/plans/2026-07-29-mailreach-warmup.md`
**Spec:** `docs/superpowers/specs/2026-07-29-mailreach-warmup-design.md`

Executed tasks 1-5 of the plan (schema/env through enrollment orchestration),
inline, no commits per instruction:

- **Task 1** — `supabase/migrations/0021_mailreach_warmup.sql` adds the
  `mailreach_status` enum, `clients.mailreach_enabled`, and 6 new `mailboxes`
  columns. `src/types/database.ts` updated to match. `MAILREACH_API_KEY` added
  to `src/lib/env.ts`/`.test.ts`, plus the test-only stub in `vitest.config.ts`
  and placeholders in `.env.example`/`.env.local` (not in the plan, but
  required for the existing module-scope `loadEnv(process.env)` import not to
  crash every other test file).
- **Task 2** — `src/lib/mailbox/mailreach-gate.ts`: pure
  `isEligibleForCampaignSend`/`mailreachElapsedDays`, `MAILREACH_CAMPAIGN_GATE_DAYS
  = 14`. Not yet wired into `sender.ts` — that's Task 8.
- **Task 3** — `src/lib/mailreach/client.ts`: REST wrapper (connect-account,
  OAuth authorize/callback, disconnect, stats) over `fetchJson`. Field names
  are per the plan's documented-but-unverified Mailreach API guess (Step 1 of
  this task — confirming against a live account — was not done; still needs a
  real `MAILREACH_API_KEY` before Task 3 is trusted end-to-end).
- **Task 4** — DB helpers added to `src/lib/db/mailboxes.ts` (pending/connected/
  disconnected/clear/enabled/stats updates, `listMailboxesForClient`,
  `listMailreachConnectedMailboxes`; `MailboxSummary` extended) and
  `src/lib/db/clients.ts` (`updateClientMailreachEnabled`).
- **Task 5** — `src/lib/mailreach/enrollment.ts`: orchestrates connect/disconnect
  + bulk client-level reconnect/disconnect on top of Tasks 3-4.
  `mailreach_started_at` is stamped once and preserved across
  disconnect/reconnect so the 14-day gate never restarts.

`pnpm tsc --noEmit` clean, full suite 153 files / 1558 tests passing (was 1521
before this batch). Remaining: Tasks 6-13 (routes, OAuth callback, UI toggles,
stats-sync cron, wiring the gate into `sender.ts`) are not started.

### Tasks 6-8 DONE (same session, inline, no commits)

- **Task 6** — `src/app/api/mailboxes/[id]/mailreach/{connect,disconnect}/route.ts`
  + `src/app/api/mailboxes/mailreach/state-cookie.ts`. SMTP connects
  synchronously; gmail/outlook returns an `authorizeUrl` and sets an httpOnly
  CSRF-nonce cookie (`mailreach_oauth_state`, scoped to `/api/mailboxes`) for
  Task 7 to validate.
- **Task 7** — `src/app/api/mailboxes/mailreach/callback/route.ts`: validates
  the state cookie with `timingSafeEqualString`, completes the OAuth connect,
  and redirects to `/settings?mailreach=connected` or `?error=...`.
- **Task 8** — wired `isEligibleForCampaignSend` into `sender.ts`'s
  `rotationOrder` (now `(mailboxes, purpose, now)`), gating `'outreach'` sends
  only — a `'reply'` still uses a warming mailbox. `mailbox.none_healthy`'s log
  payload gained `warmupGatedCount`. The plan's test additions assumed
  `sender.test.ts` helpers named `mockMailbox`/`buildSupabase` inside a
  `describe('rotation and health', ...)` block; the real file uses
  `mailboxWith`/`listMailboxesByIdsMock`/`claimMailboxSendMock` fixtures with no
  such describe block, so the two new tests were adapted to those existing
  fixtures instead (same behavior asserted, different helper names) and added
  to a new `describe('mailreach gate', ...)` block. The shared `mailbox`
  fixture gained `mailreach_enabled: false, mailreach_started_at: null`
  defaults so `mailboxWith(...)` overrides work.

`pnpm tsc --noEmit` clean, `pnpm lint` clean (only 6 pre-existing unrelated
warnings), full suite 156 files / 1572 tests passing (was 1558). Checkboxes for
completed steps in the plan file are ticked; commit steps are deliberately left
unchecked (skipped per instruction). Remaining: Tasks 9-13 (client-level master
switch PATCH route, `/settings` UI, stats-sync cron + QStash registration, final
roadmap pass) are not started.

### Tasks 9-12 DONE (same session, inline, no commits)

- **Task 9** — `PATCH /api/clients/[clientId]` accepts `{ mailreachEnabled }`;
  flips `clients.mailreach_enabled` and fires `bulkReconnectSmtpForClient` (on)
  or `bulkDisconnectForClient` (off), logging `client.mailreach_enabled_changed`.
  Hit a real type error the plan didn't anticipate: nesting the `BulkResult`
  interface directly as a `logEvent` payload field doesn't type-check against
  the `Record<string, Json>` payload type (no index signature on a named
  interface) — fixed by spreading/flattening `attempted`/`succeeded`/`failed`
  as individual number fields instead. Confirmed via a scratch compile that
  `{ ...namedInterfaceValue }` (used by the pre-existing `mailbox-health`
  route and by Task 12 below) *does* type-check — only nesting the named value
  directly as a property fails.
- **Task 10** — `src/app/(app)/settings/mailreach-controls.tsx` (operator-only
  checkbox; SMTP toggles synchronously, gmail/outlook navigates to the
  Mailreach OAuth URL), wired into `mailbox-row.tsx` (new `mailreachStatusText`
  helper renders day-count/reputation to both roles) and `page.tsx`.
- **Task 11** — `src/app/(app)/clients/[id]/mailreach-toggle.tsx`, the
  client-level master switch, mounted next to `WarmupProfileSelect`.
- **Task 12** — `src/lib/pipeline/mailreach-sync.ts` (`runMailreachStatsSync`,
  best-effort per mailbox), `src/app/api/pipeline/mailreach-sync/route.ts`
  (QStash-signed cron entry), `scripts/schedule-mailreach-sync-cron.ts`
  (6-hourly, mirrors `schedule-mailbox-health-cron.ts`).

Verification: `pnpm tsc --noEmit` clean, `pnpm lint` clean (same 6 pre-existing
unrelated warnings), full suite 158 files / 1580 tests passing (was 1572), and
`pnpm build` succeeds with every new route (`/api/clients/[clientId]`,
`/api/mailboxes/[id]/mailreach/*`, `/api/mailboxes/mailreach/callback`,
`/api/pipeline/mailreach-sync`, `/clients/[id]`, `/settings`) compiling. Full
interactive browser verification (Task 10 Step 6, Task 11 Step 4 — checking the
box in a real session, completing a live Mailreach OAuth round-trip) was **not**
done: it needs a real authenticated session plus a live `MAILREACH_API_KEY`/
Mailreach account, neither available here. Those two steps are left unchecked
in the plan file; everything else through Task 12 is checked, commit steps
excepted. Remaining: Task 13 (full verification pass + final roadmap
consolidation) — largely already covered above, but not yet formally closed out
per the plan's own checklist.

### Code-review fixes (2026-07-29, inline, no commits)

`/code-review` flagged 10 findings on the working tree; all 10 fixed:

- `runFollowupStep` skip race (`followup.ts`) — the human-interjection skip
  read a stale `sequence.skip_next_step` snapshot instead of checking
  `consumeFollowupSkip` atomically, letting a concurrent manual send lose the
  race and get double-messaged. Now checks atomically, unconditionally.
- `sendManualEmailUnsafe` missing `campaign.status` check (`send-actions.ts`)
  — manual sends could go out through a paused/archived campaign.
- `disconnectMailbox` (`enrollment.ts`) left a mailbox stuck "connected" when
  the vendor call failed — now best-effort, like `bulkDisconnectForClient`.
  Also extracted its 154-line body into 6 single-purpose helpers.
- Mailreach connect route now rejects enrolling an individual mailbox while
  the client-level master switch is off (`mailreach-gate.ts` otherwise
  ungates it immediately, defeating warmup).
- `sender.ts`'s `bypassDailyCap` silently also bypassed the mailreach warmup
  gate; split into two independent flags (`bypassDailyCap`,
  `bypassMailreachGate`) so a future cap-only caller can't accidentally skip
  warmup too.
- `note-actions.ts` `editNote`/`removeNote` now verify `note.case_id`
  matches the submitted `caseId` before mutating.
- `mailreach-sync.ts`'s per-mailbox stats sweep now runs concurrently
  (`Promise.all`) instead of one mailbox at a time.
- `MAX_SUBJECT_CHARS`/`MAX_BODY_CHARS`/`MAX_NOTE_CHARS` deduped into
  `src/lib/validation/{email,note}-limits.ts`, imported by both the
  `'use server'` schema and the client component's `maxLength`.
- `MailreachToggle` moved off client-side `fetch` to the PATCH route onto a
  new `setClientMailreachEnabled` Server Action
  (`clients/[id]/mailreach-actions.ts`); the route's `mailreachEnabled` field
  was removed since it was that toggle's only caller.

`npx tsc --noEmit` clean, `npx eslint .` clean (same 6 pre-existing unrelated
warnings), full suite 159 files / 1595 tests passing (was 1580).

---

## Google Tag Manager + Consent Mode v2 (2026-07-29, inline, no commits)

User asked to install GTM (`GTM-T8WVXHJQ`), then "what else should I add for
page visibility." Before adding SEO extras, caught that
`src/lib/legal/documents/cookie-policy.ts` and `privacy-policy.ts` §15
explicitly claimed "no analytics, no third-party tracking, no consent
banner — there is nothing to consent to." Installing GTM directly
contradicted the site's own published legal notices, so this became a
compliance fix, not just a tracking-snippet install. User chose: update the
legal docs to match reality rather than pull GTM back out.

- `src/lib/env-public.ts` — `NEXT_PUBLIC_GTM_ID` (regex `^GTM-[A-Z0-9]+$`),
  `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION`, `NEXT_PUBLIC_BING_SITE_VERIFICATION`,
  all optional so envs without them (tests, preview) don't break.
- `src/app/layout.tsx` — GTM head script + noscript iframe, both skipped
  entirely when the env var is unset. Google Consent Mode v2 default
  (`ad_storage`/`ad_user_data`/`ad_personalization`/`analytics_storage` all
  `denied`) is set via an inline `gtag` stub *before* GTM's container script,
  so no tag can fire un-gated on first paint. Ads consent is never exposed
  as grantable anywhere in this codebase — the product runs no advertising.
  `metadata.verification` wired for the two search-console tokens, each
  omitted independently if unset.
- `src/lib/consent/consent-mode.ts` (new) — `applyConsentDecision`,
  `readStoredConsent`/`storeConsentDecision` (localStorage key
  `ai-b2b-consent`), `clearStoredConsent`. Every mutation fires
  `CONSENT_CHANGE_EVENT` on `window`; nothing calls `setState` inside a
  `useEffect` body directly (tripped the `react-hooks/set-state-in-effect`
  lint rule) — `ConsentBanner` instead subscribes via `useSyncExternalStore`,
  with a `getServerSnapshot` that always returns `'hidden'` so SSR/hydration
  can never claim a decision the browser hasn't looked up yet.
- `src/components/consent-banner.tsx` (new) — Accept/Reject bar, only
  rendered by the root layout when GTM is configured. `src/components/
  cookie-preferences-button.tsx` (new) — footer control that clears the
  stored decision so consent can be withdrawn as easily as it was given
  (GDPR requirement), wired into `site-footer.tsx` behind the same GTM
  check.
- `cookie-policy.ts` rewritten: four strictly-necessary cookies unchanged,
  new conditional analytics-cookie table gated on the consent banner, the
  `ai-b2b-consent` localStorage key disclosed, "no consent banner" language
  removed. `privacy-policy.ts` §15 updated to match — still asserts no
  advertising/no selling/no cross-context sharing, since none of that
  changed. Both docs given their own literal `updatedAt: '2026-07-29'`
  instead of the shared `LEGAL_UPDATED_AT` constant (per that constant's own
  comment: bump per-document once docs start changing independently).
  Caught and reverted one over-claim mid-edit: drafted a sentence saying GPC
  is honoured for analytics opt-out specifically, which isn't implemented —
  removed before landing, keeping the pre-existing GPC claim (sale/sharing
  opt-out only) unchanged.
- `.env.local` / `.env.example` — `NEXT_PUBLIC_GTM_ID` filled with the real
  container id in `.env.local`; the two verification vars left blank
  everywhere (no real tokens exist yet).

Verified: full suite 160 files / 1611 tests passing (was 1595), `tsc
--noEmit` clean, `eslint` clean on every touched file (same pre-existing
unrelated warnings only). Confirmed via a local dev server + curl that the
consent-default script and GTM tag render only when configured, and that the
`ConsentBanner` renders nothing in the SSR payload (client-only reveal, by
design). No component-level DOM test was added — this repo has no React
Testing Library / jsdom setup for any component, matching `QUALITY.md`'s
"React components: critical paths only" coverage target; the consent-mode
logic itself (the part with real branching) is covered at the unit level.

Not done, flagged for the user rather than assumed: no GA4 (or other) tag is
actually configured inside the GTM container itself — that happens in the
Google Tag Manager web UI, outside this repo, and nothing here can verify or
change what tags exist there. The cookie-policy analytics table is written
generically for that reason.

---

## CRM integrations (HubSpot / Pipedrive) — Tasks 1-3 of 11 (2026-08-02, inline, no commits)

Design: `docs/superpowers/specs/2026-08-02-crm-integrations-design.md`. Plan:
`docs/superpowers/plans/2026-08-02-crm-integrations.md`. Executed via
superpowers:executing-plans, inline (no subagents), skipping the plan's
per-task commit steps at the user's request.

**Task 1 — migration + generated types.**
`supabase/migrations/0022_crm_integrations.sql` — `crm_provider`
(`hubspot`/`pipedrive`), `crm_connection_status` (`connected`/`error`),
`crm_sync_status` (`ok`/`error`); `crm_connections` (one per client, unique
`client_id`, encrypted `oauth` jsonb, nullable pipeline/stage columns until
setup is finished); `case_crm_links` (unique `case_id`, `sync_started_at` as
the single-flight claim). RLS: flat per-client SELECT, write locked to
`is_operator()` (all writes go through `createAdminClient()`). Also adds
`'crm'` to the existing `log_source` enum.

Docker wasn't running, so `pnpm supabase db reset` / `gen types` couldn't
execute — used the plan's documented fallback and hand-wrote the two
`Tables` entries and three `Enums` entries into `src/types/database.ts` to
match the SQL exactly. Adding `'crm'` to `log_source` broke two exhaustive
consumers the plan didn't mention: `LOG_SOURCES` in `src/types/logs.ts` and
`LOG_SOURCE_META` in `src/lib/ui/log.ts` both needed a `crm` entry to keep
`tsc --noEmit` clean — fixed both.

**Task 2 — token encryption + env vars.** `src/lib/crm/tokens.ts` —
`encryptCrmTokens`/`parseCrmTokens`, same AES-256-GCM envelope as
`mailbox/tokens.ts`, reusing `MAILBOX_ENCRYPTION_KEY`. Unlike mailbox
tokens there's no legacy plaintext shape to accept, since these tables are
new. Added `HUBSPOT_OAUTH_CLIENT_ID/SECRET` and
`PIPEDRIVE_OAUTH_CLIENT_ID/SECRET` to `src/lib/env.ts` (`nonEmpty`),
`vitest.config.ts`'s stub test env, and `.env.example`. `src/lib/env.test.ts`'s
`complete` fixture was missing the four new required keys, which made its
"all vars present" test fail against the tightened schema — added them.

**Task 3 — provider interface + mapping.** `src/lib/crm/provider.ts` — the
`CrmProvider` interface (HubSpot/Pipedrive will implement it in later
tasks), `CrmDealTarget` discriminated union so callers never need to know
HubSpot models closure as a pipeline stage while Pipedrive models it as a
separate status field. `src/lib/crm/mapping.ts` — pure functions
(`splitFullName`, `toCompanyInput`, `toContactInput`, `toDealTitle`,
`toCreationNote`, `isSyncableLead`), no I/O. Plan's test fixture used
`status: 'stopped'` for a non-syncable lead, but the actual `lead_status`
enum is `'new' | 'parked' | 'active'` (no `'stopped'`) — followed the plan's
own documented contingency and used `'parked'` in both the fixture and the
implementation's `isSyncableLead` check.

Verified after each task and once more at the end: full suite 162 files /
1636 tests passing (was 1619 before Task 2's env-fixture fix, 1611 before
this work started), `tsc --noEmit` clean, `eslint` clean (same six
pre-existing unrelated warnings only, no errors).

Not done yet, per the plan's own ordering: Tasks 4-11 (`crm_connections` /
`case_crm_links` data access, both provider implementations, the sync
worker + QStash route, connect/callback routes, `/settings/crm` UI, case-
detail sync indicator, and wiring the six `enqueueCrmSync` call sites).
Nothing commits until the user asks — working tree is dirty by design.

---

## CRM integrations (HubSpot / Pipedrive) — Tasks 4-5 of 11 (2026-08-02, inline, no commits)

Continuation of the above, same plan/design docs, same executing-plans
process, inline, no commits.

**Task 4 — `crm_connections` data access.** `src/lib/db/crm-connections.ts`
— `getCrmConnectionForClient`, `getCrmConnectionById`, `upsertCrmConnection`
(upsert on the `client_id` unique constraint; a reconnect resets
`pipeline_id`/`initial_stage_id`/`won_stage_id`/`lost_stage_id` to null so a
provider switch can't leave a stale stage id from the previous CRM behind),
`updateCrmConnectionPipeline`, `updateCrmConnectionTokens`,
`markCrmConnectionError`, `deleteCrmConnection`. One function per DB
operation per `QUALITY.md`; every write assumes the caller already checked
session/role/ownership. 14 tests, matching the plan's count exactly.

**Task 5 — `case_crm_links` data access + single-flight claim.**
`src/lib/db/case-crm-links.ts` — `getCaseCrmLink`, `ensureCaseCrmLink`
(race-safe upsert on the `case_id` unique index), `claimCrmSync` (atomic
conditional update — claims when `sync_started_at` is null or older than
`CRM_SYNC_CLAIM_STALE_MS` (5 min), so a crashed worker can't deadlock a case
permanently), `updateCaseCrmLinkIds` (persists whichever external ids were
passed, letting a retry after partial failure resume instead of
re-creating objects), `markCrmSyncResult` (records outcome and releases the
claim in one write, truncating a stored error to 500 chars). 15 tests
(plan said 14 — the plan's own count was off by one, no test was added or
removed relative to what it specified).

One divergence from the plan's code, caught by `tsc --noEmit`:
`updateCaseCrmLinkIds`'s conditional patch object was typed as
`Record<string, string | string[]>`, which Supabase's generated client
rejects (`RejectExcessProperties` on `.update()` needs the patch typed
against the actual `Update` row shape, not an untyped Record) — retyped it
as `Database['public']['Tables']['case_crm_links']['Update']`, which
satisfies the exact-optional-property assignment the plan's `if (...!==
undefined) patch.x = ...` pattern relies on.

Verified: full suite 164 files / 1665 tests passing (was 1636 after Tasks
1-3), `tsc --noEmit` clean, `eslint` clean (same six pre-existing unrelated
warnings, no errors).

Not done yet: Tasks 6-11 (HubSpot provider, Pipedrive provider, sync worker
+ QStash route, connect/callback routes, `/settings/crm` UI, case-detail
sync indicator, wiring the six `enqueueCrmSync` call sites). Nothing
commits until asked — working tree stays dirty by design.

---

## CRM integrations (HubSpot / Pipedrive) — Task 6 of 11 (2026-08-02, inline, no commits)

Continuation of the above, same plan/design docs, same executing-plans
process, inline, no commits.

**Task 6 — HubSpot provider.** `src/lib/crm/hubspot-provider.ts` — the
first `CrmProvider` implementation, against the HubSpot CRM v3 API.
`upsertCompany`/`upsertContact` use search-then-create-or-patch (by
`domain` / by `email`) rather than HubSpot's batch-upsert endpoint, since
upsert-by-`idProperty` depends on a portal-configured unique property we
can't guarantee exists. `listPipelines` reads closure off
`stage.metadata.probability` (`"1.0"` → won, `"0.0"` → lost — HubSpot
platform constants). `moveDeal` re-reads the deal's live pipeline before
resolving a `closed` target instead of trusting stored stage ids, since a
client can move a deal to a different pipeline in HubSpot after we created
it; when no closed stage is found it drops a note instead of failing the
sync. `createDeal` builds `HUBSPOT_DEFINED` associations (deal→company
`341`, deal→contact `3`) and a portal deep link from `account_ref` (empty
string when unknown, not a broken link). Every method round-trips
possibly-refreshed tokens via `ensureFresh`/`refreshAccessToken`
(30s-skew expiry check), matching the `MailboxProvider` contract exactly.
`exchangeCode` fetches the portal id via a second call whose URL embeds
the access token — passed a redacted `logUrl` to `fetchJson` so the raw
token never lands in `AppError.context` (which is written to `events` and
rendered on the operator Logs tab).

21 tests (plan said 20 — one extra assertion split, no behavior gap).
`src/lib/crm/hubspot-provider.test.ts` copied verbatim from the plan;
implementation copied verbatim too — no divergence needed this time, the
existing `fetchJson(url, options, schema, timeoutMs?, logUrl?)` signature
and `provider.ts`/`tokens.ts` shapes from Tasks 2-3 already matched what
the plan's HubSpot code expected.

Verified: full suite 165 files / 1686 tests passing (was 1665 after Tasks
1-5), `tsc --noEmit` clean, `eslint` clean (same six pre-existing
unrelated warnings, no errors).

Not done yet: Tasks 7-11 (Pipedrive provider + registry, sync worker +
QStash route, connect/callback routes, `/settings/crm` UI, case-detail
sync indicator, wiring the six `enqueueCrmSync` call sites). Nothing
commits until asked — working tree stays dirty by design.

---

## CRM integrations (HubSpot / Pipedrive) — Tasks 7-9 of 11 (2026-08-02, inline, no commits)

Continuation of the above, same plan/design docs, same executing-plans
process, inline, no commits.

**Task 7 — Pipedrive provider + registry.** `src/lib/crm/pipedrive-provider.ts`
— the second `CrmProvider` implementation. Three ways Pipedrive differs from
HubSpot shaped it: the token endpoint needs HTTP Basic auth (not a body
credential); the API base URL is per-account (`api_domain`), returned only
with the token response, so it's packed onto the end of `accessToken` after
a `|` separator (mailbox tokens share `CrmOAuthCredentials`'s shape, so
widening it wasn't an option) and unpacked at every call site; and deal
closure is a `status` field independent of stage, so `listPipelines` never
flags a `closedOutcome` and `moveDeal` sets `{ status: 'won' | 'lost' }`
instead of moving a stage — `won_stage_id`/`lost_stage_id` stay null for
Pipedrive connections by construction. `upsertCompany`/`upsertContact` search
first (`exact_match: true` on name/email) and only create on a miss, same
create-or-reuse shape as HubSpot's search-then-patch. `createDeal` links at
most one person (`contactExternalIds[0]`) since a Pipedrive deal has exactly
one `person_id` — the rest of the case's contacts are already Persons on the
linked organization. `src/lib/crm/registry.ts` — `getCrmProvider` with an
exhaustive switch and a `never` default, matching `mailbox/registry.ts`
exactly. 19 Pipedrive tests + 3 registry tests = 22 (plan's own per-file
counts were off, same as earlier tasks — no behavior gap).

**Task 8 — sync orchestration.** `src/lib/crm/sync.ts` — `enqueueCrmSync`
(fire-and-forget QStash publish, never throws, short-circuits for clients
with no usable connection) and `runCrmSync` (the worker body: precondition
checks → single-flight claim via `claimCrmSync` → create-or-update on ANY
reason if `external_deal_id` is null, persisting each external id the moment
it's obtained so a retry resumes instead of restarting → apply the reason
(note-only for intermediate reasons, `moveDeal` to closed for `won`/`lost`/
`dead`) → release the claim and record the outcome). Failure classification
(`classifyFailure`) reads the AppError's HTTP status: 401/403 parks the
connection (`markCrmConnectionError`, terminal), 429/5xx/timeout rethrows so
the QStash route returns 500 and gets retried, everything else is a
permanent validation failure recorded on the link row. Token rotation is
persisted inside a `call()` wrapper immediately after each provider call
returns — not batched at the end — because Pipedrive rotates its refresh
token on every use, so a crash before the write would strand a dead token.
23 tests (plan said 22).

Two divergences caught by `tsc --noEmit`, neither changing behavior: (1) the
plan's `connection.id` reference inside the nested `call()` closure doesn't
keep TypeScript's null-narrowing from the outer `if (!connection) return`
checks — closures aren't covered by that control-flow analysis — so it's
hoisted into a `const connectionId = connection.id` above the closure and
`call()` uses that instead; (2) `sync.test.ts`'s shared `credentials` fixture
was left as an untyped literal, whose inferred `kind: string` doesn't satisfy
`CrmOAuthCredentials`'s `kind: 'oauth'` once a test narrows `provider.upsertCompany`
through `vi.mocked()` (which types strictly against the `CrmProvider`
interface) — annotated it `const credentials: CrmOAuthCredentials = {...}`,
same pattern already used in `hubspot-provider.test.ts`.

**Task 9 — sync worker route.** `POST /api/crm/sync`
(`src/app/api/crm/sync/route.ts`) — thin adapter: verify QStash signature →
Zod-validate `{ caseId: uuid, reason: enum }` → delegate to `runCrmSync` →
map the outcome union to a status code (`synced`/`skipped`/`permanent_failure`
→ 200, `busy` → 500 so QStash retries, a thrown retryable AppError falls
into the same 500 catch-all). All logic stays in `runCrmSync`; the route has
none of its own. 9/9 tests, matching the plan's count exactly.

One test-fixture bug caught by Zod, not by the plan's code: the plan's
`route.test.ts` used `caseId = '11111111-2222-3333-4444-555555555555'` for
its valid-UUID fixture, but Zod 4's `.uuid()` enforces the real RFC 4122
shape (version nibble `1`-`8`, variant nibble `8`/`9`/`a`/`b`) — that fourth
group starts with `5`, which fails variant validation, so every "happy path"
test was silently hitting the 400 branch instead of exercising success/skip/
busy/permanent-failure at all. Replaced with
`'11111111-2222-4333-8444-555555555555'` (version `4`, variant `8`),
matching the fixture convention already used in
`src/app/api/inbound/reply/route.test.ts`.

Verified: full suite 169 files / 1740 tests passing (was 1686 after Task 6),
`tsc --noEmit` clean, `eslint` clean (same six pre-existing unrelated
warnings, no errors).

Not done yet: Tasks 10-13 (OAuth connect/callback routes, `/settings/crm`
page + Server Actions, case-detail sync indicator, wiring the six
`enqueueCrmSync` call sites). Nothing commits until asked — working tree
stays dirty by design.

## CRM integrations (HubSpot / Pipedrive) — Tasks 10-12 of 13 (2026-08-02, inline, no commits)

Continuation of the above, same plan/design docs, inline execution (no
subagent dispatch), no commits.

**Task 10 — OAuth connect and callback routes.** New dynamic segment
`src/app/api/crm/[provider]/{state-cookie.ts,connect/route.ts,callback/route.ts}`,
mirroring `/api/mailboxes/google/{connect,callback}` with the one
deliberate inversion the design calls out: `role !== 'client'` → 403, not
`!== 'operator'` — a CRM grant belongs to the client, a mailbox belongs to
the agency. `connect` mints a random `state` nonce into an httpOnly,
`sameSite: 'lax'` cookie scoped to `/api/crm` and redirects to
`getCrmProvider(provider).buildAuthUrl(state)`; `callback` reads the raw
`cookie` header (no typed jar on a plain `Request`), compares state with
`timingSafeEqualString` (the actual CSRF check), exchanges the code,
`upsertCrmConnection`s the encrypted tokens, logs `crm.connected`, and
redirects to `/settings/crm?connect=<provider>` or `?error=<code>` on any
thrown `AppError`. `provider` is `z.enum(['hubspot','pipedrive'])`-checked
in both routes; anything else 404s before touching auth state. 19/19 tests
across the three route files (3 connect + 7 callback + the 9 existing sync
tests), matching the plan.

**Task 11 — `/settings/crm` page and Server Actions.** `actions.ts` —
`selectCrmPipeline` and `disconnectCrm`, both inlining the same
session → role → ownership chain rather than sharing a helper: the design
note calls out that `disconnectCrm` must tolerate a missing connection
while `selectCrmPipeline` must reject one, so a shared helper would need a
flag parameter, which is worse than four duplicated lines. The pipeline
picker's hidden `wonStageId`/`lostStageId` inputs submit `''` when a
provider (Pipedrive) reports no closed stage, so the action reads
`formData.get(...) || null` for those two fields before Zod's
`.nullable().default(null)` sees them — `.min(1)` would otherwise reject
the empty string. Added `getLatestCrmSyncAt` to
`src/lib/db/case-crm-links.ts` (most recent `last_synced_at` across a
connection's cases, since that timestamp lives per-case-link, not on the
connection) — 18/18 in that test file now (was 13). Four page states in
`page.tsx`, matching §7.1 of the design exactly: no connection → `EmptyState`
+ connect buttons; `status = 'error'` → reconnect banner naming
`status_reason`; `pipeline_id === null` → `PipelinePicker` (live
`listPipelines()` call, only made in this branch); else → `ConnectionCard`
with last-sync time and a disconnect confirmation that names the blast
radius (existing CRM records untouched, no re-creation on reconnect).
Operators get the same page with `canManage = false`, so pickers/buttons
render read-only copy instead of controls. `loading.tsx`/`error.tsx` copied
from the `/settings` shape verbatim, title changed to "CRM". 8/8 action
tests.

**Task 12 — case-detail sync indicator.** `crm-link-badge.tsx` — one
component, three states: sync error → `WarningCircle` + truncated message;
deal exists but provider gave no portal URL → renders nothing rather than a
dead anchor; else → "Synced to {Provider} ↗" linking out. Wired into
`cases/[id]/page.tsx`'s existing header metadata row (next to the
"Opened …" timestamp) via one added `Promise.all` entry (`getCaseCrmLink`)
plus a conditional second read (`getCrmConnectionForClient`, only fired
when a link row exists — a case with no CRM sync costs nothing extra).

Verified after all three tasks: full suite 172 files / 1761 tests passing
(was 169/1740 after Task 9), `tsc --noEmit` clean, `eslint` clean (same six
pre-existing unrelated warnings, no errors).

Not done yet: Task 13 (wiring the six `enqueueCrmSync` call sites into
`research.ts`/`write.ts`/`reply.ts`/`followup.ts`). Nothing commits until
asked — working tree stays dirty by design.

## CRM Integrations — DONE (Task 13 of 13, 2026-08-02, inline, no commits)

**Goal:** push qualified cases into the client's own CRM (HubSpot, Pipedrive) as Contact + Company + Deal, then keep the Deal's notes and won/lost outcome in step with the case. One-way, outbound only.
**Design:** `docs/superpowers/specs/2026-08-02-crm-integrations-design.md` · **Plan:** `docs/superpowers/plans/2026-08-02-crm-integrations.md`

**Task 13 — wire the pipeline call sites.** Last on purpose, per the plan:
nothing fires until the worker and both providers were proven (Tasks 1-12).
Six one-line `await enqueueCrmSync(caseId, reason)` calls, each immediately
after the existing `updateCaseStatus` it shadows, `enqueueCrmSync` never
throws so none needed a try/catch:

- [x] `src/lib/pipeline/research.ts` → `'ready'` → `enqueueCrmSync(input.caseId, 'qualified')`
- [x] `src/lib/pipeline/write.ts` → `'contacted'` → `enqueueCrmSync(input.caseId, 'contacted')`
- [x] `src/lib/pipeline/reply.ts` → `'in_conversation'` / `'hot_handoff'` / `'lost'` → `enqueueCrmSync(inbound.case_id, ...)` at all three transitions
- [x] `src/lib/pipeline/followup.ts` → `'dead'` → `enqueueCrmSync(sequence.case_id, 'dead')`

Each pipeline test file (`research.test.ts`, `write.test.ts`, `reply.test.ts`,
`followup.test.ts`) needed `vi.mock('@/lib/crm/sync', ...)` added — without
it, the real `enqueueCrmSync` reached for `createAdminClient`/QStash inside
its catch-branch (`logError`, unmocked in those files) and every test that
exercised a wired transition failed with "No 'logError' export is defined
on the mock." Added a plain `enqueueCrmSyncMock = vi.fn()` per file
(matching each file's existing plain-`vi.fn()` convention, not
`vi.hoisted`) and folded it into the shared `beforeEach` reset loop.
`research.test.ts` also got the two regression tests the plan specified:
sync enqueued once the case reaches `ready`, not enqueued when every
research agent fails and the case never gets there.

**Six pipeline call sites wired: `ready`→qualified, `contacted`→contacted,
`in_conversation`, `hot_handoff`, `lost`, `dead`→closed-lost.**
**Known dormant path:** nothing sets `case_status = 'won'` yet, so the
`'won'` reason and its closed-won mapping are implemented and tested but
unreachable until a "mark won" action exists.
**Out of scope:** pulling from the CRM, two-way sync, backfilling
pre-connection cases, custom field mapping, Salesforce, CRM-side webhooks.

Verified: full suite 172 files / 1763 tests passing (was 172/1761 before
Task 13 — +2 for the new research.ts regression tests), `tsc --noEmit`
clean, `eslint` clean (same six pre-existing unrelated warnings, no new
ones). `grep -rn "TODO\|FIXME\|console\.log"` and `grep -rn "supabase.from("`
over `src/lib/crm`, `src/app/api/crm`, `src/app/(app)/settings/crm` both
return nothing, per the plan's Verification Checklist. Manual HubSpot/
Pipedrive sandbox verification (connect, force a case to `ready`, confirm
one Contact/Company/Deal, revoke and confirm the reconnect banner) was not
run — no live sandbox credentials in this environment.

All 13 tasks of the plan are now implemented. Nothing has been committed at
any point in this feature's build — working tree stays dirty by design,
per explicit instruction each session.

---

## Case Mail per-contact tabs — DONE (2026-08-03, inline, no commits until asked)

**Goal:** split the case page's Mail tab from one flat chronological list of
every email into one sub-tab per contacted person, so a multi-contact case
reads as separate conversations instead of an interleaved mess.
**Design:** `docs/superpowers/specs/2026-08-03-case-mail-per-contact-tabs-design.md`
· **Plan:** `docs/superpowers/plans/2026-08-03-case-mail-per-contact-tabs.md`

Executed inline (no subagent dispatch), skipping the plan's per-task commit
steps at the user's request.

- `src/types/mail.ts` (new) — `ComposeContact` moved out of `compose-form.tsx`
  so both `mail-threads.ts` and `mail-tab.tsx` can import it without
  duplicating the shape.
- `src/lib/ui/mail-threads.ts` + `mail-threads.test.ts` (new) —
  `buildContactThreads(leads, emails, composeContacts)` groups a case's flat
  email list into one `ContactThread` per lead with ≥1 email, in `leads`
  order (not recency), plus `newContactOptions` (eligible leads with no
  thread yet). `defaultSubject` is computed per lead from that lead's own
  emails only, replacing the old case-wide computation that leaked one
  contact's subject line into another's reply box. 8/8 tests.
- `compose-form.tsx` — `contacts.length === 1` now renders a static
  "To: Name — email" line instead of a one-option `Select`; the dropdown
  stays for `contacts.length > 1` (the "New" tab). No prop/behavior change.
- `mail-tab.tsx` (new) — three layouts: no threads + no eligible leads today's
  `EmptyState` only; no threads + eligible leads adds a single `ComposeForm`;
  ≥1 thread renders nested `Tabs`, one per contact plus a trailing "New" tab
  when uncontacted eligible leads exist.
- `page.tsx` — replaced the case-wide subject computation and inline Mail
  `TabsContent` body with `buildContactThreads` + `<MailTab>`.

Verified: `pnpm typecheck` clean, `pnpm lint` clean (same six pre-existing
unrelated warnings, no new ones), `pnpm test` 173 files / 1771 tests passing.
Manual in-browser verification (multi-contact case, zero-contact case,
"New" tab send, parked-contact history) not run — no dev server session in
this environment; only automated checks confirmed.

---

## Client-configurable reply mode — DONE (2026-08-03, inline, no commits)

**Goal:** let a client choose, from `/settings`, how the AI handles lead
replies across all of their campaigns — Automatic (`auto_send`), Manual
(`human_approve`), or Hybrid — applying account-wide instead of per-campaign.
**Design:** `docs/superpowers/specs/2026-08-03-client-reply-mode-setting-design.md`
· **Plan:** `docs/superpowers/plans/2026-08-03-client-reply-mode-setting.md`

Executed inline (no subagent dispatch), skipping the plan's per-task commit
steps at the user's request. All 6 tasks implemented; no pipeline code
(`src/lib/pipeline/*.ts`) changed — `getCampaignForCase()` still reads
`campaigns.reply_mode` exclusively, and the new `clients.reply_mode` is kept
in sync onto every campaign row for that client.

- `supabase/migrations/0023_client_reply_mode.sql` — `clients.reply_mode`
  column, reusing the existing `reply_mode` enum, `not null default
  'human_approve'`. `src/types/database.ts` hand-edited to match (`Row`/`Insert`
  on the `clients` table).
- `src/lib/db/clients.ts` `updateClientReplyMode` + `src/lib/db/campaigns.ts`
  `syncReplyModeForClient` (bulk `.update({ reply_mode }).eq('client_id', ...)`,
  deliberately **no status filter** — active, paused, and archived campaigns
  all get the new mode immediately). 4 new tests across both files.
- `src/app/api/campaigns/route.ts` — campaign creation now fetches the client
  row first (404s on `client_not_found`) and passes `client.reply_mode`
  explicitly into the insert, so a new campaign for a client already on
  `auto_send` no longer silently starts on the `human_approve` column default.
  2 new tests (client-mode default, 404 path), 6/6 passing.
- `src/app/(app)/settings/reply-mode-actions.ts` (new) — `updateReplyMode`
  Server Action: `client`-role + non-null `client_id` only (`FORBIDDEN`
  otherwise), Zod-validates the enum, writes `updateClientReplyMode` then
  `syncReplyModeForClient` in that order (both target the terminal value, so
  a retry after a partial failure is idempotent), logs
  `client.reply_mode_changed`, revalidates `/settings`. 3/3 tests.
- `src/app/(app)/settings/reply-mode-section.tsx` (new, client component) —
  labeled `<select>` matching `mailbox-controls.tsx` styling, three options
  each with inline one-line help text, `useTransition` + optimistic revert
  on a failed save (matches `pipeline-picker.tsx`'s pattern). No component
  test, matching the codebase's existing convention for small settings
  selects (`QUALITY.md`: "React components: critical paths only").
- `src/app/(app)/settings/page.tsx` — loads the client's row via
  `getClientById` when `appUser.client_id` is set and renders a new
  "Reply mode" `Section` above "Connect a mailbox"; renders nothing for an
  operator viewing their own settings (no `client_id` to scope to).

Verified: `pnpm typecheck` clean, `pnpm test` 174 files / 1780 tests passing.
Manual in-browser verification (switch the setting as a client-role user,
confirm every campaign row updates in the DB, confirm a newly created
campaign inherits the new mode) not run — no dev server / live Supabase
session in this environment; only automated checks confirmed.
