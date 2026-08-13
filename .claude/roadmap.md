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
- [x] **AI relevance filter**: a company-level Gemini check (`gemini-3.1-flash-lite`, `src/lib/pipeline/ai-relevance.ts`) rejects Apollo-matched-but-irrelevant companies before an Emailable credit is spent — slotted into `discover.ts`'s existing suppression/post-enrich-exclude cascade, cached per company per discovery run (a second contact at the same company costs no extra Gemini call), fails open on Gemini errors/timeouts. Design: `docs/superpowers/specs/2026-08-06-ai-relevance-filter-design.md`. Plan: `docs/superpowers/plans/2026-08-06-ai-relevance-filter.md`.
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
- [x] Review `emailableRejected` after the first week of live runs and decide whether the strict policy needs loosening for accept-all domains — **done 2026-08-08**, see the "Accept-all catch-all carve-out" entry below.

Deviations from the plan, found during TDD:
- `client.test.ts`'s `it.each` for vendor error statuses could not include `249` — the Fetch spec treats any status in [200,299] as `response.ok`, so `249` takes the schema-validation-failure branch (no `status` in the thrown context), not the `!response.ok` branch. Split into its own test asserting only `code: 'EXTERNAL_ERROR'`.
- The abort test in `client.test.ts` used real timers against `verifyEmail`'s internal 10s `TRANSPORT_TIMEOUT_MS`, exceeding Vitest's 5s default test timeout. Switched to `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync`, with the rejection assertion attached before advancing timers to avoid a transient unhandled-rejection warning.
- `discover.test.ts`'s pre-existing `insertedRows()` mock helper hardcoded `email_status: 'verified'` on every returned row regardless of input, so the new park-on-`undeliverable`/`risky`/`unknown` tests couldn't prove `groupVerifiedLead` was skipped. Changed the helper to pass through the row's real `email_status`.

Not done: `pnpm supabase db reset` was never run — Docker was not available in this environment, so `0011_lead_email_verification.sql` is written but unapplied and unverified against a real Postgres. Apply it before the next migration is authored.

Verified: `tsc --noEmit` clean, `eslint` 0 errors (3 pre-existing unrelated warnings), full suite 628/628 (up from 583: +2 `log.test.ts`, +4 `fetch-json.test.ts`, +22 `emailable/client.test.ts`, +18 `emailable/map-verification.test.ts`, +10 `discover.test.ts` net of the mock fix). Every task ran red before green. Commits skipped per instruction.

## Emailable accept-all catch-all carve-out — shipped 2026-08-08

One week of live data showed the deliverability guard's `risky` bucket
running ~62% of verified leads (54/87 in one operator-reported sample), and
a direct query of production `leads.email_verification` found it was 100%
`accept_all: true` + `reason: 'low_deliverability'` — a domain-level "cannot
confirm" signal, not an address-level "bad" signal. `mapEmailableVerdict`
now activates that specific combination; `low_quality` risky results and
every `undeliverable`/`unknown`/unrecognized state still park unchanged.

Plan: `docs/superpowers/plans/2026-08-08-emailable-accept-all-catch-all.md`.
Spec amendment: `docs/superpowers/specs/2026-07-21-emailable-verification-design.md` (Amendment — 2026-08-08).

- [x] `mapEmailableVerdict` carve-out + unit tests (`src/lib/emailable/map-verification.ts`, `.test.ts`) — 25/25 tests, 5 new.
- [x] End-to-end regression tests in `src/lib/pipeline/discover.test.ts` proving the carve-out reaches the inserted row — 55/55 tests, 3 new.
- [ ] Watch bounce rate on `email_status = 'risky' AND status = 'active'` leads over the next 1-2 weeks (queryable directly against `leads.email_verification` — no new counter was added; an optional `emailableAcceptAllActivated` rollup metric is specced in the implementation plan if that turns out to be worth adding later).

**Follow-up fix — 2026-08-09:** the carve-out above set `status: 'active'` on
catch-all leads but `listActiveLeadsForCase` (`src/lib/db/leads.ts`, last
touched Aug 7, one day before the carve-out shipped) still additionally
required `email_status = 'verified'` to consider a lead send-eligible — so
every carve-out-activated lead was silently stranded one stage later, never
drafted. Surfaced by an operator report: Uniforms Fashion pulled 14 active
leads on 2026-08-09 but only 8 emails were drafted; all 6 missing leads
traced to this exact carve-out case (`accept_all: true`,
`reason: 'low_deliverability'`, `provider: 'emailable'`). Fixed by dropping
the `email_status` filter from `listActiveLeadsForCase` — `status = 'active'`
is now the single send-eligibility signal there too, matching
`getVerifiedLeadCompanies` and `listOtherActiveLeadsForCollisionNotice`,
which already relied on `status` alone. TDD: new
`listActiveLeadsForCase` test (risky-but-active lead included, parked lead
excluded) written and confirmed red before the fix, green after.

**Client-facing label fix — same day:** the case page (`/cases/[id]`,
client-facing per its `getTranslations('cases')` usage) rendered
`lead.email_status` verbatim, so a `risky` catch-all-activated lead showed
"Risky" directly to the client — read as "you're emailing risky people,"
alarming and not actionable for them. Added `leadEmailStatusMetaFor(status,
role)` (`src/lib/ui/status.ts`) — an operator still sees the real "Risky"
label for diagnosis; a client sees "Verified" for the same lead, since it's a
domain-level catch-all signal, not an address-level problem, and the lead is
already being sent to. Every other `lead_email_status` value passes through
unchanged for both roles. TDD: 4 new tests (operator sees risky, client sees
verified-for-risky, client sees verified-for-verified, all other statuses
unaffected for both roles), red before, green after.

Full suite 2196/2196, `tsc --noEmit` clean, `eslint` 0 errors.

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
clause, liability cap, SCC elections) need counsel review before they are relied on.

**Update (2026-08-12):** operator confirmed `foundersideai.com` is no longer the operating
domain. `src/lib/legal/contact.ts` now uses `shengul@shengulai.com` for `CONTACT_EMAIL` and
`NOTICE_EMAIL`, and `http://www.shengulai.com` for `SITE_HOME_URL`.

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

## CRM settings moved into main `/settings` page

The CRM connect/pipeline/connection UI previously lived on its own route,
`/settings/crm` (`src/app/(app)/settings/crm/`). Folded it into the main
`/settings` page instead of a separate route:

- Moved `crm/connect-crm-buttons.tsx`, `crm/connection-card.tsx`,
  `crm/pipeline-picker.tsx` up to `src/app/(app)/settings/` (unchanged
  content besides import paths).
- `crm/actions.ts` -> `settings/crm-actions.ts` (renamed to avoid ambiguity
  now that it sits next to `reply-mode-actions.ts`); `SETTINGS_PATH` updated
  from `/settings/crm` to `/settings`. Test file moved and renamed to match.
- Deleted `crm/page.tsx`, `crm/loading.tsx`, `crm/error.tsx` — no longer a
  distinct route, so no route-level loading/error boundary needed.
- `src/app/(app)/settings/page.tsx` now also fetches the CRM connection
  (`getCrmConnectionForClient`), pipelines (when setup is incomplete), and
  last-synced-at, rendering the same four states (no connection / error /
  needs-pipeline / connected) as a `Section` below "Connected mailboxes".
- `src/app/api/crm/[provider]/callback/route.ts` redirects updated from
  `/settings/crm?...` to `/settings?...` (both the success and error paths).

No nav link pointed at `/settings/crm` (the sidebar's `/crm` entry is the
unrelated Pipeline view), so nothing else needed updating.

Verified: `tsc --noEmit` clean, `eslint` clean on touched files, both
affected test files passing (`settings/crm-actions.test.ts`,
`api/crm/[provider]/callback/route.test.ts`, 15/15).

## Configurable per-mailbox warmup caps (all 7 tasks, plan in
## `docs/superpowers/plans/2026-08-03-configurable-warmup-caps.md`)

Executed inline (no commits made — left staged/unstaged for the user to
review and commit). All 7 tasks done.

- **Task 1** — `supabase/migrations/0024_configurable_warmup_caps.sql`:
  adds `mailboxes.warmup_start_cap` (default 5), `warmup_increment`
  (default 3), `warmup_target_cap` (backfilled from `daily_cap`, then set
  `not null`). `src/types/database.ts` `mailboxes` `Row`/`Insert` widened
  to match.
- **Task 2** — `src/lib/mailbox/warmup.ts` rewritten: deleted the global
  `WARMUP_START_CAP`/`WARMUP_INCREMENT` constants; `EffectiveCapInput` now
  takes `startCap`/`increment`/`targetCap` per mailbox instead. Added
  `getMailboxWarmthStatus()` (discriminated union: `not_ramping` /
  `ramping` / `ramp_complete`) as the shared source of truth for "is this
  mailbox still ramping," sharing ramp-value math with `effectiveDailyCap`
  via an internal `computeRampState` helper. `warmup.test.ts` fully
  rewritten, 19/19 passing.
- **Task 3** — `src/lib/mailbox/sender.ts` now passes
  `candidate.warmup_start_cap`/`warmup_increment`/`warmup_target_cap`
  into `effectiveDailyCap`. `sender.test.ts` fixture updated with the
  three new fields; 27/27 passing.
- **Task 4** — `src/lib/db/mailboxes.ts`: `updateMailboxWarmup` now takes
  a `Partial<Pick<MailboxRow, ...>>` covering all four numeric fields plus
  `warmup_profile`/`warmup_started_at` (was a fixed two-field shape);
  removed the now-unused `WarmupProfile` import. `MailboxSummary` and
  `listMailboxesForViewer`'s select string both widened with the three new
  columns. `mailboxes.test.ts` +1 test (partial-update case), 42/42
  passing.

- **Task 5** — `src/app/(app)/settings/mailbox-row.tsx`: now imports
  `getMailboxWarmthStatus`, takes `warmupStartCap`/`warmupIncrement`/
  `warmupTargetCap` props, and the "warming up" label reads
  `day N, target T` off the shared status helper instead of comparing
  `capToday < dailyCap`. `page.tsx` passes the three new fields through
  from `MailboxSummary`.
- **Task 6** — `src/app/api/mailboxes/[id]/warmup/route.ts` rewritten
  from a single-field `{ profile }` body to a fully partial update
  (`profile`, `warmupStartCap`, `warmupIncrement`, `warmupTargetCap`,
  `dailyCap`, all optional, `z.number().int().positive()`). Only resets
  `warmup_started_at` when `profile` is present **and** differs from the
  mailbox's current stored value; a numeric-only payload never touches the
  clock; a no-op payload skips the DB write and the event log entirely.
  New `route.test.ts`, 8/8 passing.
- **Task 7** — new Warmup tab on `/clients/[id]`: `warmup-mailbox-row.tsx`
  (Client Component, per-mailbox row with profile `<select>` and four
  `<input type="number">` fields — start cap, increment, target cap,
  already-warm cap — each posted independently on blur via the Task 6
  route) and `warmup-tab.tsx` (Server Component, calls
  `listMailboxesForClient`, empty state when the client has zero
  mailboxes). Wired into `page.tsx`: `tabSchema` gained `'warmup'`, a
  lazily-fetched `mailboxes` var (only queried when that tab is active,
  matching the existing `knowledgeSources` pattern), a `TabsTrigger`
  (Thermometer icon) and `TabsContent` between Campaigns and Analytics.

Verified: `pnpm typecheck` clean, `pnpm test` fully green (175 files /
1798 tests, up from 174/1790), `pnpm lint` clean on every touched file.
Manual in-browser verification (per the plan's Task 7 Step 6) not run — no
dev server / live Supabase session in this environment; only automated
checks confirmed. The migration itself has also not been applied to any
database — that requires the user's own `supabase db reset` or equivalent
migration-apply step before the new columns exist anywhere.

## Knowledge-base hybrid retrieval — Tasks 1-5 of 10 (2026-08-04, inline, no commits)

Plan: `docs/superpowers/plans/2026-08-04-knowledge-hybrid-search.md`. Spec:
`docs/superpowers/specs/2026-08-04-knowledge-hybrid-search-design.md`.
Executed inline (no subagents, no commits) per explicit user request. Tasks
6-10 (paragraph-aware chunker, boilerplate stripper, scrape-cap split,
route wiring) remain.

- **Task 1** — new `supabase/migrations/0025_knowledge_hybrid_search.sql`:
  adds `client_knowledge_chunks.content_tsv` (generated `tsvector`,
  `simple` config) + GIN index; drops and recreates
  `match_client_knowledge_chunks` with a new `p_query_text` param, ranking
  by Reciprocal Rank Fusion (constant 60) of vector-cosine rank and
  full-text rank instead of vector-cosine alone. `src/types/database.ts`
  function-args type widened to match. Not applied to any live DB — no
  local Supabase CLI in this environment, matches the plan's documented
  fallback.
- **Task 2** — `src/lib/db/client-knowledge.ts`:
  `matchClientKnowledgeChunks` gained a `queryText: string` parameter,
  passed through as `p_query_text` to the RPC. `client-knowledge.test.ts`
  updated (22/22 passing).
- **Task 3** — `src/lib/knowledge/client-context.ts`: added
  `dedupeNearDuplicates` (Jaccard token-overlap > 0.9 on whitespace-split
  tokens, pure TS, no extra DB round-trip) and wired
  `retrieveClientKnowledge` to pass `queryText` to the RPC and run
  dedup after the `MIN_SIMILARITY` floor. `client-context.test.ts` +2
  tests (14/14 passing).
- **Task 4** — new `src/lib/knowledge/build-query.ts`:
  `buildKnowledgeQueryText({ primary, secondary? })` — caps `secondary`
  to `MAX_SECONDARY_CHARS` (500) whenever `primary` is non-empty, so a
  long dossier fact-dump can't drown out the actual prospect signal; no
  cap when `primary` itself is empty (the dossier-as-primary case).
  `build-query.test.ts`, 6/6 passing.
- **Task 5** — wired `buildKnowledgeQueryText` into all four pipeline
  call sites: `write.ts` (primary = dossier), `reply.ts` (primary =
  inbound body when present, else dossier), `followup.ts` (primary =
  first outbound body), `knowledge-answer.ts` (primary = human answer).
  No test changes needed — none of the four pipeline test files assert
  the literal `queryText` string.

Verified: `pnpm test` fully green (176 files / 1806 tests, up from
175/1798), `pnpm typecheck` clean, `pnpm lint` clean (only 6 pre-existing
unrelated warnings in unconnected test files, 0 errors).

## Knowledge-base hybrid retrieval — Tasks 6-10 of 10, DONE (2026-08-04, inline, no commits)

Same plan/spec as the Tasks 1-5 entry above. Executed inline, no
subagents, no commits, per explicit user request. All 10 plan tasks now
complete.

- **Task 6** — `src/lib/knowledge/chunk-text.ts` rewritten from a raw
  fixed-size char sliding window to a paragraph packer: splits on
  blank-line boundaries, greedily packs paragraphs up to `chunkSize`,
  carries a whitespace-snapped tail of the previous chunk forward as
  overlap, and hard-splits an oversized single paragraph at the nearest
  space (never mid-word — the direct fix for the audit's 55%
  mid-word-cut-chunk finding). New `MIN_CHUNK_CHARS = 20` backstop drops
  any resulting fragment below that length. Same exported signature —
  `embedAndStoreChunks` (`src/lib/db/client-knowledge.ts`) needed no
  changes. `chunk-text.test.ts` fully rewritten (7/7 passing);
  `client-knowledge.test.ts` unaffected (22/22 still passing, traced by
  hand per the plan: the oversized-paragraph fixture still yields exactly
  2 chunks, only chunk 1's overlap prefix changed and that test never
  asserts `content`).
- **Task 7** — new `src/lib/knowledge/strip-boilerplate.ts`:
  `stripBoilerplateParagraphs(content, siblingContents)` strips any
  paragraph (whitespace-normalized) that recurs across
  `max(2, min(3, ceil(siblingContents.length / 2)))` or more siblings —
  the direct fix for the audit's 34% boilerplate-pollution finding. Pure,
  no I/O, can't fail. `strip-boilerplate.test.ts`, 5/5 passing.
- **Task 8** — `src/lib/db/client-knowledge.ts`: added
  `listReadySiblingWebsiteContents(supabase, clientId, excludeSourceId)` —
  fetches `content` from the client's other `ready` `website_page`
  sources, filters out nulls. `client-knowledge.test.ts` +2 tests
  (24/24 passing).
- **Task 9** — `src/lib/research/brightdata.ts`: `scrape()` gained an
  optional `maxChars` parameter (default `MAX_SCRAPE_CHARS = 6_000`,
  unchanged for the research/dossier caller in `agent.ts`). Widened the
  `WebResearch` interface's `scrape` signature in
  `src/lib/research/provider.ts` to match (it declared the 1-arg shape
  explicitly). `brightdata.test.ts` +1 test; full `src/lib/research` dir
  17/17 passing.
- **Task 10** — `src/app/api/pipeline/knowledge-scrape/route.ts`
  rewritten: scrapes with the new `KNOWLEDGE_SCRAPE_MAX_CHARS = 40_000`
  ceiling (was silently truncating at 6,000 — the audit's silent-
  truncation finding), fetches sibling ready website-page content via
  Task 8's helper (sibling-lookup failure is caught locally, logged as
  `knowledge.sibling_lookup_failed`, and degrades to "no siblings" —
  never fails the scrape), strips boilerplate via Task 7's function
  before chunking, but still stores the **raw** unstripped content + true
  char count on the source row (audit trail unchanged). `route.test.ts`
  +3 tests (7/7 passing).

Verified: `pnpm test` fully green (177 files / 1818 tests, up from
176/1806), `pnpm typecheck` clean, `pnpm lint` clean (same 6 pre-existing
unrelated warnings, 0 errors). Not verified: the 0025 migration has not
been applied to any live database (no local Supabase CLI in this
environment — matches the plan's documented fallback for Task 1/Step 3);
no manual in-browser verification of the scrape pipeline.

## Knowledge-base "Re-scrape all" button (2026-08-04, inline, no commits)

Bulk re-scrape for a client's website-page knowledge sources, added
directly (not part of the hybrid-search plan) since existing re-scrape
was per-source only, one click at a time.

- New `src/app/api/clients/[clientId]/knowledge/rescrape-all/route.ts`
  (operator-only, same auth/idempotency contract as the existing
  per-source `[sourceId]/rescrape` route): lists the client's sources,
  filters to `source_type === 'website_page'` and `status !== 'pending'`
  (skips sources already mid-scrape rather than duplicating the queued
  job), then per source calls `resetSourceToPending` +
  `publishJson('/api/pipeline/knowledge-scrape', ...)`. A single
  source's failure is caught, logged (`knowledge.rescrape_all_source_failed`),
  and counted — it does not abort the rest of the batch. Logs one summary
  event (`knowledge.rescrape_all_requested`) with `totalSources` /
  `queued` / `failedSourceIds`. Returns `{ ok, queued, failed }`.
  `route.test.ts`, 5/5 passing (403 for non-operators, full-batch success,
  skips pdf/pending sources, partial-failure counting, zero-rescrapable
  no-op).
- New `src/app/(app)/clients/[id]/knowledge-rescrape-all-button.tsx`
  (Client Component): renders nothing when there are zero website-page
  sources; otherwise a confirm-gated button that POSTs to the new route
  and toasts the queued/failed counts. Wired into `clients/[id]/page.tsx`'s
  Knowledge tab header, next to the existing file-upload button.

Verified: `pnpm test` fully green (178 files / 1823 tests, up from
177/1818), `pnpm typecheck` clean, `pnpm lint` clean (same 6 pre-existing
unrelated warnings, 0 errors). No manual in-browser click-through — no
dev server / live Supabase session in this environment.

## Mailbox connect opened to client-role users (2026-08-04, inline, no commits)

All three mailbox-connect flows (Gmail OAuth, Outlook OAuth, generic
SMTP/IMAP) were hard-gated to `role === 'operator'`, so a client-role
login got a bare 403 from `/api/mailboxes/smtp/connect` (reported via a
Yandex-mail SMTP connection attempt) and from the two OAuth `/connect`
+ `/callback` routes. Every mailbox was also unconditionally attached to
the single "Demo Client" row via `getOrCreateOperatorClient`, which was
never going to be right for a client-role connect anyway.

- New `resolveMailboxClientId(supabase, appUser)` in `src/lib/db/clients.ts`:
  exhaustive switch on `appUser.role` — `operator` still resolves the
  shared demo client via the existing `getOrCreateOperatorClient`;
  `client` returns `appUser.client_id` directly, throwing `AppError`
  `FORBIDDEN` if it's null (defense-in-depth only — the routes below
  reject that case before doing any work) and `INVARIANT_VIOLATION` via
  `assertNever` on any future role value.
- `src/app/api/mailboxes/{google,outlook}/connect/route.ts`,
  `{google,outlook}/callback/route.ts`, `smtp/connect/route.ts`: replaced
  the `role !== 'operator'` 403 with a narrower guard
  (`role === 'client' && client_id === null`) and swapped
  `getOrCreateOperatorClient` for `resolveMailboxClientId` in the three
  routes that insert a mailbox row (callbacks + smtp connect) so a
  client-role connect lands on the caller's own client, not the demo one.
- `src/lib/db/clients.test.ts` +3 tests for `resolveMailboxClientId`
  (operator path, client path, FORBIDDEN-on-null path).
  `smtp/connect/route.test.ts`: replaced the stale "403 for non-operator"
  test with a 403-on-null-client_id test plus a new success test for a
  client-role caller with a `client_id`.
- Not touched: MailReach connect/disconnect routes (a separate
  operator-managed warmup service, not "connect a mailbox") and
  `MailboxRow`'s `viewerRole === 'operator'` gate on warmup/MailReach
  controls — out of scope for this change.

Verified: `pnpm test` fully green (178 files / 1827 tests, up from
178/1823), `pnpm typecheck` clean, `pnpm lint` clean (same 6 pre-existing
unrelated warnings, 0 errors). Not verified: no manual in-browser
click-through as a client-role login — no dev server / live Supabase
session in this environment.

## Mailreach SMTP connect 404 fix (2026-08-04)

**Plan:** `docs/superpowers/plans/2026-08-04-mailreach-smtp-connect-404.md`
**Spec:** `docs/superpowers/specs/2026-08-04-mailreach-smtp-connect-404-design.md`

Root cause (confirmed live, not guessed): `connectSmtpAccount` posted to
`POST /connect-account`, which returns a real `404` on Mailreach's API —
it never existed. Every SMTP mailbox connect attempt was failing
silently. The real endpoint is `POST /v1/imap_auth`, confirmed against
Mailreach's OpenAPI spec plus a live probe with the project's own
`MAILREACH_API_KEY`.

- **Task 1** (committed) — `supabase/migrations/0027_mailbox_contact_name.sql`
  adds nullable `mailboxes.first_name`/`last_name` (Mailreach's
  `imap_auth` requires both, and nothing collected them before now).
  `src/types/database.ts` `Row`/`Insert` updated to match.
- **Task 2** (committed) — `src/lib/mailreach/client.ts`: `connectSmtpAccount`
  rewritten against the real `POST /v1/imap_auth` request/response shape
  — `provider: 'custom'` (generic SMTP/IMAP, per the endpoint's own
  description), real field names (`imap_server`, `smtp_server_username`,
  etc.), and `accountId: String(res.id)` (an integer on the wire, never
  `res.account_id`). `toMailreachProvider`/OAuth path/`getAccountStats`
  untouched — both explicitly out of scope for this fix.
  `client.test.ts` rewritten to match.
- **Task 3** (committed) — `src/lib/mailreach/enrollment.ts`:
  `connectSmtpMailbox` now reads `mailbox.first_name`/`last_name` via a
  new `legacyNameFallback` helper (falls back to the email's local part
  for pre-migration rows where both columns are still `null`) and passes
  them to `connectSmtpAccount`. `bulkReconnectSmtpForClient` unchanged —
  it calls `connectSmtpMailbox` and inherits the fallback for free.
  `enrollment.test.ts` +2 tests (named-row pass-through, legacy fallback).
- **Task 4** (uncommitted, per user request to skip further commits) —
  `src/app/api/mailboxes/smtp/connect/route.ts`: `bodySchema` gains
  required `firstName`/`lastName` (min length 1), threaded straight to
  `insertMailbox`'s `first_name`/`last_name` (not through the encrypted
  `SmtpCredentials` payload — they're a plain column, not a token).
  `route.test.ts` +2 tests (missing/empty-string rejection) + the
  success-path assertion extended to check both columns land on the row.
- **Task 5** (uncommitted) — `src/app/(app)/settings/connect-smtp-dialog.tsx`:
  two new required "First name"/"Last name" inputs (`FormValues`,
  `INITIAL_VALUES`, POST body, JSX grid) placed right after the existing
  optional "Display name" field, before the Username/Password grid. No
  colocated test file for this component (client components are tested
  at critical paths only per `.claude/QUALITY.md`), so this task was
  implement-and-typecheck, not red/green.

Verified: `pnpm typecheck && pnpm lint && pnpm test` all clean — 179
files / 1855 tests passing, 0 type errors, 0 new lint errors (same 7
pre-existing unrelated warnings). **Not verified**: no live click-through
against a real Mailreach account — no dev server / live Supabase session
/ real `MAILREACH_API_KEY` round-trip available in this environment. Per
the plan's Task 6, this fix should not be considered fully confirmed
until someone does one real connect against
`info@uniformsfashion.com` (mailbox `28879483-ed6b-4f87-9d48-553b909c39a8`)
and checks `mailreach_status`/`mailreach_account_id` plus Mailreach's own
`GET /v1/accounts` — the `provider: 'custom'` enum value in particular
was reasoned from the OpenAPI spec's endpoint description, not
live-tested end to end.

---

## Discovery pipeline precision & cost-efficiency — DONE (Tasks 1-6 of 6, 2026-08-05, inline, no commits)

**Plan:** `docs/superpowers/plans/2026-08-05-discovery-pipeline-precision.md`
**Spec:** `docs/superpowers/specs/2026-08-05-discovery-pipeline-precision-design.md`

Stops paying for Apollo/Emailable work on people already suppressed or
excluded for a client, dedups Apollo reveals per client instead of per
campaign, and exposes the two previously-dead `personSeniorities`/
`contactEmailStatuses` Apollo ICP filters end to end.

- **Task 1** (uncommitted) — `src/lib/db/suppressions.ts`: new
  `getSuppressions(supabase, clientId, emails[])` — one bulk
  `.in('email', ...)` lookup scoped by `client_id`, same
  trim/lowercase normalization as the existing single-email
  `getSuppression`. `suppressions.test.ts` +4 tests.
- **Task 2** (uncommitted) — `src/lib/apollo/exclude-keywords.ts`:
  `matchesExcludedKeywords`'s candidate shape gains optional
  `organizationIndustry`/`organizationDescription` (only available
  post-enrich), folded into the same whole-word keyword match as
  `title`/`organizationName`. Fully backward compatible — every
  pre-enrich call site keeps working unchanged. `exclude-keywords.test.ts`
  +3 tests.
- **Task 3** (uncommitted) — `src/lib/db/leads.ts`: `getKnownSourceIds`
  now takes `clientId` and queries `.eq('client_id', ...)` instead of
  `.eq('campaign_id', ...)` — a person revealed by one campaign for a
  client is never re-enriched by another campaign of the same client.
  `getVerifiedLeadCompanies` (pass-2 company targeting) stays
  campaign-scoped, unaffected. `leads.test.ts` +1 test.
- **Task 4** (uncommitted) — `src/lib/pipeline/discover.ts`:
  `enrichCandidates` now takes `supabase` and, right after building each
  batch's rows from Apollo's enrich response and before `verifyBatch`
  runs, checks each row against (a) the post-enrich exclude-keyword match
  (industry/description) and (b) a bulk `getSuppressions` lookup — a
  match on either parks the row (`status: 'parked'`) and skips the
  Emailable call entirely, logging
  `pipeline.discover.excluded_post_enrich` /
  `pipeline.discover.suppressed_skipped` events. **Correctness fix
  required by this change**: three call sites (`groupVerifiedLead` gate,
  `verifiedApolloIds`, the `verified` counter) switched from reading
  `row.email_status === 'verified'` to `row.status === 'active'` — a
  parked row keeps Apollo's raw `email_status: 'verified'` (that's why it
  matched) but must not be treated as send-eligible. `DiscoverySummary`/
  `EnrichResult` gain `suppressedSkipped`/`excludedPostEnrich` counters.
  `discover.test.ts` +7 tests (new describe block) plus 3 pre-existing
  row-mocking helpers fixed to carry `status` so they don't silently stop
  matching after the gating change.
- **Task 5** (uncommitted) — `src/components/ui/checkbox.tsx`: new
  `Checkbox` primitive, same construction pattern as `select.tsx`
  (`radix-ui`'s combined package, `cn`, `data-slot` attrs, shadcn token
  classes). No colocated test — this project has no jsdom/component-test
  setup, per the plan's Global Constraints; verified via typecheck/lint.
- **Task 6** (uncommitted) — two previously-dead ICP filters wired end to
  end:
  - `src/app/api/campaigns/route.ts`: `createCampaignSchema` gains
    `personSeniorities`/`contactEmailStatuses` (validated against
    `apolloPersonSeniorities`/`apolloContactEmailStatuses`), forwarded
    into the `apolloIcpSchema.parse({...})` call — previously silently
    dropped even if the client sent them. `route.test.ts` +3 tests
    (pass-through, default-to-empty, 400 on an unrecognized value).
  - `src/app/(app)/campaigns/new-campaign-form.tsx`: two checkbox groups
    added to the ICP fieldset — "Target seniority" (none checked by
    default) and "Contact email status" (`verified` pre-checked),
    reading via `formData.getAll(name)`. No campaign-edit UI exists, so
    this is creation-time-only, matching every other ICP field.

Verified: `npm run test && npm run typecheck && npm run lint` all
clean — 180 files / 1881 tests passing, 0 type errors, 0 new lint
errors (same 7 pre-existing unrelated warnings). Two TS errors surfaced
during Task 4's typecheck (optional `source_id`/`company_domain`/
`company_name` on the `LeadInsert` insert type not narrowing the way the
plan's snippet assumed) and were fixed with a `!= null` guard and
`?? null` coalescing respectively. A third, in Task 6, wasn't
anticipated by the plan either: Radix's `Checkbox.Root` renders a
`<button>`, but `toolparamdescription` (the declarative-WebMCP field
hint) was only typed onto `Input`/`Textarea`/`Select` HTML attributes in
`src/types/webmcp.ts` — extended that module augmentation to
`ButtonHTMLAttributes` too, so it now also covers Radix's other
button-based form controls, not just this one.

---

## Inbox draft: AI redesign box + manual editing — DONE (all 5 tasks, 2026-08-05, inline, no commits)

Plan: `docs/superpowers/plans/2026-08-05-inbox-draft-redesign.md`
Design: `docs/superpowers/specs/2026-08-05-inbox-draft-redesign-design.md`

`/inbox` → "Drafts awaiting approval" (`DraftRow`) gains two things: an
operator can (1) type a freeform instruction and have the AI rewrite a
queued draft, re-grounded in the same case dossier/thread the original
draft used, and (2) hand-edit or fully rewrite the subject/body
themselves before approving. `cases/[id]/compose-form.tsx` untouched.

- **Task 1** — `src/lib/pipeline/draft-schema.ts` (new): `draftSchema`,
  `SUBJECT_TARGET_CHARS`, `SUBJECT_HARD_LIMIT` extracted out of
  `write.ts` so a new redesign pipeline validates against the exact same
  shape instead of a second, possibly-drifting copy. `write.ts` now
  imports from it; no behavior change, existing `write.test.ts` still
  green.
- **Task 2** — `updateDraftContent` in `src/lib/db/emails.ts`: same
  atomic-claim shape as `claimDraftForSend` (`.eq('status','draft')`
  guard) — a concurrent approval makes a manual Save or an AI Redesign a
  no-op returning `null` instead of silently overwriting a row that
  already went out. One write path for both.
- **Task 3** — `src/lib/pipeline/redesign.ts` (new):
  `regenerateDraftContent(supabase, { emailId, instruction })`. Loads
  the draft, re-fetches `case_knowledge` + (for a reply draft,
  `in_reply_to_email_id` set) the prior thread via `listThreadEmails`,
  calls `generateJson` against the shared `draftSchema` with a system
  prompt that forbids inventing facts beyond the dossier/thread, logs
  `inbox.draft_regenerated` via `logEventSafe`. Does not write to the
  DB itself — returns `{ subject, body }` for the caller to persist
  through `updateDraftContent`.
- **Task 4** — `MAX_INSTRUCTION_CHARS = 500` added to
  `src/lib/validation/email-limits.ts`; two new operator-only Server
  Actions in `src/app/(app)/inbox/actions.ts`:
  `updateDraftContent(formData)` (manual Save, throws
  `VALIDATION_ERROR` if the DB call returns `null`) and
  `regenerateDraftContent(formData)` (AI Redesign, returns a typed
  `RegenerateDraftResult` — `ok:false` with a `code` on an LLM failure
  or a lost race to approval, not a throw — mirroring
  `SendManualEmailResult`'s pattern).
- **Task 5** — `src/app/(app)/inbox/draft-row.tsx` full rewrite: `Edit`
  button reveals editable Subject/Body (`Input`/`Textarea`,
  `maxLength` from the shared constants) plus a dashed-border "Redesign
  with AI" box (instruction `Input` + `Redesign` button, inline error on
  failure that preserves the instruction and any unsaved edits) and
  Save/Clear/Cancel. "Approve and send" is disabled and the footer note
  changes whenever the edit form is open, so an operator can never send
  stale DB content while believing an in-progress edit already went
  out. No `page.tsx` changes needed — `DraftRowProps` unchanged.

Verified: `pnpm test && pnpm typecheck && pnpm lint` all clean — 182
files / 1906 tests passing (was 180/1881 before this feature — +2 files,
+25 tests: `draft-schema.test.ts` new, `redesign.test.ts` new,
`emails.test.ts` +3, `actions.test.ts` +9), 0 type errors, 0 new lint
errors (same 7 pre-existing unrelated warnings). No component test file
for `draft-row.tsx` — this codebase has no jsdom/testing-library setup
(`vitest.config.ts` only runs `src/**/*.test.ts` in a `node`
environment), matching every other `/inbox`/`/settings` component; the
Server Actions and pipeline underneath, which hold all the logic, are
fully covered. Manual verification (run `pnpm dev`, exercise Edit →
Redesign → Save → Approve, the race-lost "already sent" case) was not
run in this session — left for the user per the plan's Step 5.

---

## Configurable follow-up cadence — all 10/10 tasks DONE (2026-08-05, inline, no commits)

Plan: `docs/superpowers/plans/2026-08-05-configurable-followup-cadence.md`
Design: `docs/superpowers/specs/2026-08-05-configurable-followup-cadence-design.md`

Lets a client choose how many follow-up nudges go out after a first-touch
email and how many days apart they are, replacing the hardcoded 3/7/14-day,
3-step cadence in `followup.ts` — a client-wide default on `/settings` and
a per-contact override on `/cases/[id]`. Landed in two inline batches
(Tasks 1–5 data layer, then Tasks 6–10 pipeline + both UIs), no commits
made either time — working tree left dirty for the user to review.

- **Task 1** — `supabase/migrations/0028_configurable_followup_cadence.sql`
  (new): `followup_delays_days integer[] not null default '{3,7,14}'` added
  to both `clients` and `sequences`. `src/types/database.ts` hand-edited to
  match (`ClientRow`/`ClientInsert`/`SequenceRow`/`SequenceInsert`).
- **Task 2** — `src/lib/validation/followup-limits.ts` (new):
  `MIN/MAX_FOLLOWUP_STEPS` (1–10), `MIN/MAX_FOLLOWUP_DELAY_DAYS` (1–90),
  `DEFAULT_FOLLOWUP_DELAYS_DAYS = [3, 7, 14]`, and `followupDelaysSchema`
  (`z.coerce.number()` per element, for FormData string inputs) — the one
  shared bounds schema both the Settings and per-lead forms will validate
  against.
- **Task 3** — `updateClientFollowupDelays` in `src/lib/db/clients.ts`,
  same shape as `updateClientReplyMode`.
- **Task 4** — `listSequencesForCase` and `updateSequenceFollowupDelays` in
  `src/lib/db/sequences.ts`. The latter is guarded to
  `.in('state', ['active', 'paused'])` and returns `null` on a
  stopped/completed sequence — nothing left to reschedule.
- **Task 5** — `formatFollowupCountdown` and `formatFollowupStatus` in
  `src/lib/format.ts`, for the case-page status line Task 10 will render
  (`"1/3 follow-ups sent · next in 3d"`).

- **Task 6** — `src/lib/pipeline/followup.ts` rewritten: `FOLLOWUP_DELAYS_SECONDS`/
  `MAX_FOLLOWUP_STEP` module constants deleted. `scheduleFirstFollowup` now
  loads the client via `getClientById` and snapshots
  `client.followup_delays_days` (falling back to
  `DEFAULT_FOLLOWUP_DELAYS_DAYS` on a null lookup) onto the new `sequences`
  row; `runFollowupStep` computes `maxStep = sequence.followup_delays_days.length`
  fresh on every invocation and indexes into that array instead of the old
  constant. New guard: `input.step > maxStep` short-circuits to `skipped`
  with no send — the fix that makes shrinking an active sequence's array
  safe when a stale QStash message for a since-deleted step still fires.
  Every `advanceSequence` call on a step that schedules a next fire now
  passes a real `nextActionAt` (`Date.now() + delaySeconds * 1000`) instead
  of the always-`null` placeholder, powering Task 10's countdown line.
  `collision-notify.ts`'s comment updated to match (no behavior change
  there). `followup.test.ts` fully rewritten per the plan — 19 tests,
  including a shrink-mid-flight skip case and a grow-mid-flight continue
  case.
- **Task 7** — `src/app/api/pipeline/followup/route.ts`: the webhook's
  `bodySchema` step bound moved from the deleted `MAX_FOLLOWUP_STEP` (3) to
  the shared `MAX_FOLLOWUP_STEPS` (10) — a payload sanity ceiling only; the
  authoritative last-step check now lives inside `runFollowupStep` against
  that sequence's own array.
- **Task 8** — `src/components/followup-delays-editor.tsx` (new): the one
  `FollowupDelaysEditor` component both UIs below share — controlled
  add/remove/edit rows bounded by the Task 2 schema, no save logic of its
  own. Rows use a monotonic generated key (never array index), so removing
  a middle row can't cause React to reuse a later row's `<input>` for an
  earlier value.
- **Task 9** — `/settings` gains a "Follow-up cadence" section: new
  `updateFollowupCadence` Server Action (client-role only, same
  `AppError('FORBIDDEN', ...)` shape as `updateReplyMode`) and
  `FollowupCadenceSection` (save-on-click with a Reset-if-dirty affordance,
  remounting the editor via a `key` bump so its row keys reseed). Wired
  into `page.tsx` right after the existing Reply mode section. Deliberately
  does **not** bulk-sync onto existing `sequences` rows, unlike `reply_mode`
  — a client's default change should never silently reschedule an
  in-flight contact.
- **Task 10** — `/cases/[id]` gains a per-lead override: new
  `updateLeadFollowupDelays` Server Action (same auth shape as `stopLead`
  — both roles, RLS-scoped read + `client_id` re-check) and
  `LeadFollowupControl` (status line + pencil-icon inline editor, using the
  Task 5 formatters — `"1/3 follow-ups sent · next in 3d"`). `page.tsx`
  now also fetches `listSequencesForCase` and renders the control only for
  a lead with an active/paused sequence — nothing shows for a
  parked/no-sequence contact. The `leads.map` callback was converted from
  an implicit-return arrow to a block body so `const sequence = ...` could
  be looked up once and narrowed by a plain `{sequence ? ... : null}`
  check, avoiding three repeated non-null assertions.

**Regression caught and fixed along the way:** `write.test.ts` broke
because `runWriteForCase` calls the real (unmocked) `scheduleFirstFollowup`,
which now calls `getClientById` — not part of that test's mock set before
this change. Added `vi.mock('@/lib/db/clients', ...)` there with a
`followup_delays_days: [3, 7, 14]` default so every existing timing
assertion (3-day first follow-up) stayed unchanged.

Verified: `pnpm typecheck && pnpm exec vitest run && pnpm lint` all clean —
**185 files / 1945 tests passing** (was 180/1881 before this feature
started — +5 files: `followup-limits.test.ts`, `format.test.ts`,
`followup-cadence-actions.test.ts` new, plus new describe blocks in
`clients.test.ts`/`sequences.test.ts`/`actions.test.ts`; +64 tests total),
0 type errors, 0 new lint errors (same 7 pre-existing unrelated warnings).
Committed as 11 task-scoped commits and pushed to `origin/master`
(`3ca1e14`..`d0ef54e`) once the user asked to push. Manual verification
(Tasks 9 Step 9 and 10 Step 10 in the plan — exercising `/settings` and a
case page's contact cards in `pnpm dev`) was not run in this session, per
this codebase's convention of leaving `.tsx` component behavior to manual
QA (no jsdom/testing-library setup).

**Follow-up UI fix, same day:** a client testing `/settings` entered a
non-ascending cadence (`[14, 7, 5]`) and asked whether that was valid —
it is, by design (§4: each element is a step-to-step gap, not a
cumulative day offset), but the UI gave no way to see the actual send
days, making a mis-ordered cadence indistinguishable from a typo.
`src/components/followup-delays-editor.tsx` now computes a running
`cumulativeSendDays` total and renders `· sends day N` next to each row
(e.g. `[14, 7, 5]` shows day 14, day 21, day 26) — shared by both
`/settings` and the per-lead case-page editor with no caller changes
needed, since it's derived purely from the existing `delaysDays` prop.
No test file (this component has none, per the no-`.tsx`-tests
convention); verified with `pnpm typecheck && pnpm lint && pnpm exec
vitest run` — still clean, 185/1945.

---

## Dashboard i18n (English / Turkish) — Tasks 1–18 of 18 DONE

**Design:** `docs/superpowers/specs/2026-08-05-dashboard-i18n-design.md`.
**Plan:** `docs/superpowers/plans/2026-08-05-dashboard-i18n.md`.

Per-user dashboard language (`en`/`tr`), with an operator-set per-client
default that unset client users inherit. `next-intl` wired in no-URL-routing
mode — locale resolved server-side per request from `app_users.locale` →
`clients.default_locale` (client role) → `'en'` (operator role), or from
`Accept-Language` pre-login. No cookies, no `/en/...` prefix.

- [x] **Task 1** — Migration `0029_locale_preferences.sql` (`app_locale`
  enum, `clients.default_locale` not-null default `'en'`,
  `app_users.locale` nullable override); `src/types/i18n.ts`
  (`SUPPORTED_LOCALES`, `AppLocale`); hand-edited `database.ts` to match
  (no live DB to regenerate from). Fixed a knock-on typecheck break in
  `can-manage-client.test.ts`'s `AppUser` fixtures (now-required `locale`
  field) that the plan hadn't anticipated.
- [x] **Task 2** — `src/lib/validation/locale.ts`: `localeSchema =
  z.enum(SUPPORTED_LOCALES)`.
- [x] **Task 3** — `src/lib/i18n/resolve-locale.ts`: `resolveLocale()`,
  `cache()`-wrapped, single source of truth for the current request's
  locale.
- [x] **Task 4** — Added `next-intl` dependency (needed enabling
  `@parcel/watcher`/`@swc/core` builds in `pnpm-workspace.yaml`'s
  `allowBuilds`, previously left as placeholder strings). `src/messages/{en,tr}.json`
  (`common` namespace) + `messages.test.ts` key-parity test.
  `src/i18n/request.ts` + `next.config.ts` wrapped with
  `createNextIntlPlugin`.
- [x] **Task 5** — Root layout (`src/app/layout.tsx`) made async,
  `<html lang>` now dynamic, body wrapped in `NextIntlClientProvider`.
- [x] **Task 6** — `/settings` language switcher: `updateUserLocale` (db),
  `updateMyLocale` Server Action (no role gate), `LanguageSection`, wired
  into `page.tsx`.
- [x] **Task 7** — `/clients/[id]` operator-only default-language control:
  `updateClientDefaultLocale` (db + Server Action, `{ok}`-shaped result
  matching `mailreach-actions.ts`), `DefaultLocaleSelect`.
- [x] **Task 8** — Shell/nav namespace: `nav.tsx`, `app-shell.tsx` (sign-out
  button), `theme-toggle.tsx` (added a `common.toggleTheme` key the plan
  flagged as a possible gap — it was real).
- [x] **Task 9** — Auth namespace: `/login`, `/set-password` +
  `set-password-form.tsx`.
- [x] **Task 10** — Full `settings` namespace for every remaining file in
  the directory (`connect-buttons.tsx`, `connect-crm-buttons.tsx` —
  converted to async Server Components to call `getTranslations`;
  `connect-smtp-dialog.tsx`'s multi-stage error-message builder threaded
  through `t`; `connection-card.tsx`, `error.tsx`,
  `followup-cadence-section.tsx`, `mailbox-controls.tsx`,
  `mailbox-delete-control.tsx`, `mailbox-row.tsx` — incidentally fixed a
  pre-existing bug where a caught network error rendered the literal
  string `"network"` to the user instead of a real message,
  `mailreach-controls.tsx`, `pipeline-picker.tsx`, `page.tsx`'s remaining
  strings). `loading.tsx` and `mailboxes-webmcp-tools.tsx` confirmed to
  own no literal strings and explicitly skipped.
- [x] **Task 11** — Clients namespace: `error.tsx`/`not-found.tsx` (both
  `/clients` and `/clients/[id]`), `new-client-form.tsx`,
  `invite-user-dialog.tsx`, `remove-user-dialog.tsx` (rich-text
  `t.rich(...)` for the "type X to confirm" bold span, same pattern used
  again in `delete-client-dialog.tsx`), `clients/page.tsx`, and every
  remaining `clients/[id]/` file: `client-lifecycle-actions.tsx`,
  `delete-client-dialog.tsx`, `edit-domain-dialog.tsx`,
  `knowledge-file-upload.tsx`, `knowledge-rescrape-all-button.tsx`,
  `knowledge-sitemap-picker.tsx`, `knowledge-source-actions.tsx`,
  `knowledge-sources-list.tsx` (converted to an async Server Component),
  `logo-upload.tsx`, `logs-feed.tsx`, `mailreach-toggle.tsx`,
  `rename-client-dialog.tsx`, `resources-section.tsx`,
  `warmup-mailbox-row.tsx`, `warmup-profile-select.tsx` (reuses
  `warmupMailboxRow.warmupOption.*` keys — same three profile labels),
  `warmup-tab.tsx`, and `page.tsx`'s remaining header/tab/log copy.
  `clients-webmcp-tools.tsx` and `knowledge-realtime-refresher.tsx`
  confirmed to own no literal strings and explicitly skipped.
- [x] **Task 12** — Campaigns namespace: `error.tsx`,
  `new-campaign-form.tsx` (the large ICP form — seniority/contact-email-
  status option labels moved into keyed lookup tables), `campaign-row-
  actions.tsx`, `delete-campaign-dialog.tsx`, `page.tsx`. `loading.tsx`
  and `campaigns-webmcp-tools.tsx` confirmed to own no literal strings.
- [x] **Task 13** — Cases namespace: `error.tsx`, `not-found.tsx`,
  `stop-lead-button.tsx` (per the plan's fully-worked example),
  `crm-link-badge.tsx`, `lead-followup-control.tsx`, `mail-tab.tsx`,
  `compose-form.tsx` and `notes-panel.tsx` (the plan's flagged largest
  files — every validation/error string extracted, not just the happy
  path), and `page.tsx`'s header/contacts/tabs/activity-feed copy.
  `loading.tsx` confirmed to own no literal strings.
- [x] **Task 14** — CRM namespace: `crm/page.tsx`, `error.tsx`. Shared
  `case-row.tsx` (its only caller) converted to an async Server Component
  for `getTranslations` — translated its "No contacts" fallback.
  `filter-chips.tsx` confirmed fully prop-driven, no own strings.
- [x] **Task 15** — Inbox namespace: `page.tsx`, `error.tsx`, `draft-row.tsx`
  (subject/body editor, attachment editor, redesign-with-AI panel, every
  toast), `knowledge-request-row.tsx` (including its declarative-WebMCP
  `tooldescription`/`toolparamdescription` attributes, per the precedent
  set in Task 11's `new-client-form.tsx`). `loading.tsx` confirmed to own
  no literal strings.
- [x] **Task 16** — Knowledge namespace: `page.tsx`, `error.tsx`,
  `knowledge-tabs.tsx`, `resources/page.tsx`, `resources/error.tsx`,
  `sources/page.tsx`, `sources/error.tsx`, `sources/sources-list.tsx`
  (table headers, source-type labels, delete confirm/toast — added a
  `sources.networkError` key the plan's key list hadn't spelled out).
  Every `loading.tsx` (3) confirmed to own no literal strings.
- [x] **Task 17** — Mail namespace: `page.tsx`, `error.tsx`, matching the
  plan's fully-worked example almost verbatim. `loading.tsx` confirmed to
  own no literal strings.
- [x] **Task 18** — Analytics namespace: `page.tsx`, `error.tsx`,
  `analytics-view.tsx` (every section title, all 6+4 stat-tile
  label/hint pairs, trend/campaigns/mailboxes/activity table headers),
  `filters.tsx`, `sparkline-chart.tsx` (converted to an async Server
  Component for `getTranslations`). `stat-tile.tsx` confirmed
  fully prop-driven; `realtime-refresher.tsx` confirmed to render nothing
  and own no strings.

Several shared-lib-driven labels were deliberately left untranslated and
flagged in code comments rather than fixed, per the plan's own precedent
(§Task 14's `CASE_STATUS` note): `formatRelative`/`formatFollowupStatus`/
`humanizeEnum` (`@/lib/format`), `CASE_STATUS`/`CLIENT_STATUS`/
`CAMPAIGN_STATUS`/`MAILBOX_HEALTH`/`KNOWLEDGE_SOURCE_STATUS`/
`LOG_SOURCE_META` (`@/lib/ui/status`, `@/lib/ui/log`), and shared
components (`FollowupDelaysEditor`, `ResourceUpload`/`ResourceList`,
`EmailMessage`, `KnowledgeItem`) — none are in these tasks' file lists,
and fixing them is out of scope here.

Executed inline in the main session per user instruction (no worktree, no
per-task git commits — this repo's `git add`+`commit` steps in the plan
were skipped throughout the whole feature and squashed into one commit at
the end instead, per a later explicit "push all"). Verified after every
task: `pnpm typecheck && pnpm vitest run` clean throughout, **190 files /
1969 tests passing** (unchanged since Task 13 — Tasks 14-18 were pure
string-extraction, same as 11-13, adding no new testable logic or test
files). `pnpm build` confirmed green after Tasks 5, 10, 11, 12, 13, and
again after 18 (full final build, all ~53 routes compiled clean,
including the two new async Server Components — `case-row.tsx`,
`sparkline-chart.tsx`). Manual `pnpm dev` verification (every task's
"Manually verify" step) not run in this session, per this codebase's
convention of leaving `.tsx`/browser behavior to manual QA.

**Feature complete: all 18 tasks done, committed and pushed to
`origin/master`** — commit `e2b2341` ("feat(i18n): dashboard
English/Turkish translation (all 18 tasks)"), 108 files changed
(+4072/−917). Every static UI string across the `(app)` route group, the
shell/nav, and `/login`+`/set-password` is now extracted to
`messages/{en,tr}.json` and rendered through `t(...)`, with real
(non-machine-placeholder) Turkish throughout. Remaining before this is
fully signed off: the plan's manual `pnpm dev` walk-through of every
route in both languages (§Task 18 Step 5) as a final regression pass —
not yet done, per this codebase's convention of leaving that to manual
QA rather than this session.

## 2026-08-06 — Apollo audience/filter test script (private K-12 school ICP)

Added `scripts/test-apollo-schools-search.ts` (`pnpm test:apollo-schools`),
a diagnostic-only script that runs a real Apollo People Search for the
private K-12 school ICP the user supplied (21 `person_titles[]`, 33
organization keywords, 22 client-side exclude keywords) and reports what
comes back — audience-quality/filter inspection only, no Supabase writes,
no `bulk_match`/enrichment call (so no Apollo reveal credits spent). Reuses
the real production building blocks unmodified: `buildPeopleSearchParams`,
`searchPeople`, `matchesExcludedKeywords`, `apolloIcpSchema` from
`src/lib/apollo/`.

**Bug found in the real campaign system, not just this test:** live curl
testing against the account's Apollo key proved `q_keywords` is a single
free-text field, not an OR-list — `build-search-params.ts`'s
`icp.keywords.join(' ')` silently breaks any ICP with more than one
organization keyword (a 2-phrase join already returned `total_entries: 0`;
this ICP's full 33-phrase join returned HTTP 422 `{"error":"Value too
long"}`). **Any saved campaign with multiple organization keywords is
likely returning zero or erroring today** — `runFirstPass`/`runSecondPass`
in `src/lib/pipeline/discover.ts` call `buildPeopleSearchParams` the same
way. Not fixed yet (wasn't asked); the test script works around it by
calling Apollo once per organization keyword and de-duplicating by
`apolloId`, which is also how it surfaces a per-keyword total_entries
breakdown. `src/lib/apollo/build-search-params.ts` should be revisited
(loop per keyword, or drop multi-keyword q_keywords support) before this
ICP — or any multi-keyword ICP — is run through the real pipeline.

Real run (`--pages=1 --per-page=25`, 33 Apollo calls): 801 raw candidates,
785 unique after de-dup, 780 kept / 5 excluded (matched `university` or
`college`). Output written to `scripts/.output/` (gitignored — contains
real prospect names/titles/orgs pulled from Apollo). Verified: `pnpm
typecheck`, `pnpm eslint scripts/test-apollo-schools-search.ts`, `pnpm
vitest run src/lib/apollo` (59 tests, unchanged — no production code
touched) all clean.

### Follow-up same day: fixed the multi-keyword bug in the real pipeline

User asked "how can we fix this?" — fixed `src/lib/pipeline/discover.ts`
(`runFirstPass`/`runSecondPass`), via TDD (`superpowers:test-driven-development`).
Root cause is at the call-site, not in `build-search-params.ts` itself
(that function was always correct for a *single* keyword) — the pipeline
was just handing it an ICP with every keyword joined. Fix: both passes now
iterate `(keyword, page)` pairs instead of just `page` — new
`searchTargets(icp)` returns `icp.keywords` (or `[null]` meaning "no
keyword filter" when empty, preserving today's exact behavior for every
existing single/no-keyword campaign) and `icpForTarget(icp, target)` builds
the one-keyword ICP for each call. Cycles to the next keyword when the
current one's page comes back empty; stops the instant quota is met, same
as before. `call` (not `page`) is the real budget counter, so total Apollo
calls per pass is still capped at `MAX_SEARCH_PAGES` — no change to
runtime/timeout risk for the QStash-invoked `/api/pipeline/discover` route.
Pass 2's existing page-reset-on-narrow logic is preserved unchanged, now
also resetting on keyword-advance.

TDD: 3 new tests added to `discover.test.ts` under `describe('runDiscoveryForCampaign
— multi-keyword organization search')` — RED confirmed first (2 of 3 failed
for the right reason: joined `q_keywords` string, and a missing 4th mock
call; the 3rd trivially passed both before/after as a quota-short-circuit
regression guard, kept anyway). GREEN after the fix. Full suite: **190
files / 1972 tests passing** (1969 prior + 3 new), `pnpm typecheck` and
`pnpm eslint` both clean. No live Supabase-backed pipeline run performed
(would create real fake leads in the DB and wasn't asked for) — correctness
relies on the mocked-Apollo unit tests plus the already-proven live
single-keyword Apollo call semantics from [[test-apollo-schools-search]]
above.

files / 1972 tests passing** (1969 prior + 3 new), `pnpm typecheck` and
`pnpm eslint` both clean. No live Supabase-backed pipeline run performed
(would create real fake leads in the DB and wasn't asked for) — correctness
relies on the mocked-Apollo unit tests plus the already-proven live
single-keyword Apollo call semantics from the diagnostic script above.

Not committed yet (`.claude/roadmap.md`, `.gitignore`, `package.json`,
`src/lib/pipeline/discover.ts`, `src/lib/pipeline/discover.test.ts`
modified; `scripts/test-apollo-schools-search.ts` new/untracked) — waiting
on user to confirm before committing/pushing to `master`.

## Lazy-start warmup ramp (2026-08-06)

User reported: connecting a mailbox to Mailreach warmup starts the 14-day
send gate, but the daily-cap ramp was climbing every day anyway, even
though nothing had actually been sent yet. Root cause: `warmup_started_at`
(the ramp clock, `src/lib/mailbox/warmup.ts`) was stamped at mailbox
*connect* time — completely independent of `mailreach_started_at` (the
14-day outreach gate) — so the ramp advanced through the whole idle/gated
period.

Spec: [[2026-08-06-lazy-start-warmup-ramp-design]]
(`docs/superpowers/specs/2026-08-06-lazy-start-warmup-ramp-design.md`).
Plan: `docs/superpowers/plans/2026-08-06-lazy-start-warmup-ramp.md`, 7
tasks, executed via subagent-driven-development for Tasks 1-4 (each with
an independent implementer + reviewer, all reviews clean — one deferred
Minor on Task 4's report-hygiene, non-blocking) then inline for Tasks
5-7 at the user's request ("skip commits, inline execution").

Shipped:
- Migration `0030`: `claim_mailbox_send`/`claim_mailbox_send_uncapped` now
  stamp `warmup_started_at = coalesce(warmup_started_at, now())` on a
  mailbox's first successful send (any purpose), guarded to
  `warmup_profile <> 'none'`. One-time backfill resets mailboxes that are
  ramping but have never sent back to `null`.
- `src/lib/mailbox/warmup.ts`: `computeRampState`/`effectiveDailyCap`/
  `getMailboxWarmthStatus` now treat "ramping profile, never sent" as day
  one (new `WarmthStatus` variant `not_started`), distinct from `'none'`
  (`not_ramping`). `warmupInsertFields` no longer stamps a timestamp at
  connect time; the old immediate-stamp behavior moved to a new
  `warmupRestartFields`, used only by the explicit profile-change route.
- The three connect routes (`google/callback`, `outlook/callback`,
  `smtp/connect`) leave `warmup_started_at` null on insert.
  `POST /api/mailboxes/[id]/warmup` now calls `warmupRestartFields` —
  unchanged immediate-restart behavior for an explicit operator profile
  change.
- Settings `mailbox-row.tsx` and Clients-page `warmup-mailbox-row.tsx` both
  render the new `not_started` status via an exhaustive switch
  (`assertNever` default) instead of the old two-way ternary that would
  have silently shown no suffix for it. New en/tr copy in
  `src/messages/{en,tr}.json`.

Verification: `pnpm typecheck` clean, `pnpm test` → **190 files / 1980
tests passing**. Both message JSON files parse. Manual in-browser check
(Task 7's Step 2) not yet performed.

Not committed yet for Tasks 5-7 (`src/app/(app)/settings/mailbox-row.tsx`,
`src/app/(app)/clients/[id]/warmup-mailbox-row.tsx`, `src/messages/en.json`,
`src/messages/tr.json`, this roadmap entry) — user asked to skip commits;
Tasks 1-4 are already committed (`a1dbfd4`..`58f343a`).

## Campaign settings edit + client read-only view (2026-08-06)

Operators previously couldn't change a campaign's name, value prop, booking
link, daily target, or ICP filters after creation — only status
(stop/resume/delete) was editable. Clients hitting `/campaigns` were
redirected to `/crm` with no visibility into their own campaigns at all.

Spec: [[2026-08-06-campaign-settings-edit-design]]
(`docs/superpowers/specs/2026-08-06-campaign-settings-edit-design.md`).
Plan: `docs/superpowers/plans/2026-08-06-campaign-settings-edit.md`, 8
tasks, executed inline at the user's request ("implement, skip commits,
inline execution").

Shipped:
- Shared `campaignSettingsSchema` (`src/lib/apollo/campaign-settings-schema.ts`)
  used by both `POST /api/campaigns` (create) and the new
  `PATCH /api/campaigns/[campaignId]` (edit) — replaces the duplicated
  10-field Zod object that used to live only in the create route.
- `updateCampaignSettings` DB helper (`src/lib/db/campaigns.ts`), same
  shape as the existing `updateCampaignStatus`.
- Operator-only edit page at `/campaigns/[campaignId]/edit`
  (`edit-campaign-form.tsx` + `page.tsx`), reachable via a new Edit action
  on every campaign row regardless of status (active/paused/archived).
  Redirects non-operators to `/crm`; `notFound()` on an unknown campaign
  id; the row's `icp` Json column is reparsed through `apolloIcpSchema`
  to recover typed defaults for the form.
- `CampaignSettingsFields` + `Field` extracted from `new-campaign-form.tsx`
  into `campaign-settings-fields.tsx`, and the FormData-parsing helpers
  (`splitCsv`/`getAllStrings`) into `campaign-form-utils.ts` — both reused
  by the new `EditCampaignForm`, avoiding a duplicated ~180-line ICP
  fieldset. `NewCampaignForm` refactored to consume the same pieces with
  no behavior change.
- `CampaignRowActions` gained an "Edit" `<Link>` to the new route,
  alongside the existing Stop/Resume/Delete buttons.
- `/campaigns` now branches on `appUser.role`: operators keep the full
  admin-client view (new-campaign form + full action set); clients get a
  new RLS-scoped read-only view — `createServerClient()` instead of the
  admin client, so the existing `campaigns_select` policy
  (`is_operator() or client_id = current_client_id()`,
  `supabase/migrations/0002_rls_policies.sql`) does the filtering for
  free. New `CampaignCard` component (extracted from the inline `<li>` in
  `page.tsx`) renders identically for both branches but only receives
  `actions` on the operator branch.
- New i18n keys in both `src/messages/en.json` and `src/messages/tr.json`:
  `rowActions.editTrigger`, the `editCampaignForm` group, and
  `clientPageDescription`/`noCampaignsDescriptionClient` for the client
  branch's page copy.

Verification: `pnpm typecheck` clean, `pnpm lint` clean (0 errors, 7
pre-existing unrelated warnings), `pnpm test` → **191 files / 1992 tests
passing** (28 new: 6 in `campaign-settings-schema.test.ts`, 2 in
`campaigns.test.ts`, 4 in `route.test.ts`'s new `PATCH` block — the rest
of the increase is pre-existing tests unaffected by this change). Both
message JSON files parse.

Not committed — user asked to skip commits for this feature (`IMPLEMENT,
SKIP COMMITS, inline execution`).

---

## 2026-08-06 — Uniforms Fashion: 8 campaigns created in DB

Created all 8 campaigns from `docs/campaigns/uniforms-fashion-icp.md` for
client Uniforms Fashion (`d99edf8f-b185-47b2-9615-1f6e43853001`, previously
0 campaigns) via a one-off script (`insertCampaign` from
`src/lib/db/campaigns.ts`, ICP validated through the real
`apolloIcpSchema`) — same DB layer the `/api/campaigns` POST route uses,
just invoked directly with the service-role key instead of through the UI.
Campaign #7 (Industrial Sector) stays cancelled, per the doc; 8 rows total
(numbered 1–6, 8, 9).

Per-run overrides on top of the doc's suggested settings, both from an
explicit operator request this session:
- **Global** — `organizationLocations: []` on every campaign (no country
  filter), not the doc's suggested `['united states']`.
- **40+ employees** — `employeeRangeMin: 40`, `employeeRangeMax: 1_000_000`.
  Apollo only applies `organization_num_employees_ranges[]` when both
  bounds are set (`src/lib/apollo/build-search-params.ts:24`), so the high
  ceiling stands in for an open floor — same convention already used in
  `scripts/test-apollo-campaigns-search.ts`.

Everything else matches the doc/New-Campaign-form defaults: `daily_target:
15`/campaign, `contactEmailStatuses: ['verified']`, `personSeniorities:
[]`, `reply_mode: 'human_approve'` (client's current setting), `booking_link:
null` (operator hasn't sourced one yet — asked via AskUserQuestion,
answered "leave blank for now"; fill in later per campaign via the edit
UI). All 8 created as `status: 'active'` (the schema default and the only
state the real creation form ever produces) — **this means the next
discover-fanout cron run starts spending real Apollo/Emailable credits
immediately**, which is exactly what the doc flagged as the outward-facing,
cost-triggering step still pending. Creating them was that explicit
go-ahead.

Verified post-insert by querying the 8 rows back from `campaigns` directly
(status/daily_target/icp.organizationLocations/icp.employeeRange all
correct). The one-off insert script was deleted after running — it was
hardcoded to this one client's 8-campaign spec, not reusable infra.

---

## 2026-08-07 — Client contact signature (phone + address in outbound email)

Uniforms Fashion asked for their phone number in the first outbound email;
address was folded into the same request during design. Brainstormed →
spec (`docs/superpowers/specs/2026-08-07-client-contact-signature-design.md`)
→ plan (`docs/superpowers/plans/2026-08-07-client-contact-signature.md`) →
implemented inline, all 8 tasks, TDD per task. Pushed to `master` at
`effab26`.

- `clients` gained 4 nullable columns: `phone`, `address`, `signature_name`,
  `signature_title` (`supabase/migrations/0031_client_contact_signature.sql`).
  Per-client, not per-campaign — one number/address for the whole company,
  applies to all of a client's campaigns automatically (Uniforms Fashion has
  8).
- New pure `appendSignatureBlock` (`src/lib/pipeline/signature.ts`) builds
  the block deterministically and is called from `write.ts` (first-touch)
  and `followup.ts` (every nudge) right after the LLM returns the body,
  before it's claimed/sent — never left to the model's discretion, unlike
  `bookingLink`'s "optional CTA" treatment. Gated entirely on `phone` being
  set: address/name/title alone never trigger a signature (explicit
  requirement, confirmed even after address was added).
- New `phoneSchema` (`src/lib/validation/phone.ts`, lenient international
  format) plus an inline `nullableTextSchema` helper in the clients PATCH
  route for address/signatureName/signatureTitle — same
  trim/refine/empty-clears-to-null convention as the existing `domainSchema`.
- `updateClientSignature` (`src/lib/db/clients.ts`) is one combined update
  for all 4 fields; `PATCH /api/clients/[clientId]` accepts them and logs
  `client.signature_changed`.
- New `EditSignatureDialog` on the client detail page (modeled on
  `EditDomainDialog`), i18n keys added to both `en.json`/`tr.json`.
- Known limitation, documented not solved: `redesign.ts` (the `/inbox`
  AI-rewrite-draft action) treats the current body — including any appended
  signature — as free text the model may reword. Out of scope; targets
  automated sends/initial drafts, not manual AI rewrites.
- Operator follow-up (not code): open Uniforms Fashion's client page → Edit
  signature → fill in phone (+ optionally name/title/address) once; applies
  to all 8 existing campaigns immediately.

Full suite green (2033/2033), typecheck/lint clean before pushing.

---

## 2026-08-07 — INCIDENT: all QStash-driven pipeline crons silently stopped since 08-04

Operator reported campaigns "active" but zero activity at 06:00 UTC (the
discover-fanout cron's own scheduled time). Root-caused via systematic
debugging (evidence, not guessing):

- Queried `events` directly (Supabase REST, service role): the last
  `pipeline.*` event of ANY kind (`discover_fanout`, `research_fanout`,
  `write_fanout`, `stuck_sweep`) is `pipeline.stuck_sweep.completed` at
  **2026-08-04T10:53:00Z**. Nothing since — not even `stuck_sweep`
  (`*/15 * * * *`) or `inbound/poll-fanout` (`*/5 * * * *`), so this isn't
  one broken pipeline stage, it's every QStash cadence stopping at once.
- Reproduced directly: called `client.schedules.list()` with the exact
  client construction `src/lib/qstash/client.ts` uses (same `QSTASH_TOKEN`)
  → fails with `user (ed72019a-...) not found in this region
  (eu-central-1)`. Same error via raw REST to
  `https://qstash.upstash.io/v2/schedules`.
- Confirmed via Upstash docs
  ([multi-region](https://upstash.com/docs/qstash/howto/multi-region)):
  QStash now runs two fully independent regions (US/EU) with separate
  tokens/resources. Our account's schedules/token are apparently stranded
  in a region the default endpoint no longer routes to — almost certainly
  an Upstash-side regional split that landed right around 08-04, matching
  the outage start to the minute-level granularity `stuck_sweep` gives us.
- **Not a code bug** — nothing in this repo caused it, and nothing here
  can fix it. Operator action needed: open the Upstash Console → QStash
  tab, find which region the existing schedules/messages actually live in,
  and either point `QSTASH_TOKEN`/`QSTASH_CURRENT_SIGNING_KEY`/
  `QSTASH_NEXT_SIGNING_KEY` (local `.env.local` + prod/Vercel env) at that
  region's token, or recreate the 8 `scripts/schedule-*-cron.ts` schedules
  fresh in whichever region is now canonical. Once `QSTASH_TOKEN` is fixed,
  re-run all 8 `scripts/schedule-*-cron.ts` scripts to be safe (schedule
  creation is idempotent-ish per script but doesn't dedupe existing
  schedule IDs) and verify with `pipeline.discover_fanout.completed`
  appearing in `events` after the next 06:00 UTC run.
- No code changes made this session; diagnostic-only (temp script created
  and deleted, no other files touched besides this roadmap entry).

**Resolution (same day, continued):** the region theory above was a red
herring — operator confirmed Vercel prod's `QSTASH_TOKEN` +
`QSTASH_CURRENT_SIGNING_KEY`/`QSTASH_NEXT_SIGNING_KEY` are exactly what's
in `.env.local`. Proved the credentials/region/signature path is fully
healthy right now by publishing one live probe message directly to
`https://www.shengulai.com/api/cron/hello` with the pinned `us-east-1`
client — QStash delivered it, the route verified the signature, and
`cron.hello` landed in `events` 2.4s later. So the account was never
broken; **the 9 recurring schedules themselves were simply gone** (not
paused, not erroring — absent from `schedules.list()` entirely, cause
unknown — possibly deleted during whatever `.env.local` edit happened
around 08-03 20:55 local, but unconfirmed and not worth further
archaeology once the fix was in hand).

Fix: recreated all 9 schedules directly against `https://www.shengulai.com`
(NOT via `env.APP_URL`, which is `http://localhost:3000` in `.env.local` —
running `scripts/schedule-*-cron.ts` as-is locally would have silently
registered schedules pointing at localhost). Confirmed via operator
sign-off first, since `discover-fanout`/`write-fanout` resuming means real
Apollo/Emailable spend and real outbound sends resume immediately on
schedule. All 9 verified live via `schedules.list()` afterward — unpaused,
correct cron, sane `nextScheduleTime` for each:
- `discover-fanout` `0 6 * * *` → next 2026-08-08T06:00Z (today's window
  had already passed)
- `research-fanout` `0 7 * * *` → next 2026-08-07T07:00Z
- `write-fanout` `0 8 * * *` → next 2026-08-07T08:00Z
- `inbound-poll-fanout` `*/5 * * * *`, `stuck-sweep` `*/15 * * * *`,
  `mailbox-health`/`mailreach-sync` `0 */6 * * *`, `mailbox-reset`
  `0 0 * * *`, `log-retention` `20 3 * * *` — all next-fire times sane.

Also shipped a real (kept) code hardening from the investigation:
`src/lib/qstash/client.ts` now pins `baseUrl` to
`https://qstash-us-east-1.upstash.io` explicitly (new optional `QSTASH_URL`
env var in `src/lib/env.ts`, defaults to us-east-1) instead of the
ambiguous default `https://qstash.upstash.io` endpoint — this app runs on
AWS us-east-1 per operator confirmation, and QStash's regions are fully
independent with no shared state, so relying on the ambiguous default is a
real footgun even though it turned out not to be this incident's cause.
28/28 qstash+env tests still green.

Operator follow-up: watch for `pipeline.stuck_sweep.completed` /
`pipeline.discover_fanout.completed` events to keep landing in `events`
going forward as a canary that this doesn't silently regress again.

## 2026-08-07 — Per-client/per-campaign discovery scheduling (Tasks 1-7 of 12)

Implemented Tasks 1-7 of
`docs/superpowers/plans/2026-08-07-campaign-scheduling.md` inline (no
subagents, no commits — left for the user to review/commit). Tasks 8-12
(edit-route recompute wiring, resume-route recompute, discover-fanout
scheduler tick rewrite, settings UI, campaign form UI, i18n) are **not**
done yet.

Shipped:
- `supabase/migrations/0032_campaign_scheduling.sql` — `clients.timezone` /
  `clients.default_discover_time`, `campaigns.discover_time` /
  `discover_timezone` / `next_discover_at`, backfill, partial index.
  Mirrored by hand into `src/types/database.ts` (no live Postgres to
  `gen types` from).
- `src/lib/validation/schedule.ts` — `timeOfDaySchema`, `timezoneSchema`,
  `isValidTimezone`.
- `src/lib/scheduling/next-run.ts` — `computeNextRunAt`, DST-aware, pure,
  Intl-based. **Fixed a real bug in the plan doc's own reference
  implementation**: the two-pass UTC-offset correction re-targeted the
  previous pass's candidate instead of holding the original desired wall
  clock fixed, which diverged (not converged) for any non-zero, non-DST
  offset (proved it with the Asia/Tokyo UTC+9 test — plan's code was off by
  a full day). Fixed by keeping `desiredMs` constant across both passes.
  Also fixed the plan's Tokyo test fixture, which coincided exactly with
  the DST-boundary "equal-instant rolls to tomorrow" case tested right next
  to it — self-contradictory as written; shifted `from` by 1h so it
  actually isolates the offset-conversion behavior it claims to test.
- `src/lib/db/clients.ts` — `updateClientSchedule`.
- `src/lib/db/campaigns.ts` — `listCampaignsDueForDiscovery`,
  `updateCampaignNextDiscoverAt`, `recomputeCampaignNextDiscoverAt`,
  `recomputeClientCampaignSchedules`. **Deviation from the plan**: kept
  `listActiveCampaigns` instead of deleting it — its only caller
  (`discover-fanout`) is rewritten in Task 10, which is out of scope here;
  deleting it now would have broken that still-live route.
- `src/lib/apollo/campaign-settings-schema.ts` — `discoverTime` /
  `discoverTimezone`, both nullable, default `null` (inherit).
- `src/app/api/campaigns/route.ts` (create) — computes and stores
  `next_discover_at` from the effective (override-or-client-default)
  time/timezone at creation time.

Minimal compile-safe touch outside the 1-7 scope: `CampaignSettingsPatch`
gaining two required fields broke `src/app/api/campaigns/[campaignId]/route.ts`
(the edit route, Task 8) at the type level. Rather than leave the build
red, passed `body.discoverTime`/`body.discoverTimezone` through into that
route's existing `updateCampaignSettings` call — the columns now save
correctly on edit, but `next_discover_at` is **not** recomputed there yet
(no call to `recomputeCampaignNextDiscoverAt`). That wiring, plus the
resume-route recompute and the scheduler-tick rewrite, are the first things
Task 8-10 need to do next.

Verified: `pnpm exec tsc --noEmit` clean, `pnpm exec eslint` clean on all
touched files, full suite `pnpm exec vitest run` — 196 files / 2069 tests
green.

Not done (Tasks 8-12): edit-route recompute-on-save, resume-route
recompute, `discover-fanout` scheduler tick + cron cadence changes for all
three pipeline stages, `/settings` schedule section UI, campaign
create/edit form fields, i18n keys. See the plan doc for the exact
remaining steps.

## 2026-08-07 — Per-client/per-campaign discovery scheduling (Tasks 8-14, feature complete)

Finished the rest of `docs/superpowers/plans/2026-08-07-campaign-scheduling.md`
(spec: `docs/superpowers/specs/2026-08-07-campaign-scheduling-design.md`),
inline, no subagents, no commits — same as the Tasks 1-7 pass above. The
feature is now fully implemented end to end; nothing left uncommitted from
the plan.

Shipped:
- **Task 8** — `PATCH /api/campaigns/[campaignId]` now recomputes
  `next_discover_at` unconditionally after every save
  (`recomputeCampaignNextDiscoverAt`), replacing the Tasks-1-7 stopgap that
  only stored the override columns without rescheduling. Handles an
  override changing, an override clearing back to `null` (reverts to the
  client's current default), and a no-op save (recomputes to the same
  instant) uniformly.
- **Task 9** — `POST /api/campaigns/[campaignId]/resume` recomputes from
  "now" after resuming, so a campaign paused for days doesn't fire on the
  very next scheduler tick from a stale pre-pause schedule.
- **Task 10** — `discover-fanout` rewritten from "fire every active
  campaign" to "fire every campaign whose `next_discover_at` is due"
  (`listCampaignsDueForDiscovery`), publish-then-advance per campaign
  (`recomputeCampaignNextDiscoverAt`), with three independently isolated
  failure modes in the response: `firedCampaignIds`, `failedCampaignIds`
  (publish failed — stays due, retried next tick), `staleScheduleCampaignIds`
  (published fine, recompute failed — NOT retried as a duplicate discover,
  caught by the next edit/settings-save instead). New test file (route had
  none before), 5 tests. Also deleted `listActiveCampaigns` from
  `lib/db/campaigns.ts` now that its only caller is gone — this was
  deferred from the Tasks-1-7 pass specifically because deleting it then
  would have broken this route before it was rewritten.
- **Task 11** — `scripts/schedule-discover-cron.ts` /
  `schedule-research-cron.ts` / `schedule-write-cron.ts` default cron
  changed `'0 6/7/8 * * *'` → `'*/5 * * * *'` for all three pipeline
  stages, comments updated to explain the new due-campaign /
  system-wide-poll semantics.
- **Task 12** — `/settings` client-facing schedule section:
  `schedule-actions.ts` (`updateSchedule` Server Action — auth-gates to
  `role === 'client'`, validates with `timezoneSchema`/`timeOfDaySchema`,
  calls `updateClientSchedule` then `recomputeClientCampaignSchedules`,
  logs `client.schedule_changed`, revalidates `/settings`) +
  `schedule-section.tsx` (timezone `<select>` from
  `Intl.supportedValuesOf('timeZone')`, `<input type="time">`, dirty-state
  save button matching `FollowupCadenceSection`'s exact pattern), wired
  into `page.tsx` right after the follow-up cadence section.
- **Task 13** — per-campaign run-time/timezone override fieldset in
  `campaign-settings-fields.tsx` (shared by create + edit forms), wired
  into both `new-campaign-form.tsx` and `edit-campaign-form.tsx`'s submit
  bodies (empty string → `null`, i.e. "inherit" — not "pin today's
  resolved value"), edit page loader passes `campaign.discover_time`/
  `discover_timezone` through as the new required props.
- i18n: `settings.schedule*` keys and `campaigns.newCampaignForm.discover*`
  keys added to both `en.json` and `tr.json` — no untranslated English left
  in `tr.json`.

Verified (Task 14): `pnpm exec tsc --noEmit` clean, `pnpm exec eslint .`
clean (only 7 pre-existing unrelated warnings in unrelated test files, 0
errors), full suite `pnpm exec vitest run` — **198 files / 2077 tests
green**.

Plan doc checkboxes for every non-commit step across all 14 tasks are now
checked. Nothing was committed by this pass either — still sitting in the
working tree for review/commit.

Operator follow-up before this is live in production: Rollout step 3 from
the spec — delete + recreate the `discover-fanout`/`research-fanout`/
`write-fanout` QStash schedules at their new `*/5 * * * *` cadence via the
updated `scripts/schedule-*-cron.ts` (these scripts only register once per
environment; the old `0 6/7/8 * * *` schedules registered previously do
not update themselves). Until that's done, the new code is live but the
old daily cadence keeps firing.

## 2026-08-07 — Campaign scheduling rollout + three production bugs found chasing "no activity"

User reported a campaign's scheduled discovery time passed with no
activity. Root-caused and fixed four issues in sequence, each surfaced by
fixing the one before it:

1. **QStash rollout step 3 (above) was never done.** Deleted the stale
   `discover-fanout` (`0 6 * * *`)/`research-fanout` (`0 7 * * *`)/
   `write-fanout` (`0 8 * * *`) schedules and re-registered all three at
   `*/5 * * * *` via `scripts/schedule-*-cron.ts`. Verified live: Okullar's
   10:45 Europe/Istanbul discovery fired within its first 5-minute tick.
2. **Apollo employee-count filter crash (`HTTP 422`).** Okullar's
   `icp.employeeRangeMax` was `10,000,000,000` — Apollo's backend is a
   signed 32-bit integer field, reproduced live: `"Value [...] is out of
   range for an integer"`. Fixed in `src/lib/apollo/build-search-params.ts`
   (open-ended `"min,"` / `",max"` ranges — a missing bound was silently
   dropping the whole filter instead of the "no upper bound" the UI copy
   already promised, confirmed live: `40,` → 12,254 matches, `,1000` →
   14,110 matches) and `src/lib/apollo/types.ts` /
   `campaign-settings-schema.ts` (`.max(2_147_483_647)` guard, `Apollo
   MAX_EMPLOYEE_COUNT` exported const). Data-fixed all 8 active campaigns'
   `employeeRangeMax` from round-number placeholders (1M/100M/1B/10B) to
   `null`. Commit `cf56f6a`. Tests: +5, 198/2082 green pre-existing suite.
3. **`leads.email_verification` column missing in production** (migration
   `0011_lead_email_verification.sql` was committed but never applied —
   same failure mode already documented once before in
   `0026_crm_tables_data_api_grants.sql`'s own comment, now confirmed to
   have recurred). Audited all 32 migrations' `ADD COLUMN`/`CREATE TABLE`/
   `ALTER TYPE ... ADD VALUE` statements against live production via
   PostgREST; found two real gaps: `leads.email_verification` (0011, the
   one breaking every discovery run) and `cases.collision_notified_at`
   (0016, unrelated feature, never triggered before now). Wrote
   `supabase/migrations/0033_reapply_missing_0011_0016.sql` (idempotent,
   `add column if not exists` / `add value if not exists`) — this agent has
   no DB credentials in this environment (no `DATABASE_URL`/psql/Supabase
   CLI, REST-only), so the user applied it manually via the Supabase SQL
   Editor. Verified: Okullar's next tick completed successfully — 1 lead
   found, 1 verified.
4. **Quota shortfall: `daily_target: 2` produced only 1 lead.** Root cause
   was by design, not a defect: `runDiscoveryForCampaign` splits quota into
   pass 1 (fresh companies, half the quota) and pass 2 (a company-scoped
   search restricted to exactly the companies pass 1 verified, hunting a
   *second* contact there) — when pass 2's target company has no second
   matching person, the run stopped short instead of falling back to more
   fresh companies. User confirmed via AskUserQuestion this should fall
   back. Added a third "top-up" pass in `src/lib/pipeline/discover.ts`
   (`runDiscoveryForCampaign`): reuses `runFirstPass` verbatim for whatever
   quota pass 2 left unfilled, deduped against both prior passes'
   companies (`verifiedCompanyCounts`/`domainBackedCompanyKeys`, already
   threaded through both passes) and apolloIds. New `DiscoverySummary.
   topUpCandidates` field. 3 new regression tests (fallback fires, fallback
   skipped when pass 2 already fills quota, top-up dedups against
   already-claimed companies) + 6 existing tests updated for the extra
   `searchPeople` call now expected when quota remains unfilled. Full
   suite: 198 files / 2085 tests green, `tsc`/`eslint` clean. Not yet
   committed.

Everything in this session was diagnosed by reproducing directly against
live production (Apollo, QStash, Supabase REST) rather than guessing from
code alone — every root cause above was confirmed with a real request/
response before being called the cause.

## 2026-08-07 — Fixed: company research agent's `search` tool always failing ("search failed")

A user-provided Gemini API trace for the B2B research agent
(`src/lib/research/agent.ts`) showed all three parallel `search` tool calls
returning the flattened `{"error": "search failed"}` (deliberate flattening
in `src/lib/research/tools.ts` so the model treats a bad search as routable
data — see comment there — which is why the model correctly retried with
new queries instead of aborting). Root-caused in
`src/lib/research/brightdata.ts`: `search()` was POSTing to a stale
`https://api.brightdata.com/serp/req` endpoint with a bespoke
`{ query, search_engine, parse }` body and no `zone` field at all, while
`scrape()` right below it correctly used
`https://api.brightdata.com/request` with `{ zone: BRIGHTDATA_SCRAPE_ZONE,
url, format, data_format }`. Confirmed against Bright Data's current SERP
API docs (`docs.brightdata.com/scraping-automation/serp-api`) that SERP
requests go through the *same* `/request` endpoint as Web Unlocker, just
with a different `zone` — and Bright Data bills/routes SERP and Web
Unlocker through **separate zones**, so reusing `BRIGHTDATA_SCRAPE_ZONE`
for SERP would still fail even with the right endpoint. This was a latent
bug present since `brightdata.ts` was first introduced (confirmed via `git
log -p`), not a regression — it had just never been exercised/reported
before this trace.

Fixed `search()` to hit `/request` with `zone: BRIGHTDATA_SERP_ZONE`, `url:
https://www.google.com/search?q=<query>&brd_json=1` (Bright Data's flag for
structured JSON SERP output matching the existing `serpResponseSchema`
shape), `format: 'raw'`. Added `BRIGHTDATA_SERP_ZONE` as a new required env
var (`src/lib/env.ts`, `.env.example`, `vitest.config.ts` stub,
`src/lib/env.test.ts` fixture) — **the user still needs to create a SERP
zone in their Bright Data dashboard and set the real value in `.env.local`
and production before this actually works end-to-end; I did not fabricate
a value for their live credentials file.** Renamed
`BRIGHTDATA_SERP_URL`/`BRIGHTDATA_UNLOCKER_URL` to a single
`BRIGHTDATA_REQUEST_URL` since both functions now hit the identical
endpoint. Added 2 regression tests to `brightdata.test.ts` asserting the
exact request body (`zone`/`url`/`format`) sent for both `search()` and
`scrape()`, specifically to catch a future zone/endpoint mix-up like this
one. Full suite: 198 files / 2090 tests green, `tsc`/`eslint` clean. Not
yet committed.

## 2026-08-07 — Discovery depth-first retry loop (all 3 tasks landed)

Design + plan: `docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md`,
`docs/superpowers/plans/2026-08-07-discovery-retry-loop.md`. Root cause
(investigated against production event logs): `daily_target` budgeted
Apollo search *attempts*, not delivered *active* leads, and the "find a
second contact" phase (pass 2) had returned 0 candidates in every one of
the 9 `pipeline.discover.completed` events ever logged, because it ANDed a
redundant free-text keyword filter onto an already-exact domain
restriction — so every campaign ended up with N companies, each with
exactly 1 lead, never 2.

1. **Task 1** — Added a regression test to `build-search-params.test.ts`
   confirming `buildPeopleSearchParams` already omits `q_keywords` when
   `icp.keywords` is empty, even with `organizationDomains` present. No
   implementation change — this is the guardrail the depth phase's query
   fix (Task 3) relies on.
2. **Task 2** — Fixed a latent bug in `getVerifiedLeadCompanies`
   (`src/lib/db/leads.ts`): it filtered `.eq('email_status', 'verified')`
   (Apollo's raw verdict) instead of `.eq('status', 'active')` (the
   authoritative "actually cleared and grouped into a case" field per the
   2026-08-05 precision-design spec). A lead Apollo marked `verified` but
   later parked (suppressed, post-enrich excluded, AI-rejected) was still
   counted as "this company has a verified lead." Harmless before this fix
   since pass 2 never ran a useful query anyway, but would have corrupted
   the new depth phase's per-round target list. Added a test with a local
   mock recording `.eq()` calls to prove the correct column/value is used.
3. **Task 3** — Replaced the fixed first-pass/second-pass/top-up run in
   `src/lib/pipeline/discover.ts` with a round loop: each round tries
   **depth** (`runDepthSearch`, renamed from `runSecondPass` — targets
   every company currently sitting at exactly 1 verified lead, drops the
   redundant `q_keywords` filter entirely since the domain restriction
   already pins the exact company) before **breadth** (`runBreadthSearch`,
   renamed from `runFirstPass` — brand-new companies, unchanged logic),
   and keeps rounding until `verified >= daily_target` or a round picks
   zero candidates total. A domain that comes back empty in the depth
   phase is added to a run-scoped `exhaustedDomains` set and skipped in
   later rounds; `verifiedCompanyCounts`/`domainBackedCompanyKeys` are only
   ever updated from a phase's *real* post-verification outcome, never an
   optimistic pick-time guess, so every round's depth-targeting decision
   stays accurate across many rounds. Each round's leads are still
   persisted immediately per phase (a later phase/round throwing never
   discards already-durable work). `DiscoverySummary` fields
   `firstPassCandidates`/`secondPassCandidates`/`topUpCandidates` are
   replaced with `depthCandidates`/`breadthCandidates`/`rounds`; the
   `vendorContext` Apollo-failure payload changed from `{ pass, page }` to
   `{ phase: 'depth' | 'breadth', round, page }`. Round 1 naturally behaves
   like pure breadth (no 1-lead companies exist yet to deepen). Test suite
   fully rewritten around the round loop, including a regression test for
   the exact reported bug (`daily_target` 15 → 9 companies × 1 lead) now
   asserting the shortfall gets retried via breadth when depth comes up
   empty.

All three changes TDD'd (failing test confirmed before each fix). Full
repo suite: 198 files / 2092 tests green, `tsc --noEmit` and `eslint`
clean on every touched file. Commits skipped per instruction — not yet
committed.

## 2026-08-08 — Diagnosed two live production error clusters from the Logs tab

User pasted a batch of "Write job crashed" / "Gemini generateObject failed" /
"Web search failed" / "Page fetch failed" error rows from the last 3-4h.
Root-caused both clusters via `superpowers:systematic-debugging`, no
reproduction environment available (static analysis + git archaeology only).

**Cluster A — Gemini `NoObjectGeneratedError` ("could not parse the
response"), surfacing as both `llm.failed` and `pipeline.write.route_failed`
("Write job crashed"):** `generateJson` (`src/lib/llm/client.ts`) only
passes `thinkingConfig` when a caller explicitly sets `thinkingLevel`;
omitting it does **not** disable reasoning, it inherits gemini-3-flash-preview's
own default (non-zero) thinking budget, which is billed against the same
`maxOutputTokens` ceiling as the JSON payload. `write.ts` (1,400 tokens),
`redesign.ts` (1,400), `ai-relevance.ts` (200 — a lite-model classification,
the tightest budget in the codebase), and `derive-content.ts` (1,600, both
calls) all omitted `thinkingLevel`, unlike `agent.ts`/`reply.ts` which
deliberately set `thinkingLevel: 'medium'` **and** provisioned 2,800-3,000/
1,600 tokens accordingly. Fix: added `thinkingLevel: 'minimal'` to all five
call sites (none of the five are a judgment-heavy task that benefits from
reasoning) so thinking tokens stop competing with the structured-output
budget. Added a regression test per call site asserting the arg is passed.

**Cluster B — BrightData SERP/Web Unlocker failures (`brightdata.search.failed`
/ `brightdata.scrape.failed`, 100% failure rate across every unrelated query
and domain in the pasted window):** Not fully root-caused — needs the user
to check two things I have no access to: (1) whether production's
`BRIGHTDATA_SERP_ZONE` is a real, distinct SERP zone from `BRIGHTDATA_SCRAPE_ZONE`
(the 2026-08-07 zone-split fix, commit `0b286a2`, explicitly still needed
"the user to create a SERP zone in their Bright Data dashboard and set the
real value... in .env.local **and production**" — never confirmed done for
prod), and (2) Bright Data account balance/status (a 400 on every call
regardless of query, plus scrape-side connection failures, both look
account-level rather than per-request). Found and fixed a real bug blocking
future diagnosis of this either way: `describeError()` (`src/lib/events/
error-context.ts`) deliberately drops `AppError.context` before anything is
logged, so the *actual* Bright Data response body/status (captured in
`fetchJson`/`fetchText`'s AppError context) never reached the operator Logs
tab — every 400 just read "HTTP 400" with no reason. Added
`externalErrorDetails()` in `src/lib/research/tools.ts` to pull `status`/
`body`/`cause` out of the AppError context into the logged payload (only
those three fields are ever set there — never headers/auth — so safe to
show operators), and extended the two BrightData sentence builders in
`src/lib/ui/log.ts` to append it, e.g. `HTTP 400 ({"error":"zone not found"})`
instead of bare `HTTP 400`. 6 new tests (`tools.test.ts` ×3, `log.test.ts` ×3).

Full repo suite: 198 files / 2102 tests green, `tsc --noEmit` and `eslint`
clean. Not yet committed — awaiting the user's answer on the BrightData
zone/account question before treating Cluster B as resolved.

## 2026-08-08 — Upgraded the human-voice prompt to pattern-based rules + a regeneration tool to preview it

`HUMAN_VOICE_INSTRUCTION` (`src/lib/pipeline/email-voice.ts`, shared by
`write.ts`, `followup.ts`, `redesign.ts`) was a flat banned-phrase list —
good at catching known clichés, blind to failure modes that recur in
infinite phrasings (rule of three, copula avoidance, staccato drama, em
dashes, fake-candor rhetorical openers). Rebuilt it around the structure of
Wikipedia's "Signs of AI writing" guide: each new rule is a named pattern
with a worked bad/good pair, not just a word to avoid. Deliberately left out
the guide's encyclopedia-only sections (headings, boldface, citations,
notability, emoji) — none of them can occur in a 90-word plaintext email.

Added `scripts/regenerate-sample-emails.ts` (`pnpm regenerate-sample-emails
[--count=N] [--client-id=<uuid>]`) to compare the new prompt against
history: pulls first-touch outbound emails from `emails`, rehydrates each
one's lead/case/campaign/dossier, and reruns write.ts's exact
`SYSTEM_PROMPT` + `buildPrompt` path (both newly exported from `write.ts`,
along with `MAX_OUTPUT_TOKENS`, specifically so the script never duplicates
prompt-construction logic) to print old vs. regenerated side by side, plus a
heuristic tell-scan. Read-only: no DB writes, no sends. Had to dynamically
`import()` every app module that transitively reads `@/lib/env` (that module
eager-validates the *entire* env schema at import time, including
integrations — Bright Data, QStash, Apollo — this script never touches) so
`.env.local` loads before those imports resolve; also had to backfill an
unrelated required-but-absent-locally var (`BRIGHTDATA_SERP_ZONE`) with an
in-process-only placeholder, since this script's code path never reads it.

Ran it against 2 real historical emails (Uniforms Fashion → Elkhart PD,
Uniforms Fashion → SKY Airline). Both the stored originals and the
regenerated versions came back clean on the tell-scan — the prior prompt was
already decent — but the regenerated copies read slightly more direct
(e.g. "we manufacture our duty uniforms... rather than reselling" instead of
"shouldn't involve reseller markups"). Full repo suite: 198 files / 2113
tests green, `tsc --noEmit` clean. Not yet committed.

## 2026-08-08 — Per-client formal-intro email style for Uniforms Fashion

Added `clients.email_style` (`'concise'` default / `'formal_intro'`,
migration `0034_client_email_style.sql`). `write.ts` now has two system
prompts — `CONCISE_SYSTEM_PROMPT` (today's dossier-led, low-friction
voice, renamed from `SYSTEM_PROMPT`) and `FORMAL_INTRO_SYSTEM_PROMPT` (a
five-beat structured self-introduction: greeting, sender/company
self-intro, capabilities, a dossier-grounded personalized hook in place of
a generic "I came across your company" line, then a qualifying-question +
send-materials CTA) — selected per client via `selectSystemPrompt`.
`buildPrompt` gained a `client` parameter so the model has the sender's
real name/company to introduce, never invented. Scoped to first-touch only
(`followup.ts`/`redesign.ts` untouched) and to Uniforms Fashion only via a
new operator toggle on `/clients/[id]` (`EmailStyleSelect`,
`PATCH /api/clients/[clientId]` with `{ emailStyle }`) — every other
client keeps `'concise'` and sees zero behavior change.
`scripts/regenerate-sample-emails.ts` updated to fetch the client and pick
the matching prompt, so before/after comparisons stay accurate regardless
of style. Design: `docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md`.

Operator follow-up (not code): confirm Uniforms Fashion's `signature_name`
is filled in (e.g. "Cihat Bozkurt") via the existing signature dialog, then
flip the new toggle to `formal_intro` on the Uniforms Fashion client page.

Full repo suite: 198 files / 2117 tests green, `tsc --noEmit` and `eslint`
clean. Not yet committed (per instruction — commits skipped for this pass).

## 2026-08-08 — Flipped Uniforms Fashion to formal_intro and rewrote its 8 pending drafts

Follow-up to the entry above, done the same day. Added
`scripts/rewrite-draft-emails.ts` — the mutating counterpart to
`regenerate-sample-emails.ts`: regenerates and persists first-touch draft
emails (`status='draft'`, `sequence_step=0`) through write.ts's exact
current path (`selectSystemPrompt` + `buildPrompt` + the deterministic
signature block), writing through the same claim-guarded
`updateDraftContent` a manual Save/AI-Redesign already uses. Defaults to a
dry run (prints before/after, writes nothing); `--apply` persists.
Deliberately touches no lead/email verification — content-only rewrite,
never re-checks deliverability. `pnpm rewrite-draft-emails
--client-id=<uuid> [--count=N] [--apply]`.

Confirmed migration `0034_client_email_style.sql` is live against the real
Supabase project (`clients.email_style` read back `'concise'` before the
change). Set Uniforms Fashion's `email_style` to `formal_intro`
(`d99edf8f-b185-47b2-9615-1f6e43853001` — `signature_name` was already
"Cihat Bozkurt" from the earlier phone-signature feature, so no further
prerequisite work needed). Dry-ran `rewrite-draft-emails` against its 8
pending human_approve drafts, confirmed the output matched the intended
five-beat structure (Dear [name] / self-intro / capabilities / dossier
hook / qualifying question + offer), then re-ran with `--apply` — all 8
rewritten in place, still `status='draft'`, none sent. Verified post-write
subjects in the DB match the regenerated ones.

Full repo suite: 198 files / 2117 tests green, `tsc --noEmit` and `eslint`
clean (unchanged from the prior entry — this pass only added the new
script and ran it). Not committed (per instruction).

## 2026-08-09 — Closed 5 prompt gaps in FORMAL_INTRO_SYSTEM_PROMPT, then switched the email writer to gemini-3.6-flash

Reviewing the 8 formal_intro drafts applied the day before surfaced a real
personalization problem: on thin-dossier cases (a single firmographic
`case_knowledge` line — industry/size/founding year/location, nothing
else) the model was fabricating a claim to fill the mandatory hook beat
("...you likely require...", "...I know...is a priority") — a direct
instance of the speculative-gap-filling pattern `HUMAN_VOICE_INSTRUCTION`
is supposed to ban, but the beat-4 structural requirement was winning
against it. Confirmed by inspecting real `case_knowledge` rows directly
(Elkhart PD/Cheyenne PD: one bare `(company)` line; Extra Supermarket: 8
facts including 2 `pain_point`s and `news`, of which the old prompt kept
only one fragment). A same-day comparison against `gemini-3.6-flash`
(model id confirmed live via web search — GA July 21, 2026) showed the
fabrication dropped but didn't fix the underlying gap: the model either
fell back to a near-miss of a banned filler phrase ("I am reaching out to
[company]... regarding your... needs") or a disconnected trivia sentence —
confirming this was a prompt-structure problem, not a model-capability one.

Fixed 5 concrete gaps in `FORMAL_INTRO_SYSTEM_PROMPT` (`write.ts`):
(1) beat 4 now has an explicit fallback for a bare-firmographic-only
dossier — state the one fact plainly, no added claim, or skip it outright;
(2)+(3) the hook now explicitly prefers `(pain_point)`/`(news)` facts over
generic `(company)` firmographics, reinforced structurally by a new
`DOSSIER_KIND_PRIORITY` sort in `buildPrompt` so the sharpest facts are
listed first regardless of how well the model reads the text instruction;
(4) the hook can now run to two sentences when multiple strong facts
exist, word cap raised 120→130; (5) the local instruction now explicitly
names the exact filler phrase pattern models were reaching for. A further
round of manual review (the user's own read of the output) caught a sixth
issue past those five: even fixed, beat 4 still surfaced as an isolated
"Company X has done Y since Z" sentence reading like a database record.
Rewrote the structure instruction so personalization is folded into the
capabilities sentence (beat 3) and/or the ask (beat 5) instead of forced
into its own paragraph — thin-dossier cases now produce 4 paragraphs, not
5, with the one available fact woven into an existing sentence rather than
given its own line.

Verified with repeated dry runs (`pnpm rewrite-draft-emails`, no `--apply`)
against the same 3 real cases (Dove Green, Al Ittihad, Cheyenne PD) across
each prompt revision — confirmed each fix landed before moving to the
next, never re-verified lead emails, never touched sent mail.

Separately, switched `write.ts`'s first-touch generation specifically to
`gemini-3.6-flash` via `generateJson`'s existing per-call `modelId`
override (`EMAIL_WRITER_MODEL_ID`, same pattern as `ai-relevance.ts`'s
`gemini-3.1-flash-lite`) — it showed better discipline against inventing
claims in the comparison above. Scoped to `write.ts` only (`followup.ts`/
`redesign.ts` keep the pipeline's shared default); this applies to every
client's first-touch generation, not just Uniforms Fashion, since model
choice isn't a per-client setting anywhere in this codebase (unlike
`email_style`). `scripts/regenerate-sample-emails.ts` and
`scripts/rewrite-draft-emails.ts` both updated to default to the same
model (matching write.ts's real path); `rewrite-draft-emails.ts` keeps its
`--model-id` CLI flag as an override for one-off comparisons.

Full repo suite: 198 files / 2121 tests green (4 new: dossier-priority
sort, sender/company prompt lines present/absent, gemini-3.6-flash
modelId), `tsc --noEmit` and `eslint` clean. Not committed (per
instruction). The 8 drafts applied the day before still carry the
pre-fix formal_intro copy — not yet re-rewritten with the corrected
prompt/model.

## 2026-08-09 — Editable/addable email styles: Tasks 1–6 of 9 (DB/CRUD/pipeline/scripts/API, inline, no commits)

Per the approved design (`docs/superpowers/specs/2026-08-09-editable-email-styles-design.md`)
and plan (`docs/superpowers/plans/2026-08-09-editable-email-styles.md`), replacing
the fixed `concise`/`formal_intro` enum with an operator-managed `email_styles`
table. Executed Tasks 1–6 inline in this session (no subagent, no commits —
work sits uncommitted in the working tree); Tasks 7–9 (the `[styleId]` PATCH/
DELETE route, the `clients` route's `emailStyle`→`emailStyleId` swap, and the
`email-style-select.tsx` + manager-dialog UI) are still pending.

**Caught and fixed a plan/reality mismatch before it shipped a regression:**
the plan's migration seed text for "Formal introduction" was ported from
write.ts as it stood before `aa32d1f`/`9ffcf3e` (the human-voice-upgrade and
personalization-gap fixes landed *after* the design doc was written).
Seeding the stale wording would have silently reverted Uniforms Fashion's
live emails to an inferior prompt on migration day, breaking the design's
own explicit "byte-for-byte unchanged" rollout guarantee. Rewrote the
migration's seed row to match the actual current `FORMAL_INTRO_SYSTEM_PROMPT`
voice-specific content (structure-around-ideas framing, dossier-kind
personalization fallback, 130-word cap) instead of the plan's literal SQL.

**Task 1** — `supabase/migrations/0035_email_styles_table.sql` (table +
partial-unique-index single-default constraint + corrected seed rows +
`set_default_email_style` security-definer RPC for atomic default-swapping);
`src/types/database.ts` (`email_styles` table, `clients.email_style_id`,
FK relationship, `set_default_email_style` function signature, `email_style`
enum removed); `src/lib/errors/app-error.ts` gained `EMAIL_STYLE_NAME_TAKEN`
/ `EMAIL_STYLE_NOT_FOUND` / `CANNOT_DELETE_DEFAULT_STYLE`. `tsc --noEmit`
confirmed failures land only in the files later tasks touch.

**Task 2** — `src/lib/db/email-styles.ts` (new): `listEmailStyles`,
`getEmailStyleById`, `getDefaultEmailStyle` (throws `INVARIANT_VIOLATION`
if no row is default), `createEmailStyle`/`updateEmailStyle` (map Postgres
`23505` to `EMAIL_STYLE_NAME_TAKEN`), `setDefaultEmailStyle` (wraps the RPC),
`deleteEmailStyle` (blocks on `is_default`, reassigns referencing clients to
`null` before deleting). 21 new tests, all green.

**Task 3** — `updateClientEmailStyle` in `lib/db/clients.ts` now takes
`styleId: string | null` instead of the enum; 3 new tests added (no prior
block existed for it).

**Task 4** — `write.ts`: `CONCISE_SYSTEM_PROMPT`/`FORMAL_INTRO_SYSTEM_PROMPT`/
`selectSystemPrompt`/`EmailStyle` removed; replaced with `FIXED_GUARDRAILS`
(English-only, no bulk markers, dossier-grounded facts, subject-line rules,
human-voice instruction — never editable by an operator) and pure
`buildSystemPrompt(voiceInstructions)`. `processLead` now resolves
`getEmailStyleById(client.email_style_id)` falling back to
`getDefaultEmailStyle`, preserving the "missing client row never blocks
generation" guarantee. 18 tests green (4 new: style lookup, two fallback
paths, `buildSystemPrompt` guardrail/ordering checks).

**Task 5** — `scripts/regenerate-sample-emails.ts` and
`scripts/rewrite-draft-emails.ts` both switched from `deps.selectSystemPrompt`
to `deps.buildSystemPrompt` + the same client-style/default-fallback lookup,
via the same `AppDeps` dependency-injection pattern already used there.
`tsc --noEmit` clean on both.

**Task 6** — `src/app/api/email-styles/route.ts` (new): operator-only
`GET`→`listEmailStyles`, `POST`→Zod-validated (`name` ≤80 chars,
`voiceInstructions` ≤4000 chars)→`createEmailStyle`, logs
`email_style.created`, maps name conflicts to 409. 7 new tests green.

Full repo suite after Task 6: **200 files / 2155 tests green**. `tsc
--noEmit` shows exactly 3 remaining errors, all in Tasks 7–9's untouched
files (`email-style-select.tsx`, `clients/[id]/page.tsx`,
`api/clients/[clientId]/route.ts`) — no surprises elsewhere. Not committed
(per instruction — "skip commits, inline execution").

**Next:** Task 7 (`api/email-styles/[styleId]/route.ts` PATCH/set-default/
DELETE), Task 8 (`clients/[clientId]/route.ts` emailStyle→emailStyleId),
Task 9 (UI: `email-style-select.tsx` rewrite + new
`email-style-manager-dialog.tsx`).

## 2026-08-09 — Editable & addable email styles: Tasks 7–11 (feature complete)

Finished the remaining tasks from the entry above, same session, still
inline/no commits. Replaced the fixed `concise`/`formal_intro` email_style
enum with an operator-managed `email_styles` table end to end.

**Task 7** — `src/app/api/email-styles/[styleId]/route.ts` (new):
operator-only `PATCH` (edit `name`/`voiceInstructions`, or — mutually
exclusive with those two — `isDefault: true` to call
`setDefaultEmailStyle`) and `DELETE` (409 `cannot_delete_default_style` on
`CANNOT_DELETE_DEFAULT_STYLE`, 404 on `EMAIL_STYLE_NOT_FOUND`). 11 new
tests green.

**Task 8** — `api/clients/[clientId]/route.ts`: `patchSchema.emailStyle`
(enum) → `emailStyleId: z.string().uuid().nullable()`; PATCH block and
`client.email_style_changed` audit payload updated to carry the id, not
the enum value. Caught a bug in the plan's own test fixture along the way:
its sample id `'style-2'` isn't a valid UUID and would 400 against the new
`.uuid()` schema — used a real RFC4122-shaped id instead (version nibble
`4`, variant nibble in `8-b`) so the tests actually exercise the success
path they claim to.

**Task 9** — `email-style-select.tsx` rewritten to render every style from
a live `styles` list (no more hardcoded 2-value array) and PATCH
`emailStyleId`; new `email-style-manager-dialog.tsx` (Dialog pattern
matching `edit-signature-dialog.tsx`/`rename-client-dialog.tsx`) adds
inline create/edit/delete/set-default, with an explicit "this changes it
for every client using it" warning on both the list view and the edit
form. Verified all UI primitives/icons used (`Button` `icon-xs` size,
`Star`/`Trash`/`Plus`/`PencilSimple` from `@phosphor-icons/react`, `sonner`
toasts) actually exist in this codebase before writing the file, not just
copied from the plan's sketch. One `eslint` fix: unescaped apostrophe →
`&apos;`. No test file, consistent with every other `*-select.tsx`/
`*-dialog.tsx` on this page.

**Task 10** — `clients/[id]/page.tsx` now fetches `listEmailStyles`
alongside the client and resolves `selectedEmailStyle` (client's
`email_style_id`, falling back to whichever style `is_default` — this
matters beyond migration day, since a future style deletion can null a
client's `email_style_id` again). `tsc --noEmit` clean across the whole
repo — this was the last file referencing the old shape.

**Full-suite verification (Task 11):** `pnpm vitest run` → **201 files /
2167 tests green**. `pnpm exec tsc --noEmit` → clean, zero errors.
`pnpm exec eslint .` → zero errors, 7 warnings (all pre-existing,
unrelated `no-unused-vars` in `smtp/connect`, `env`/`env-public`,
`smtp-connection`, `tokens` test files this work never touched).

Every existing client's resolved voice is unchanged after migration — the
backfill is explicit (matched by name), not a bare default. The one
deliberate correction to the design doc's own sketch: migration
`0035`'s "Formal introduction" seed row was rewritten to match `write.ts`
as it actually stands at HEAD (post `9ffcf3e`), not the pre-human-voice-
upgrade wording the design doc's SQL sketch carried — using the stale text
would have silently regressed Uniforms Fashion's live emails on migration
day. Design: `docs/superpowers/specs/2026-08-09-editable-email-styles-design.md`.
Plan: `docs/superpowers/plans/2026-08-09-editable-email-styles.md` (all 11
tasks' non-commit steps checked off; commit steps deliberately left
unchecked — nothing in this feature has been committed yet, per
instruction).

## 2026-08-09 — Every email-writing agent now uses gemini-3.6-flash

Extended write.ts's earlier model override (gemini-3.6-flash, chosen for
being more disciplined about not fabricating claims on a thin dossier) to
every other pipeline stage that writes outbound email copy:
`followup.ts` (3/7/14-day nudges), `redesign.ts` (`/inbox` AI-rewrite-draft),
`reply.ts` (inbound reply classification + reply body), and
`knowledge-answer.ts` (reply once a human supplies a missing fact).
`ai-relevance.ts` deliberately excluded — it's a company-relevance
classifier, not an email writer, and stays on its own lighter
`gemini-3.1-flash-lite`.

`generateText` (`src/lib/llm/client.ts`) didn't support a per-call model
override at all — only `generateJson` did. Added the identical
`modelId?: string` field and `resolvedModelId`/`resolvedModel` resolution
so `followup.ts`/`knowledge-answer.ts` (both `generateText` callers) can
use it too. `EMAIL_WRITER_MODEL_ID` is now defined once in
`src/lib/llm/client.ts` (was a local constant in `write.ts`) and
re-exported from `write.ts` so `scripts/regenerate-sample-emails.ts` /
`scripts/rewrite-draft-emails.ts` keep working unchanged.

4 new tests in `client.test.ts` (mirroring `generateJson`'s existing
modelId coverage: default/overridden/usage-log/failure-log), plus one
`modelId`-assertion test per pipeline file. Every test file that mocks
`@/lib/llm/client` for one of these five modules needed
`EMAIL_WRITER_MODEL_ID: 'gemini-3.6-flash'` added to its mock factory —
vitest throws loudly ("No export is defined on the mock") rather than
silently returning `undefined` for an unmocked named export, which is
exactly what caught this before it shipped.

Full repo suite: 201 files / 2175 tests green, `tsc --noEmit` and `eslint`
clean.

## 2026-08-09 — Manual company info replaces website-RAG "About our company"

Operator ask: stop auto-injecting website-scraped knowledge into the
email-writing agents; give the operator a box to type the company
description themselves. Added `clients.company_info` (nullable `text`,
migration `0036`), edited from a new `EditCompanyInfoDialog` on the client
page (`Textarea`, no i18n — operator-only page per the "translate only
client-facing places" rule). Every outbound-email pipeline stage now reads
`client.company_info` for its "About our company" line instead of calling
`retrieveClientKnowledge` (the website-crawl RAG lookup): `write.ts`,
`followup.ts`, `redesign.ts`, `knowledge-answer.ts` dropped the RAG call
outright; `redesign.ts` and `knowledge-answer.ts` didn't fetch a client row
at all before, so both gained a `getClientById` call.

`reply.ts` is the one stage that couldn't just drop the retrieval: it also
uses `retrieveClientKnowledge` to find a specific uploaded-file excerpt to
offer as an email attachment (tagged `attachable #N`), a feature unrelated
to background company info. Fix was a filter, not a removal — added a
`resourceOnly` option to `retrieveClientKnowledge`
(`src/lib/knowledge/client-context.ts`) that restricts matches to
`resourceId !== null`, i.e. it can now only ever surface content from a
file the operator explicitly uploaded as a sendable resource, never a
scraped web page. `reply.ts` keeps calling it (`resourceOnly: true`) under
its own prompt heading ("Company knowledge from files"), separate from the
manual "About our company" block. `knowledge-answer.ts`'s retrieval call
had no such attachment role (its attachments are human-picked in /inbox,
not AI-matched) — removed outright like the other three.

`scripts/regenerate-sample-emails.ts` / `rewrite-draft-emails.ts` mirror
write.ts's exact generation path per their own header comments, so both
lost their `retrieveClientKnowledge`/`buildKnowledgeQueryText` deps and
`buildPrompt(...)` calls dropped the now-removed `clientKnowledge` arg.

The website-crawl knowledge base itself (Knowledge tab, sitemap crawling,
`client_knowledge_sources`/`client_knowledge_chunks`) is untouched — it
still exists and still backs `reply.ts`'s file-attachment matching for
uploaded resources; only its role as an "About our company" source across
all 5 writers was removed.

Design: `docs/superpowers/specs/2026-08-09-manual-company-info-design.md`.
Full repo suite: 201 files / 2191 tests green, `tsc --noEmit` and `eslint`
clean on every touched file.

## 2026-08-09 — Re-checked the two error clusters from the 2026-08-08 Logs diagnosis

User pasted another batch of the same two error signatures ("Gemini
generateObject failed: No object generated..." / "Web search failed...
HTTP 400 ... zone ... not found"), ~5h old at time of paste. Re-ran
`superpowers:systematic-debugging` rather than assuming the prior diagnosis
still applied.

**Cluster A (Gemini truncation):** Confirmed already fixed in code —
`thinkingLevel: 'minimal'` is present on all five call sites named in the
2026-08-08 entry (`write.ts`, `redesign.ts`, `ai-relevance.ts`,
`derive-content.ts` ×2); none of that is in the current uncommitted diff,
so it shipped in an earlier commit. Nothing further to fix here in code —
if the pasted errors are newer than the deploy that included this fix,
that points at a stale production deploy rather than a code bug.

**Cluster B (BrightData zone 400):** Live-tested `.env.local`'s
`BRIGHTDATA_SERP_ZONE` (`serp_api1`) directly against
`https://api.brightdata.com/request` with `BRIGHTDATA_API_KEY` — got a
real 200 with search results back just now, so that zone name and key are
valid and funded as of this check. The error body from the pasted logs
(`zone "serp_api1 serp_api1 serp_api1 serp_api1 serp_api1 serp_api1
serp_" not found`) is Bright Data echoing back a corrupted zone value with
`serp_api1` repeated ~6x, not a code-side string-concatenation bug (grepped
the whole repo — `BRIGHTDATA_SERP_ZONE` is read in exactly one place,
`brightdata.ts`, and passed straight through, never built up in a loop or
appended to). Most likely explanation: production's `BRIGHTDATA_SERP_ZONE`
env var (in Vercel) has the value pasted/duplicated by mistake, unrelated
to the local `.env.local` value which is correct. Still unresolved —
needs the user to open the Vercel project's env vars and confirm
`BRIGHTDATA_SERP_ZONE` there is exactly `serp_api1` with no repetition or
trailing whitespace, same ask as 2026-08-08's Cluster B, now with a
concrete guess at what's wrong.

No code changes this session — both findings point outside the repo
(stale deploy, prod env var), not a bug to fix here.

## 2026-08-09 — write.ts/redesign.ts moved from 'minimal' to 'medium' thinking

User wanted more reasoning depth on the two actual email-composition calls
(first-touch generation, inbox draft redesign) rather than 'minimal', which
the 2026-08-08 fix had pinned everywhere to stop the JSON-truncation bug.
Scoped to just those two — left `ai-relevance.ts` (binary pass/fail on the
cheap `gemini-3.1-flash-lite` model) and `derive-content.ts` (file
summarization, not a judgment call) on 'minimal', since neither benefits
from more reasoning and both would be the first to truncate again given
their much tighter existing budgets.

Applied `reply.ts`'s `classifyReply` as the reference: the one call already
running 'medium' thinking successfully, at a 1,600-token ceiling on a
similarly-sized schema, with `timeoutMs` raised to 30s. Mirrored both:

- `write.ts` / `redesign.ts`: `MAX_OUTPUT_TOKENS` 1,400 → 1,600,
  `thinkingLevel: 'minimal'` → `'medium'`, added a 30s `GENERATE_TIMEOUT_MS`
  (previously relied on `generateJson`'s 20s default, which the added
  thinking budget can now plausibly exceed — same risk reply.ts had already
  hit and fixed).
- `scripts/regenerate-sample-emails.ts` / `rewrite-draft-emails.ts`: both
  hardcoded their own `thinkingLevel: 'minimal'` independent of write.ts
  rather than importing it, so updated to `'medium'` too — their stated
  purpose is mirroring write.ts's real generation path, and a stale
  thinking level would silently make their output unrepresentative of what
  the live pipeline actually generates.

Updated both `it('should pin thinking to minimal...')` tests in
write.test.ts/redesign.test.ts to assert `thinkingLevel: 'medium'` and
`maxOutputTokens: 1_600`. Full suite: 201 files / 2191 tests green,
`tsc --noEmit` and `eslint` clean on every touched file.

## 2026-08-10 — new `contactsPerCompany` campaign setting, fixes "N companies × 1 lead" bug

User report: a campaign with `daily_target` 4 returned 4 different
companies with 1 lead each, instead of the expected 2 companies with 2
people each. Root cause (`src/lib/pipeline/discover.ts`): the breadth
phase was always handed the *entire* remaining quota as its pick budget,
and breadth picks at most 1 person per brand-new company — so a
fully-successful round 1 opens exactly `quota` distinct companies at 1
lead each and hits quota immediately, and the round loop exits before a
second round (the only place the depth phase can find a 2nd contact at an
existing company) ever runs. There was also no config field anywhere for
"how many contacts per company" — user chose the configurable-per-campaign
option over a fixed default when asked.

Fix, full stack (design doc:
`docs/superpowers/specs/2026-08-10-contacts-per-company-design.md`):

- New DB column `campaigns.contacts_per_company integer not null default 2`
  (1–10, migration `0037_campaign_contacts_per_company.sql`). Default 2
  matches the depth phase's pre-existing (never-guaranteed) intent, so
  every existing campaign's next run benefits without an operator having
  to touch settings.
- `campaignSettingsSchema` (`src/lib/apollo/campaign-settings-schema.ts`):
  `contactsPerCompany: z.number().int().min(1).max(10).default(2)`.
- `CampaignForDiscovery.contactsPerCompany` (required) drives two changes
  in the round loop: (1) the depth-target filter generalized from the
  hardcoded `count === 1` to `count < contactsPerCompany`, so depth keeps
  returning to a company across rounds until it hits the target or Apollo
  runs dry; (2) breadth's pick budget changed from the full remaining
  quota to `Math.ceil(breadthQuota / contactsPerCompany)`, reserving room
  for depth instead of opening one new company per remaining lead.
- Wired through `POST/PATCH /api/campaigns`, `insertCampaign`/
  `updateCampaignSettings`, the discover route's `CampaignForDiscovery`
  construction, `CampaignSettingsFields` (new number input, 1–10, next to
  Daily discovery target), both create/edit forms, and `en.json`/`tr.json`
  (this form is operator-only per this repo's translation rule, but the
  file already used `next-intl` throughout before this change — matched
  the existing pattern rather than a scope-creeping refactor).
- Added a direct regression test (`discover.test.ts`) proving
  `dailyTarget: 4, contactsPerCompany: 2` now yields 2 companies × 2
  contacts instead of 4 companies × 1. Updated 4 existing tests whose
  mocked Apollo call sequences assumed the old unreserved-breadth
  behavior (call counts/order shifted now that breadth stops as soon as
  its smaller reserved quota is met); one test (`dailyTarget: 0` →
  `DEFAULT_DAILY_QUOTA`) explicitly sets `contactsPerCompany: 1` since it
  tests the quota fallback, not per-company distribution.

Full suite: 202 files / 2197 tests green, `tsc --noEmit` and `eslint`
clean on every touched file.

## 2026-08-10 — Raised all the timeout/token-budget limits behind the two live error clusters

User pasted a fresh batch of the same two clusters from the Logs tab
("Write job crashed... No object generated" / "Web search failed...
This operation was aborted" / "Unexpected response shape... received
undefined"). Ran `superpowers:systematic-debugging` again rather than
reusing the 2026-08-08/09 diagnosis verbatim, since the BrightData
symptom had changed (abort/parse failures, not the earlier `zone "..."
not found` 400) — root-caused as a mitigation-level fix per explicit user
request ("increase all the limits"), not the deeper architectural ones
(concurrency cap on research agents, revisiting whether `write.ts`/
`redesign.ts` need `medium` thinking at all) still open below.

**Cluster A (`generateObject` truncation) — real regression, not stale
deploy this time:** the 2026-08-09 entry above switched `write.ts`/
`redesign.ts` from `'minimal'` back to `'medium'` thinking, justifying the
unchanged 1,600-token ceiling by analogy to `reply.ts`'s `classifyReply`.
That analogy doesn't hold: `classifyReply`'s `replyBody` is nullable (price/
not_interested/can't-answer cases skip prose entirely), while `draftSchema`
has no null branch — `write.ts`/`redesign.ts` must produce a full subject +
body on every call, so 100% of calls compete for the same budget against
`medium`'s reasoning tokens with no cheap-output escape valve. Raised
`MAX_OUTPUT_TOKENS` 1,600 → 2,600 in both, and matched `reply.ts` to the
same 2,600 for consistency even though it was never the primary truncation
risk. `GENERATE_TIMEOUT_MS`/`CLASSIFY_TIMEOUT_MS` 30s → 45s alongside (the
larger budget means more tokens the model can still be mid-generation on
when the clock runs out).

**Cluster B (BrightData aborts / bad JSON) — different symptom than the
prior zone-corruption diagnosis, points at concurrency saturation:**
`research.ts` runs one agent per lead + one for the company fully in
parallel (`Promise.allSettled`, no cap), each a 6-step tool loop where the
model can fire multiple `search`/`scrape` calls per step, and QStash fans
out one `research` route call per case on top of that. The
`contactsPerCompany` fix two commits ago (this session) means
`runResearchForCase` now legitimately spins up more concurrent agents per
case than it ever did before (the bug it fixed was silently capping
per-company leads near 1) — timed exactly with when this failure burst
started. Raised every timeout in the request path so a congested zone gets
more slack before the client gives up: `brightdata.ts` search 8s → 15s,
scrape 12s → 20s; `fetch-json.ts`/`fetch-text.ts` shared default 8s → 15s;
`client.ts`'s `TOOL_LOOP_TIMEOUT_MS` 45s → 90s (a 6-step agent loop can now
absorb several slow steps instead of just one), `DEFAULT_TIMEOUT_MS` 20s →
30s, `EMBED_TIMEOUT_MS` 15s → 25s. Also raised `agent.ts`'s
`GATHER_MAX_OUTPUT_TOKENS` 3,000 → 4,000 and `EXTRACT_MAX_OUTPUT_TOKENS`
2,800 → 3,600 for the same truncation-headroom reason as Cluster A, since
the research agent's own `generateWithTools`/`generateJson` calls share the
identical risk shape.

**Explicitly not done — still the real fix for Cluster B:** raising
timeouts makes each request more tolerant of a slow zone, it does not stop
the pipeline from firing more concurrent BrightData requests than the zone
can serve. Still needed: a concurrency cap (semaphore) around research
agents in `research.ts` and/or the `search`/`scrape` tool executors in
`tools.ts`, sized to whatever BrightData's dashboard reports as the zone's
actual concurrent-connection limit. Flagged to the user, not implemented
this session — scoped to exactly what was asked ("increase all the
limits"), not a bundled architectural change.

Updated `write.test.ts`/`redesign.test.ts`'s `maxOutputTokens: 1_600`
assertions to `2_600`; `scripts/regenerate-sample-emails.ts`/
`rewrite-draft-emails.ts` need no change since both import
`write.ts`'s `MAX_OUTPUT_TOKENS` rather than hardcoding it. Full suite:
202 files / 2197 tests green, `tsc --noEmit` and `eslint` clean on every
touched file.

## 2026-08-10 — Timeouts raised again, plus the platform ceiling that could cap all of it

User asked to raise the timeouts further (token budgets untouched this
round — "increase the timeouts even more"). Roughly doubled every value
from the entry above:

- `brightdata.ts`: search 15s → 30s, scrape 20s → 40s.
- `fetch-json.ts` / `fetch-text.ts` shared default: 15s → 30s.
- `client.ts`: `DEFAULT_TIMEOUT_MS` 30s → 60s, `TOOL_LOOP_TIMEOUT_MS`
  90s → 180s, `EMBED_TIMEOUT_MS` 25s → 45s.
- `write.ts` / `redesign.ts` `GENERATE_TIMEOUT_MS` and `reply.ts`
  `CLASSIFY_TIMEOUT_MS`: 45s → 90s.

**Flagged, not fixed:** grepped every route under `src/app/api` for
`export const maxDuration` — none exists anywhere in the repo, so every
route (`research`, `write`, `followup`, `discover`, `knowledge-scrape`,
etc.) runs under Vercel's plan-default function timeout. None of the
timeout increases above can matter past whatever that platform ceiling
actually is: if it's lower than 180s, `TOOL_LOOP_TIMEOUT_MS` will never
get the chance to fire — the function gets killed first, which looks
identical to a timeout in the logs but isn't one our code controls.
Separately, `src/lib/qstash/client.ts`'s `publishJSON` calls pass no
explicit `timeout` option either, so QStash's own per-delivery wait (not
verified against their current docs this session) is a second ceiling
that could sit below these numbers. Both need the user to check/set in
the Vercel project settings and QStash publish config respectively —
static analysis can't see either from here. Did not add `maxDuration` to
the routes unprompted since it's a distinct, cost-relevant change (longer
allowed execution = more compute billed) beyond "increase the timeouts."

Full suite: 202 files / 2197 tests green, `tsc --noEmit` and `eslint`
clean on every touched file.

## 2026-08-10 — Email-writing agents dropped from 'medium' to 'low' thinking

User asked to review all email-writing agents' thinking level and set it
to Low. Changed `thinkingLevel: 'medium'` → `'low'` in the three actual
email-writing agents:

- `write.ts` (`runWriteForLead`'s `generateJson` call — first-touch draft)
- `redesign.ts` (draft rewrite per operator instruction)
- `reply.ts` (`classifyReply` — inbound intent classification + reply draft)

Left `research/agent.ts` (`runResearchAgent`'s gather step), `ai-relevance.ts`,
and `derive-content.ts` untouched — none of those write email copy (dossier
research, lead-relevance scoring, resource-content summarization
respectively), so they're out of scope for "email writing agents."

Kept `MAX_OUTPUT_TOKENS` (2,600) and the 90s generate/classify timeouts
unchanged in all three files — they're cheap headroom to keep even at
'low' thinking, and draftSchema still has no null branch (a full
subject+body is still owed every call). Updated the stale in-code comments
that justified those constants by referencing 'medium' specifically, plus
the three `thinkingLevel: 'medium'` assertions in `write.test.ts` /
`redesign.test.ts` / `reply.test.ts`.

Verified: `vitest run` on all three touched pipeline test files — 55/55
tests green.

## 2026-08-10 — Fixed campaign "Invalid value" time picker; moved discovery schedule to operator

The native `<input type="time">` on the campaign form's "Discovery run
time" field was throwing the browser's native "Invalid value" constraint
bubble even on a normally-entered time — a well-known cross-browser
flakiness of the segmented time widget (worst on macOS Chrome/Safari,
where the picker renders 12-hour AM/PM while the underlying wire value
must stay 24-hour "HH:mm", and a partially-committed segment reports
`badInput` regardless of how the field looks). Root-caused via
systematic-debugging rather than patched around it.

Fix: built `TimeOfDayInput` (`src/components/ui/time-of-day-input.tsx`),
a controlled component of two plain `<select>`s (hour 00–23, minute
00–59) that combines to the same "HH:mm" string `timeOfDaySchema`
expects. A `<select>` can only ever hold one of its own listed options,
so there is no invalid state to land in — this removes the native
widget's failure mode entirely rather than working around a symptom.
Wired into `campaign-settings-fields.tsx` (shared by new + edit campaign
forms) behind a hidden `name="discoverTime"` input so the existing
FormData-reading submit handlers needed no changes.

Also moved the *client-owned* discovery schedule (timezone +
default_discover_time) off the client-facing `/settings` page onto the
operator-only `/clients/[id]` page, per instruction — clients no longer
set their own schedule; operators do. Deleted
`settings/schedule-section.tsx` + `settings/schedule-actions.ts` (+ test).
Added `clients/[id]/schedule-actions.ts` (operator-role-gated,
mirrors the `locale-actions.ts` `Result` pattern) and
`clients/[id]/schedule-settings.tsx` (auto-saves on change, like the
sibling `WarmupProfileSelect`/`DefaultLocaleSelect` controls). No i18n on
the new operator component per the "operator-only pages don't need
translation" rule — hardcoded English, unlike the campaign-form instance
which stays translated (client-facing).

Verified: `tsc --noEmit` clean, `eslint` clean on every touched file,
full suite 201 files / 2193 tests green.

## 2026-08-10 — Fixed TimeOfDayInput: selecting hour/minute wasn't sticking

Follow-up to the same-day "Invalid value" fix. `TimeOfDayInput` derived
its `hour`/`minute` display straight from the `value` prop on every
render. Picking only the hour left the combined string incomplete, so
`commit()` reported `''` upward — which round-tripped back down as the
new `value` prop and re-split to `{ hour: '', minute: '' }`, wiping out
the hour the user had just picked before they reached the minute select.
Symptom: "when I select a number it doesn't get inserted."

Fix: hold `hour`/`minute` as local `useState`, seeded from `value` once
at mount via a lazy initializer, instead of re-deriving them from the
prop every render. Each select's own selection now sticks regardless of
what the (possibly still-incomplete) combined value looks like.

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 201 files /
2193 tests green.

## 2026-08-10 — Campaign save errors now show which field failed, not a bare code

User hit "Could not save changes / validation_error" editing a campaign.
Traced the discoverTime/discoverTimezone path exhaustively (both the new
TimeOfDayInput and the pre-existing form-submit ternaries) and could not
find a way a completed, valid HH:mm selection produces an invalid
payload — verified via a direct `campaignSettingsSchema.safeParse` probe
with the exact shapes the client can produce. What *is* real and
pre-existing (untouched by the TimeOfDayInput change): both
`POST /api/campaigns` and `PATCH /api/campaigns/[campaignId]` returned
the bare literal string `'validation_error'` as `error` on any Zod
failure — for *any* field, not just discoverTime — which is exactly the
opaque message the user saw, with no indication of which field or why.

Added `formatZodMessage` (`src/lib/errors/format-zod-message.ts`),
which renders the first 3 Zod issues as `"path: message"` pairs (still
no stack traces or internal names — just field paths and Zod's own
validation text) and wired it into both routes' ZodError branches. The
existing client code already displays `json.error` verbatim in the
toast, so no client-side change was needed — the same failure will now
name the actual field on retry.

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 202 files /
2197 tests green (added 4 new tests for `formatZodMessage`, including
one asserting Zod's exact message text so a future Zod upgrade that
changes wording fails loudly).

## 2026-08-10 — Rewrote the research agent's system prompts to stop hallucinated "facts"

Traced a user report of fabricated `case_knowledge` for the Uniforms
Fashion hospital campaign to real DB rows: a `pain_point` citing
"Visual Observation of Social Media" as its source for a claim about
staff scrub colors, and a company-fact row citing "LinkedIn and ZoomInfo
Research" with no URL — both impossible, since `buildResearchTools`
(`src/lib/research/tools.ts`) only ever gives the agent `search`
(snippets) and `scrape` (one page's text); there is no vision/image
tool and no ZoomInfo/LinkedIn API integration, so neither citation could
have been produced honestly. The old system prompts (`COMPANY_GATHER_SYSTEM`
/ `PERSON_GATHER_SYSTEM` / `EXTRACT_SYSTEM` in `src/lib/research/agent.ts`)
said "do not invent facts" but never told the model what it actually
had access to, so nothing stopped it from inventing a plausible-sounding
research method to attach to a fact it wanted to include.

Per operator instruction: removed the "Our value proposition to them"
and "Start by searching" sections from `gatherPrompt` — priming the
agent with the sales pitch before it researches invites exactly the
kind of invented, narrative-fitting pain point found in the DB.
`runResearchAgent`'s `valueProp` param and `RunResearchInput.valueProp`
are gone; `seedQuery` (the hardcoded first search) is deleted too, in
favor of letting the model choose its own opening query per the
"start broad, then narrow" guidance below. Downstream email writing
(`write.ts`, `reply.ts`, `followup.ts`, `knowledge-answer.ts`) still
gets `campaign.value_prop` as before — only the *research* step now
runs blind to the pitch, so gathered facts stay objective.

Researched Anthropic's own agent-building and multi-agent-research-system
writeups before rewriting, and folded in: an explicit "Tools and limits"
section naming exactly what the agent can and can't do (closes the
vision/ZoomInfo hallucination hole directly); "start broad, then narrow"
search strategy instead of a scripted seed query; preference for primary
sources over SEO/data-broker pages, with instruction to flag — not
smooth over — numbers pulled from unverified aggregator profiles; and an
explicit stopping condition so the agent knows when it has enough rather
than searching indefinitely. `EXTRACT_SYSTEM` now explicitly forbids
inventing a citation label to cover a missing URL and forbids inferring
a `pain_point` "to fit a sales narrative" — both were exactly what
produced the two fabricated rows.

Verified: `tsc --noEmit` clean, `eslint` clean on touched files, full
suite 202 files / 2197 tests green.

## 2026-08-10 — Fed the research agent Apollo's own data, framed as "verify this" not "trust this"

Follow-up to the same-day system-prompt rewrite. Discussed whether to give
the research agent more of what Apollo already returns; landed on splitting
it into two buckets with different risk profiles instead of doing it
uniformly.

**Precise identifiers (low risk, pure win):** the person's Apollo
`linkedin_url` was already sitting on `leads.linkedin_url` but never reached
`ResearchAgentRole` — the person agent had to search-and-guess which
same-name LinkedIn result was the right one. `ResearchLead` (`provider.ts`)
now carries `linkedinUrl`; `personGatherPrompt` hands it over as a direct
scrape target, with an explicit instruction to confirm the name/title match
before treating the page as a source (a wrong-person match is a real risk
with a common name).

**Firmographics (real risk, handled carefully):** Apollo's
industry/employee-count/founded-year/location — the exact fields that were
wrong in both fabrication cases traced earlier today (Lake Health District's
Ohio/Oregon contradiction; Dauterive Hospital's domain mismatch) — are now
passed to the company agent too, but explicitly framed as "Apollo's own
match — unverified, confirm or correct it," never as ground truth. Extracted
`parseCompanyFirmographicsFromRaw` out of `group-lead.ts` (previously
private, now unused there for research purposes) into
`lib/apollo/format-company-summary.ts` next to the `CompanyFirmographics`
type it produces, so both `group-lead.ts` (the existing blind-trust
Apollo-knowledge write) and the new research route can share one parser
instead of two copies. `route.ts` reads firmographics off the first active
lead's `raw` (all leads on a case share one company/org match) and passes
them as `RunResearchInput.companyFirmographics`.

Both system prompts (`COMPANY_GATHER_SYSTEM`, `PERSON_GATHER_SYSTEM`) gained
a section on how to treat this provided context — check it, don't restate
it, and treat a contradiction as a finding worth writing down rather than
silently repeating or silently dropping. `EXTRACT_SYSTEM` now names "a
confirmed discrepancy against Apollo's provided match" as a valid `company`
entry. This is the mechanism that would have caught both of today's earlier
bugs at research time instead of by hand afterward.

Verified: `tsc --noEmit` clean, `eslint` clean on touched files, full
suite 202 files / 2200 tests green (added 3 new tests: firmographics
surfaced as unverified in the prompt, the Apollo section omitted when
there's nothing to pass, and the known-LinkedIn-profile confirmation
instruction).

## 2026-08-10 — Dialed back "verify Apollo" language per operator: Apollo is trusted

Operator called out that the previous change over-corrected: Apollo is a
trustable source, so the prompts shouldn't push the agent to actively
double-check it. Reworded both `COMPANY_GATHER_SYSTEM`'s "If you're given
Apollo's own match" section and `PERSON_GATHER_SYSTEM`'s "known LinkedIn
profile" section from "unverified — confirm/correct it" to "trusted
background — use it directly, no need to spend a step re-verifying it";
kept one narrow, passive fallback ("if something plainly contradicts it
along the way, mention it") rather than an active verification mandate.
Softened the matching inline `gatherPrompt` text (`companyGatherPrompt` /
`personGatherPrompt`) the same way, and dropped `EXTRACT_SYSTEM`'s explicit
"confirmed discrepancy against Apollo" clause. Left the **unrelated**
RocketReach/ZoomInfo skepticism in both system prompts untouched — that's
about data-broker pages the agent finds on its own during search, not
about our own Apollo integration, and is a separate, still-valid concern.

Verified: `tsc --noEmit` clean, `eslint` clean on touched files, full
suite 202 files / 2200 tests green (updated the 2 tests whose assertions
targeted the old wording).

## 2026-08-10 — Live-tested the research agent against a real fabricated case; found two real bugs

Ran `runResearchAgent` for real (live Gemini `gemini-3-flash-preview` + live
Bright Data) against Dauterive Hospital (case
`ec4414f5-5391-4936-8aa5-da00b5ce7adf`, the tradeprosokc.com domain-mismatch
case from earlier today) via a throwaway script — direct call, not
`runResearchForCase`, so no case_knowledge/case-status/CRM writes. Found two
issues, neither one the prompt-wording problem fixed earlier today:

**1. Bright Data zone was blocking this environment's IP outright.** Every
search/scrape call failed with the generic `"Unexpected response shape
((root): Invalid input: expected object, received undefined)"` — because
`fetchJson`/`fetchText` only check `response.ok`, and Bright Data returned
HTTP 200 with an **empty body** on rejection, putting the real reason only
in response headers we never read (`x-brd-error: Auth Failed (code:
ip_blacklisted)`, with a direct dashboard link to fix it). With zero real
tool grounding, the person-role agent — despite this same day's "do not
invent" and grounding-discipline rewrites — still fabricated an entire
fictional dossier (a fake SaaS company, fake CTO, fake funding round, fake
podcast citation) instead of returning nothing. Operator resolved the IP
block on Bright Data's end; re-running confirmed real search results now
come back and — critically — the agent did NOT fabricate anything on the
re-run, even though a couple of individual search calls still timed out
transiently. `fetchJson`/`fetchText` still don't surface Bright Data's
`x-brd-*` headers into `AppError` context — worth doing so this doesn't cost
another from-scratch investigation next time the zone rejects something.

**2. Real research was being silently discarded by the step budget.**
Reproduced the gather stage directly: it ran a genuine 145s tool loop
(12,258 prompt tokens — real search/scrape results accumulating in
context), yet `generateWithTools` returned completely empty text.
Root cause, confirmed by reading the AI SDK source directly (not
guessed): `stopWhen: isStepCount(GATHER_STEPS)` stops the tool loop the
instant the Nth step completes, whether that step was a tool call or a
text response. At `GATHER_STEPS = 6`, a real research task that needs the
full budget for search/scrape (disambiguating a common hospital name,
following up on a promising page) can spend every step on tools and never
get a turn to write its notes — the extraction step then correctly returns
`[]` (nothing to extract), but the actual research the tools already found
is thrown away. This is a distinct failure mode from fabrication: instead
of inventing facts, the case silently ends up with zero knowledge despite
successful research.

Per operator: raised `GATHER_STEPS` 6 → 10 for headroom (`agent.ts`).
Corrected `llm/client.ts`'s `TOOL_LOOP_TIMEOUT_MS` comment, which cited the
old GATHER_STEPS=6 worst-case math (6 × 40s scrape timeout = 240s) — now
10 × 40s = 400s, still deliberately above the 180s timeout per the existing
Vercel-maxDuration caveat, so left the timeout value itself unchanged, just
fixed the now-stale numbers in the comment.

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 202 files /
2200 tests green (no test pinned the old step count).

## 2026-08-10 — Re-confirmed GATHER_STEPS=10, found extraction is innocent, added Bright Data retry

Re-ran the live test to confirm the step-budget fix. Findings:

- **Isolated gather-stage diagnostic (10 steps, notes only):** excellent
  result — 4,822 characters of accurate, fully-sourced research on Dauterive
  Hospital, and it caught the `tradeprosokc.com` domain mismatch entirely on
  its own ("Website Discrepancy: ... incorrect and unrelated to this
  healthcare entity; it belongs to 'TradePros Heat & Air'..."), unprompted.
  Proves the fix works and the earlier prompt rewrites hold up on rich,
  real content.
- **Fed those exact real notes through the real extraction step:** 12 clean,
  correctly-classified, properly-cited entries, nothing invented. Extraction
  was never the bug — ruled out.
- **Full end-to-end confirmation run (both roles) still came back `[]`.**
  Traced to Bright Data itself still intermittently failing mid-loop even
  after the IP-block fix: `"Unexpected response shape"` (a 200 with an
  empty/malformed body — same symptom as the IP block, but recurring after
  that was resolved, so a broader upstream flake) and `"aborted"`
  (TIMEOUT_MS/SCRAPE_TIMEOUT_MS exceeded under a slow proxy hop). Manually
  retrying the *exact same* failing query moments later succeeded both
  times — confirms these are transient, not config/auth problems, so a
  run that happens to burn several of its 10 steps on retries-that-don't-
  exist-yet can still end up with no budget left to write notes.

Added retry to `research/brightdata.ts`: both `search` and `scrape` now go
through a `withRetry` wrapper (`MAX_ATTEMPTS = 2`, `RETRY_DELAY_MS = 500`)
around the existing `fetchJson`/`fetchText` calls — any `AppError` (both
observed failure modes surface as one) gets one retry after a short delay
before propagating. Scoped to `brightdata.ts` specifically rather than the
shared `fetchJson`/`fetchText` helpers, since retry policy is Bright-Data-
flakiness-specific, not something every other integration (Apollo,
Emailable, MailReach, HubSpot, Pipedrive) sharing those helpers should
inherit by default. Still not implemented (flagged as a follow-up, not
requested this round): surfacing Bright Data's own `x-brd-error`/
`x-brd-err-msg` response headers into `AppError` context — today's IP-block
investigation only found its real cause by going around our error handling
entirely and reading raw headers by hand.

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 202 files /
2202 tests green (added 2 new brightdata tests: retry-then-succeed and
retry-exhausted-then-throw, replacing the old single-attempt-failure tests
which no longer matched the retrying behavior).

## 2026-08-10 — Raised timeout limits alongside the retry

Operator asked whether the "aborted" failures meant our limits were too low.
Traced it: "Unexpected response shape" wasn't a timeout at all (Bright Data
returned 200 with an empty body immediately — confirmed by hand), and for
"aborted," a fresh retry succeeded fast rather than needing more time on the
same request — both pointed at retry as the correct fix (already shipped),
not longer limits. Operator asked to raise the limits anyway, as additional
headroom on top of the retry:

- `research/brightdata.ts`: `TIMEOUT_MS` 30s → 45s, `SCRAPE_TIMEOUT_MS`
  40s → 60s.
- `llm/client.ts`: `DEFAULT_TIMEOUT_MS` (generateJson/generateText — used
  by extraction and every other non-tool-loop LLM call app-wide, not just
  research) 60s → 90s; `TOOL_LOOP_TIMEOUT_MS` (generateWithTools) 180s →
  300s; `EMBED_TIMEOUT_MS` 45s → 60s for consistency, though embeddings
  aren't part of the research chain this investigation was about.

Deliberately left `fetch-json.ts`/`fetch-text.ts`'s generic
`DEFAULT_TIMEOUT_MS` (30s) untouched — that default is shared by every
other integration using those helpers without an explicit timeout (Apollo,
Emailable, MailReach, HubSpot, Pipedrive), none of which showed any
evidence of being too tight, and brightdata.ts/llm-client.ts always pass
their own explicit timeout anyway so this default was never in the actual
path being investigated.

Caveat flagged, not resolved: no route in this app sets `export const
maxDuration`, so the research route runs under whatever Vercel's
plan-default function timeout is. If that default is shorter than the new
300s `TOOL_LOOP_TIMEOUT_MS` ceiling, Vercel kills the function before our
own timeout ever fires — our code can't detect or work around this from
inside the function. Worth checking the actual Vercel project settings
and setting `maxDuration` explicitly to match if the platform allows it.

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 202 files /
2202 tests green (no test pinned any of the changed timeout values).

## 2026-08-10 — Downgraded research extraction to flash-lite for cost

Summed today's test-session token spend from the `events` log: ~214.5K
tokens across 15 live Gemini calls, 91% of it prompt tokens (accumulated
tool-loop context), not output. Gave the operator a prioritized cost list
(extraction model downgrade / sharing company research across person
agents / trimming MAX_SNIPPETS+MAX_SCRAPE_CHARS); operator picked the
model downgrade only.

Extraction (`generateJson` in `runResearchAgent`) was running on the same
`gemini-3-flash-preview` as the open-ended gather/tool-use step, despite
being a constrained, schema-validated task — turn already-gathered notes
into structured entries, no reasoning or tool use involved. Added
`EXTRACT_MODEL_ID = 'gemini-3.1-flash-lite'` (`agent.ts`) and passed it via
`generateJson`'s existing `modelId` override — same pattern already used by
`ai-relevance.ts`'s `AI_RELEVANCE_MODEL_ID` for its own classification call.
Runs on every agent call (company + each person), so this is a fixed cost
cut across the whole research pipeline, not a one-off. Gather itself is
untouched — that's where the real reasoning happens and stays on the
heavier model.

Not implemented this round (operator declined for now): sharing the
company agent's findings into each person agent's prompt to stop
rediscovering the same company facts per lead (the bigger structural
saving when `contactsPerCompany` > 1), and trimming `MAX_SNIPPETS`/
`MAX_SCRAPE_CHARS`.

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 202 files /
2203 tests green (added 1 test asserting extraction routes to the
lite model).

## 2026-08-10 — Trimmed MAX_SCRAPE_CHARS 6,000 → 4,000 for cost

Follow-up: operator asked for this specific one from the earlier cost list,
on its own (not `MAX_SNIPPETS`, left unchanged at 8). Every scraped page's
text becomes part of the running context for every later step in the same
tool loop, so trimming the per-scrape ceiling compounds savings across
`GATHER_STEPS`. Updated the one test that pinned the old default
(truncation-length assertion, 6,000 → 4,000).

Verified: `tsc --noEmit` clean, `eslint` clean, full suite 202 files /
2203 tests green.

## 2026-08-10 — Merged cross-industry cold-email prompt research into FIXED_GUARDRAILS/HUMAN_VOICE_INSTRUCTION

Operator asked for a deep web survey of publicly available cold-outreach
email system prompts (Utopian Labs' leaked `cold-email-1` prompt, the
"Sales Cold Email Coach" GPT, Artisan/Ava's hallucination-suppression
framing, cupel-cloud's Claude-SDR copy frameworks, plus cross-industry
AI-writing-tell blacklists), then to merge only the net-new rules into
our own prompt — skip anything we already cover or don't need (e.g.
"only write the email, not the subject" doesn't apply, our schema
requires both).

Added to `FIXED_GUARDRAILS` (write.ts): problem-first framing (lead with
the sharpest dossier fact, value prop backs it up rather than opening
the email), exactly-one-CTA answerable yes/no, and a ~90-word body
length target — the three rules every prompt surveyed enforces that we
didn't have. Dossier-only facts, no-invented-specifics, no-jargon,
per-recipient personalization were already covered and left untouched.

Added to `HUMAN_VOICE_INSTRUCTION` (email-voice.ts): a ban on numeric
ROI-multiplier hype ("10x", "5x", "cut costs in half") unless it's a
dossier fact, a ban on unearned prospect flattery not backed by a
dossier fact, and extended the AI-vocabulary blacklist with words that
kept surfacing across surveyed word-lists but weren't in ours yet
(multifaceted, realm, meticulous, unwavering, underpinnings, bespoke,
myriad, plethora, unparalleled) plus the chat-artifact opener
"Certainly!".

Deliberately did NOT add a hard `zod` max-length on `draftSchema.body`
— the word-count rule is prompt guidance, not schema validation, to
avoid reintroducing the generation-failure risk documented in the
2026-08-10 MAX_OUTPUT_TOKENS entry above (a hard ceiling the model
slightly overshoots fails the whole call; a soft target doesn't).

Verified: `tsc --noEmit` clean on both files, `eslint` clean, existing
`write.test.ts` suite (78 tests across write/redesign/followup/reply)
green unchanged — tests call `buildSystemPrompt()` directly rather than
asserting a literal string, so the new guardrail lines needed no test
updates.

## 2026-08-10 — Added scripts/test-fake-email.ts, ran the live prompt against synthetic data

Operator wanted to see write.ts's actual generation path produce an email
without needing a real DB case. Added `pnpm test-fake-email` (`--style=concise`
default or `--style=formal`), which calls the exact same `buildSystemPrompt` +
`buildPrompt` + `generateJson` sequence `processLead()` uses, against a fully
synthetic lead (Sarah Chen / Northwind Logistics), client (Vantage Robotics),
and a 4-fact dossier (pain_point/news/person/company) — no Supabase reads or
writes, nothing sent. Voice-instruction strings are byte-for-byte copies of
the two seeded rows in `supabase/migrations/0035_email_styles_table.sql`, so
the script exercises real production wording, not an approximation of it.
Prints the full system prompt, user prompt, raw model output (with a word
count), the final signed body via the real `appendSignatureBlock()`, and the
same tell-scan `regenerate-sample-emails.ts` uses.

Ran both styles live against `gemini-3.6-flash`: concise came back 72 words,
led with the pain_point fact, one CTA ("Would you be open to seeing how this
works next week?"), no banned tells. Formal came back 78 words, followed the
5-part structure (greeting/self-intro/capabilities/personalize/ask) correctly,
folded the Series B news and pain_point fact into their own paragraphs, no
signoff (append handles that), no banned tells. Confirms the 2026-08-10
FIXED_GUARDRAILS/HUMAN_VOICE_INSTRUCTION additions above are live and working
as intended.

Verified: `tsc --noEmit` clean, `eslint` clean (one unused-import warning
fixed), both style variants ran end to end against the real model.

## 2026-08-11 — Fixed formal-intro style: false footprint claim + isolated-fact regression

Operator flagged a live Uniforms Fashion → International Jubilee Private
School email that (1) claimed "we manufacture custom school uniforms ...
for K-12 institutions in Abu Dhabi" — Uniforms Fashion (Istanbul) has no
Abu Dhabi footprint, the model just glued the recipient's location onto the
capabilities sentence as if it described an existing market — and (2) wrote
its one personalization fact ("G7 recently shortlisted International
Jubilee Private School among the top three schools in the UAE for the
2025-2026 academic year.") as a bare "Company X has done Y since Z"
sentence, exactly the pattern step 4 of the prompt already says never to do.

Root causes, both in the "Formal introduction" `email_styles` row seeded by
migration 0035: step 3's only example of folding in the recipient's location
("...for police and corrections agencies like yours in Wyoming") never made
the "like yours" analogy framing mandatory, so the model was free to drop it
and state the location as fact; and the "never isolate a fact" rule was
never restated for the single-fact case, where there's nothing else nearby
to weave it against.

Fixed via `0038_fix_formal_intro_overclaim_and_isolation.sql`: step 3 now
explicitly forbids stating or implying the sender already operates,
manufactures, or has clients in the recipient's country/region unless
"About our company" says so; the opening rule now has an explicit
single-fact case requiring a connecting clause ("because"/"after"/"since"/
"which is why") instead of a standalone sentence. Also brought
`scripts/test-fake-email.ts`'s `STYLE_VOICE_INSTRUCTIONS.formal` copy back
in sync with the seed — it had drifted out of byte-for-byte parity with
migration 0035 (missing the split/skip-paragraph and generic-fallback
clauses from step 4) despite its header comment claiming otherwise.

Verified: `vitest run` on `email-styles.test.ts` / `write.test.ts` /
`signature.test.ts` (46 tests, all pass — none hard-code the seed string) and
`tsc --noEmit` clean on the touched script.

## 2026-08-11 — Disabled person-level research (feature flag, not deleted)

Operator inspected the 4 live "contacted" school leads' `case_knowledge` and
found `kind: 'person'` facts present for only 1 of 4 (Prasanth Kumar, IJPS);
the other 3 cases' `person` entries were real facts, but about the wrong
person — the school's Principal/CEO/PR Manager the agent ran into while
scraping the site, not the actual lead being emailed (Vhenchie Jeruela,
Elena Platonova, Sarah Johnson). Root cause: `PERSON_GATHER_SYSTEM`
(`research/agent.ts`) correctly refuses to fabricate a hook when it can't
find one for the named lead, but the extraction step then has no field
tying a `person` entry to *whose* fact it is, and `write.ts`'s dossier
flattens every knowledge row into one bullet list with `person` facts
prioritized above `company` facts — so a wrong-person bio was one dossier
generation away from reading as a fact about the recipient. Checked the 4
actual drafts (all `status: draft`, none sent — client is on
`human_approve`): none misattributed in this batch, the model happened to
prefer `news`/`pain_point` facts instead, but the risk was live.

Disabled via `ENABLE_PERSON_RESEARCH = false` in `pipeline/research.ts`'s
`buildRoles()` — company research still runs on every case; per-lead person
research is skipped entirely, not removed. `agent.ts`'s
`PERSON_GATHER_SYSTEM`/`personGatherPrompt` path is left fully intact so
it's a one-line flip to re-enable once fixed (tag `person` entries with who
they're about, and/or add a role-scoped-inference fallback for this ICP —
school finance/business/procurement staff rarely have the public footprint
— LinkedIn posts, interviews, talks — the current prompt chases). Existing
mislabeled `person` rows already in the DB for the 3 affected cases were
**not** deleted — flagged to operator, cleanup pending a decision.

Updated `research.test.ts` to match: person-role tests removed/collapsed
(roles are always `[company]` now regardless of `input.leads`), added a
dedicated "skips person research even when leads exist" test.

Verified: `vitest run` on `research.test.ts` + `agent.test.ts` (15 tests,
all pass) and `tsc --noEmit` clean.

## 2026-08-11 — Fixed dossier fact-selection and negative-fact guardrails (global) + Formal introduction style's fact-inference ban

Operator reviewed Uniforms Fashion's last 4 hospital leads' `case_knowledge`
against their drafted emails (all on the "Formal introduction" style).
Found the model picking a purely reputational `news` fact (a trustee
election) over a sharper `pain_point` fact (2020 near-closure, rural
staffing instability) for Evans Memorial Hospital, even though
`DOSSIER_KIND_PRIORITY` in `write.ts` already ranks `pain_point` ahead of
`news` — kind alone doesn't capture sales relevance, and the prompt had no
instruction to prefer an operational-change fact over a reputational one
within/across kinds. Root cause for the drop of the stronger fact:
avoiding a direct restatement of the hospital's financial distress was the
right instinct (naming it back reads as an insult), but the model had no
safe way to *use* it, so it silently fell back to a weaker fact instead.

Added two new bullets to `FIXED_GUARDRAILS` in `write.ts` — global, applies
to every client and every `email_styles` row, not just manufacturer/formal
styles: (1) prefer a fact implying a concrete operational change
(expansion, new facility, funding, contract win, hiring surge, compliance
event) over a merely reputational one (award, board seat, media profile)
when both share a dossier kind; (2) if the strongest fact is negative about
the recipient's org, never restate it directly — reference its neutral
operational implication instead, or fall back to the next-strongest fact.

Also fixed the "Formal introduction" `email_styles` row (DB, id
`f5263888-e87d-494e-acee-d34041d8838c`): its personalization step banned
"any claim about why it matters" for a dossier fact, which is why the
NewYork-Presbyterian and Northern Westchester emails (the two that read
best) had to *break* the style's own rule to draw a fact→need connection,
while the Evans Memorial email obeyed it literally and read flattest as a
result. Replaced that ban with a scoped allowance: one direct inference
from a fact to product volume, fit/sizing consistency, or timing is
permitted via a connecting clause, but budget, priorities, and feelings
stay off-limits. Kept generic to "product" (not "garment") since the style
is shared by any manufacturer client, not just Uniforms Fashion.

Not changed (deferred, needs separate validation): the self-intro clause
("My name is Cihat Bozkurt...") in all 3 emails technically violates
`HUMAN_VOICE_INSTRUCTION`'s ban on "my name is [X]" — the Formal
introduction style's step 2 gives the model nowhere else to go. Flagged to
operator, not fixed this pass.

Verified: `vitest run` on `write.test.ts` (20 tests, all pass — none
hard-code the old guardrail text) after the `write.ts` edit.

---

## Client Home Dashboard — 2026-08-11

**Goal:** a `/home` landing page for client-role users summarizing analytics,
running campaigns, latest leads, pending actions, and recent mail —
replacing `/crm` as the post-login destination for clients. Operators are
unaffected, still land on `/crm`.

- [x] Design spec: `docs/superpowers/specs/2026-08-11-client-home-dashboard-design.md`.
- [x] Hoisted `StatTile`, `SparklineChart`, `RealtimeRefresher` out of
      `/analytics` into `src/components/` so `/home` and `/analytics` share
      one implementation (`RealtimeRefresher` gained a required `channel`
      prop).
- [x] `listRecentLeadsForClient` added to `src/lib/db/leads.ts`.
- [x] `/home` route: stat tiles (leads found, emails sent, replies, active
      campaigns), needs-your-action card (drafts + knowledge requests),
      7-day activity trend, running campaigns, latest leads found, recent
      mail — all RLS-scoped, real-time, fully translated (`home` i18n
      namespace + `nav.home`).
- [x] Nav: new `Home` item (client-only) at the top of the primary nav;
      login now redirects clients to `/home` (operators still land on
      `/crm`).

**Demo:** sign in as a client, land on `/home`, see campaigns, leads, mail,
and analytics at a glance; sign in as an operator, still land on `/crm`.

**Verified:** `pnpm typecheck && pnpm lint && pnpm test` (202 files, 2206
tests, all passing) and `pnpm build` (production build succeeds, `/home`
route present) — all clean.

---

## Client Home Dashboard — Visual Redesign — 2026-08-11

**Goal:** the initial `/home` layout looked sparse and required page
scrolling — four stacked sections, the needs-action banner as its own
full-width strip, and a mail section rendering full `EmailMessage` bodies
(up to 900 chars × 5) that pushed the page well past the fold.

- [x] Needs-action card redesigned to match `StatTile`'s label/value/hint
      shape and folded into the stat bento row as a 5th tile instead of its
      own section (`needs-action-card.tsx`).
- [x] Campaigns / latest leads / recent mail reflowed into a 3-column row
      below the stat tiles, each card stretching to fill the remaining
      viewport height (`h-full` + internal `overflow-y-auto`) instead of
      shrink-wrapping its rows and leaving dead background space.
- [x] New route-local `MailRow` (`mail-row.tsx`) — a one-line summary
      (icon, subject, company, status, relative time) replacing the full
      `EmailMessage` card on this page; `CampaignRow` gained a matching
      icon avatar so all three columns share one row grid.
- [x] Outer page capped to `lg:h-[calc(100dvh-5rem)]` (5rem = the shell's
      `py-10` chrome) so desktop viewports need no page-level scroll —
      overflow is absorbed by each column's own scroll area, and the cap
      drops entirely below `lg` so mobile/tablet still flow + scroll
      normally.
- [x] Follow-up: columns were still visibly underfull with only 5 rows
      each once they stretched to fill the height. `LIST_LIMIT` raised
      5 → 12 for leads/mail (real additional rows, not padding); campaigns
      column now shows every campaign (active first, then paused/archived
      with their real status pill) instead of active-only, so a client
      with just 1-2 running campaigns doesn't see a mostly-empty column.
      Renamed `home.sectionRunningCampaigns` → `home.sectionCampaigns`
      ("Campaigns"/"Kampanyalar") since the column is no longer
      active-only.
- [x] New i18n key: `home.noSubject` ("(no subject)"/"(konu yok)") for
      `MailRow`'s subject fallback.
- [x] Design system untouched — Inter, oklch tokens, `border-hairline` /
      `bg-surface`, `--ease-out-quint`, phosphor-light icons all kept as-is
      since `/home` shares chrome with every other authenticated page.

**Verified:** `pnpm typecheck && pnpm lint && pnpm test` (202 files, 2206
tests, all passing, including `messages.test.ts` key-parity).

---

## Uniforms Fashion School Emails — Irrelevant Hooks Root Cause + Fix — 2026-08-12

**Trigger:** operator flagged the last 4 generated school-lead emails
(Uniforms Fashion, "Okullar" campaign) as low quality despite the 0038
formal-intro fixes landing the day before.

**Root cause investigation** (pulled the actual 8 most-recent generated
emails + their dossiers straight from Supabase, not just re-reading the
prompt):
- Several "hooks" were grammatically connected but logically irrelevant to
  uniforms — a Pre-KG tuition discount, a Group Head of Finance's 2023
  departure, a TEDx event — because nothing in the pipeline ever judges a
  dossier fact for relevance to what the client actually sells.
  `DOSSIER_KIND_PRIORITY` (`write.ts`) and the "prefer operational change
  over reputational" tiebreaker (`FIXED_GUARDRAILS`, added 2026-08-11) both
  rank by kind/recency only — a fact can satisfy both and still have zero
  bearing on apparel procurement.
  - Traced deeper: `research/agent.ts`'s gather prompts
    (`companyGatherPrompt`/`personGatherPrompt`) told the agent only the
    *target* company's name — never who the research was *for* or what
    that client sells. The agent had no way to prefer a uniforms-relevant
    fact over an unrelated one, because it didn't know uniforms were the
    business.
  - Two emails also invented a claim beyond the dossier ("you may be
    reviewing vendor contracts," "remains essential") — a direct violation
    of the existing "never add a claim... that invents something the
    dossier does not say" guardrail, and one isolated a bare firmographic
    fact into its own flat sentence, the exact pattern the 0038 migration
    was meant to have fixed. Both point at partial instruction compliance
    at `thinkingLevel: 'low'` against a very long combined prompt
    (`FIXED_GUARDRAILS` + a style's `voice_instructions` is ~900 words of
    hard rules).

**Fixes:**
- [x] `write.ts`: `thinkingLevel` for the email-writer call reverted
      `'low'` → `'medium'` (was dropped 2026-08-10 for cost/latency and
      likely contributed to the isolated-fact regression holding
      inconsistently). `scripts/test-fake-email.ts` updated to match — it
      explicitly claims to mirror `write.ts`'s real call.
- [x] New `SellerContext` type (`research/agent.ts`): `{ name, companyInfo,
      valueProp }` — who the research is for and what they sell, threaded
      through `RunResearchInput` (`pipeline/research.ts`) →
      `runResearchAgent` → both gather prompts. `COMPANY_GATHER_SYSTEM` /
      `PERSON_GATHER_SYSTEM` gained a "Who you're researching for" section
      instructing the agent to weigh a fact's relevance to the seller's
      offering, not just its recency/newsworthiness; the per-call prompt
      now states the seller's name, value prop, and company info (omits
      itself entirely when the client row/value prop is missing, so
      research never blocks on it).
- [x] `api/pipeline/research/route.ts`: now fetches the client row
      (`getClientById`) and passes `{ name, company_info }` plus the
      campaign's `value_prop` as `seller` into `runResearchForCase` —
      previously the route never loaded the client row at all.

**Not changed this pass:** extraction (`EXTRACT_SYSTEM`) still has no
seller context — the ask was specifically about who the agent does
*search* for, and the gather step is where notes get written in the first
place; defense-in-depth at extraction is a candidate follow-up if
irrelevant hooks still surface after this.

**Verified:** `pnpm typecheck` clean; full `vitest run` — 202 files, 2211
tests, all passing (including new coverage: seller-context-in-prompt /
seller-context-omitted-when-empty in `agent.test.ts`, seller-passthrough in
`research.test.ts`, client-fetched-and-passed / missing-client-degrades in
`route.test.ts`, and the `write.test.ts` thinking-level assertion flipped
to `'medium'`). `eslint` clean on every touched file.

## Uniforms Fashion — Per-Client Mailreach API Key — 2026-08-12

**Why:** Uniforms Fashion's operator asked to use their own Mailreach
account/API key for warmup instead of the shared platform-level one. Every
other client keeps using the existing global key.

**Design:** `docs/superpowers/specs/2026-08-12-uniforms-fashion-mailreach-api-key-design.md`.
Env-var-based override (operator's explicit choice over a DB column + UI) —
new optional `MAILREACH_API_KEY_UNIFORMS_FASHION`, resolved per client id in
a new `src/lib/mailreach/client-api-keys.ts::resolveMailreachApiKey`. Falls
back to `MAILREACH_API_KEY` for every other client, and for Uniforms Fashion
itself until the override var is actually set.

**Changes:**
- [x] `env.ts`: `MAILREACH_API_KEY_UNIFORMS_FASHION` added, optional.
- [x] `mailreach/client-api-keys.ts` (new): `resolveMailreachApiKey(clientId)`
      — hardcoded single if/else for the one override, with a comment that a
      second per-client key should become a real DB column instead of a
      second branch here.
- [x] `mailreach/client.ts`: `authHeaders`, `connectSmtpAccount`,
      `completeOAuthConnect`, `disconnectAccount`, `getAccountStats` now take
      an explicit `apiKey` param instead of reading `env.MAILREACH_API_KEY`
      directly. `buildOAuthAuthorizeUrl` unchanged — it never sent an API key
      (browser hits Mailreach's OAuth consent screen directly; the key only
      matters at the callback exchange).
- [x] `mailreach/enrollment.ts`: internals resolve the key from
      `mailbox.client_id` (or the in-scope `clientId` for the two bulk
      functions) and pass it into the updated `client.ts` calls. Exported
      signatures unchanged, so the connect/disconnect/callback routes and
      `mailreach-actions.ts` needed zero changes.
- [x] `pipeline/mailreach-sync.ts` (reputation-stats cron sweep): resolves
      the key per mailbox from `mailbox.client_id` before calling
      `getAccountStats` — previously called with only the global key
      regardless of which client's mailbox it was.
- [x] `.env.example` documented the new optional var.

**Rollout:** ships inert — `MAILREACH_API_KEY_UNIFORMS_FASHION` unset means
identical behavior to before. Operator adds it to the deployment env once
the friend hands over their Mailreach API key; no further code change or
redeploy-triggering step needed.

**Verified:** `pnpm typecheck` clean; full `vitest run` — 203 files, 2221
tests, all passing (including new `client-api-keys.test.ts`, updated
`client.test.ts` / `enrollment.test.ts` / `mailreach-sync.test.ts` /
`env.test.ts` coverage for the resolved-key threading). `eslint` clean on
every touched file.

## Reports (weekly + monthly) — Tasks 1-6 — 2026-08-12

**Why:** Ship the data layer underpinning weekly/monthly client performance
reports — see `docs/superpowers/specs/2026-08-12-reports-design.md` and
`docs/superpowers/plans/2026-08-12-reports.md`. This pass covers plan Tasks
1-6 (migration/types through recipient-email plumbing's DB/auth layer);
Tasks 7+ (metrics builder, AI commentary, mailer, orchestrator, routes,
cron scripts, UI pages) are not yet started.

**Changes:**
- [x] Task 1 — `supabase/migrations/0039_reports.sql`: `reports` +
      `report_deliveries` tables, `report_type`/`report_status`/
      `report_delivery_status` enums, RLS policies matching
      `0018_client_resources.sql`'s `is_operator() or client_id =
      current_client_id()` shape. Hand-added matching types to
      `src/types/database.ts` (`Tables.reports`, `Tables.report_deliveries`,
      three new `Enums` entries). **Not applied** to a live Postgres — no
      local Supabase/Docker available in this environment (same situation as
      `0010_event_logging.sql`, per this file's 2026-07 entries); relying on
      `pnpm typecheck` plus close comparison against `0018`'s proven RLS
      pattern for confidence. Must be applied before Task 12's routes can
      work end-to-end.
- [x] Task 2 — `src/types/reports.ts`: `reportMetricsSnapshotSchema` +
      `ReportMetricsSnapshot` type, composing `OverviewMetrics`/`DailyMetric`
      from `types/analytics.ts`, with an optional `weeklyBreakdown` for
      monthly reports.
- [x] Task 3 — `src/lib/reports/period.ts`: `getWeeklyPeriod`/
      `getMonthlyPeriod` — UTC-day-aligned 7-day window and full-calendar-month
      math, `Date.UTC`'s native negative-month rollback handles Dec→Jan
      wraparound with no special-casing.
- [x] Task 4 — `src/lib/db/reports.ts`: CRUD layer — `upsertReport` (upsert
      on `(client_id, type, period_start)`, partial-field-safe), `getReportById`,
      `listReportsForClient` (ready/sent only), `listWeeklyReportsInRange`,
      `getPreviousReport`, `countPriorReportsForClient`,
      `insertReportDelivery`.
- [x] Task 5 — `src/lib/db/clients.ts`: added `listClientRoleAppUsersForClient`
      (single-client scoped, distinct from the existing all-clients
      `listClientRoleAppUsers`) and `listActiveClients`.
- [x] Task 6 — `src/lib/supabase/auth-admin.ts`: added `getAuthUserEmails`
      batch resolver — `Promise.allSettled` over `getUserById`, best-effort
      (drops any id that errors or has no email rather than failing the
      whole batch), distinct from `deleteAuthUsers`'s all-or-nothing
      semantics. Appended to the existing `auth-admin.test.ts` rather than
      overwriting it.
- Fixed one test fixture bug found while implementing: the plan's Task 2
  test used a non-RFC-compliant literal UUID
  (`11111111-1111-1111-1111-111111111111`, invalid v4 variant bits) that
  this repo's zod v4 `.uuid()` correctly rejects — same validator used
  throughout the codebase (`inbox/actions.ts`, `cases/[id]/actions.ts`,
  etc.) against real `gen_random_uuid()` values. Fixed the fixture, not the
  schema.

**Verified:** `pnpm typecheck` clean; full `vitest run` — 206 files, 2255
tests, all passing (96 of them new/changed across
`types/reports.test.ts`, `lib/reports/period.test.ts`,
`lib/db/reports.test.ts`, `lib/db/clients.test.ts` additions, and
`lib/supabase/auth-admin.test.ts` additions). Migration not yet applied
against a live database (see Task 1 note above) — apply and re-verify RLS
before Task 7+ routes depend on it end-to-end.

## Reports (weekly + monthly) — Tasks 7-14 — 2026-08-12

**Why:** Continuation of the reports feature — see `docs/superpowers/specs/2026-08-12-reports-design.md`
and `docs/superpowers/plans/2026-08-12-reports.md`. This pass covers Tasks
7-14: the metrics builder, AI commentary + fallback, the standalone SMTP
mailer, the 7 rotating email templates, the `generateReport()`
orchestrator, the 3 pipeline routes, the 2 cron registration scripts, and
the real SVG report chart. Tasks 15-18 (nav/i18n/list page, detail page,
the fake-report preview script, final roadmap pass) are not yet started.

**Changes:**
- [x] Task 7 — `src/lib/reports/metrics.ts`: `buildReportMetrics()` — calls
      the existing `getOverviewMetrics`/`getDailyMetrics` RPCs scoped to the
      client with no campaign filter (account-level aggregate only, spec
      §3); for `type: 'monthly'` also assembles `weeklyBreakdown` by copying
      each already-frozen weekly report's stored `overview` snapshot rather
      than recomputing, so a monthly report always agrees exactly with the
      weekly reports it recaps.
- [x] Task 8 — `REPORTS_SMTP_*`/`REPORTS_FROM_EMAIL`/`REPORTS_FROM_NAME` env
      vars (`env.ts`, `.env.example`, `vitest.config.ts`'s test-env stub) +
      `src/lib/reports/mailer.ts`: `sendReportEmail()` — its own minimal
      nodemailer transport (not the mailbox module's IMAP-carrying
      `SmtpCredentials`), BCC'd to `REPORTS_FROM_EMAIL` on every send,
      reusing `assertNoHeaderInjection`/`toMailAppError`/`withMailDeadline`
      from the mailbox module as provider-agnostic utilities only.
- [x] Task 9 — `src/lib/reports/email-templates.ts`: 7 rotating templates
      (`pickTemplate(priorCount % 7)`, `renderTemplate()`), company-name
      greeting only (no per-person name field exists), static
      `FEEDBACK_CALL_URL` constant, every interpolated field guarded by
      `assertNoHeaderInjection`.
- [x] Task 10 — `src/lib/reports/commentary.ts`: `generateReportCommentary()`
      on `generateJson()`/`thinkingLevel: 'low'`, grounded in the current +
      previous period's real numbers (never a fresh RPC — the prior
      period's already-stored snapshot); `buildFallbackCommentary()` for
      when the AI call fails — deterministic, always 2 highlights so the
      fallback shape stays valid against `reportCommentarySchema`'s 2-4
      minimum even though it's never re-validated through it.
- [x] Task 11 — `src/lib/reports/generate.ts`: `generateReport()` — the full
      orchestrator matching spec §2's numbered generation flow exactly
      (upsert generating → metrics → commentary-with-fallback → upsert
      ready → resolve recipients → per-recipient send with its own
      try/catch and `report_deliveries` row → upsert sent/send_failed).
- [x] Task 12 — 3 new pipeline routes:
      `/api/pipeline/reports-weekly-fanout`, `/api/pipeline/reports-monthly-fanout`
      (both mirror `discover-fanout`'s per-client publish-failure isolation
      exactly), `/api/pipeline/reports-generate` (QStash-signed, Zod-validated
      body, maps `NOT_FOUND`/`UNAUTHORIZED` to 404/401, everything else to a
      logged 500).
- [x] Task 13 — `scripts/schedule-reports-weekly-cron.ts` (`0 8 * * 1`) and
      `scripts/schedule-reports-monthly-cron.ts` (`0 8 1 * *`) — one-off
      `scheduleCron()` registration scripts, matching every existing
      `schedule-*-cron.ts` exactly, including that repo convention's lack of
      a `package.json` alias (confirmed no existing one has one before
      following that pattern here too).
- [x] Task 14 — `src/components/report-chart.tsx`: hand-built SVG line
      chart, no library. Invoked the `dataviz` skill per the plan's
      instruction before writing it, which changed the plan's own draft in
      one material way: the draft reused the case-*status* palette
      (`--status-ready`/`--status-contacted`/`--status-won`) as arbitrary
      series colors, which the skill's color-formula flags as a reserved-
      token violation (status colors carry pipeline-state meaning and must
      never double as "series 4" for an unrelated metric). Added a proper
      3-slot categorical palette instead — `--chart-1/2/3` in
      `globals.css`, light+dark, taken from the skill's own pre-validated
      reference palette (slots 1-3, documented as clearing the all-pairs
      CVD/contrast gates in both modes) and re-confirmed with
      `validate_palette.js` rather than trusting the doc alone. Also added,
      beyond the plan's static-only draft, per the skill's "hover is part
      of the deliverable, not an upgrade" rule: a pointer+keyboard
      crosshair/tooltip layer (client component), 2px round-cap lines,
      ≥8px end-dot markers with a 2px surface ring computed from the same
      `xFor`/`yFor` as the paths (no separate/driftable transform), and
      line-key legend swatches instead of boxes. `buildChartGeometry()`
      stays pure and exported for testing, now also returning `points`
      (per-index, all-series values, for the tooltip) and `seriesEndPoints`
      (marker positions) alongside the original `gridLines`/`paths`/`xLabels`.
- Fixed two more test-fixture bugs found while implementing, same class as
  the Task 2 UUID issue from the prior pass: `lib/reports/metrics.test.ts`
  and `lib/reports/generate.test.ts`'s plan-provided mocks used partial
  `OverviewMetrics` objects (e.g. `{ leadsDiscovered: 3 }`) fed into code
  paths that *really* run `reportMetricsSnapshotSchema.parse()` (unmocked)
  — a partial object fails that parse's 13-required-field check. Filled in
  full valid overview fixtures instead of trimming the assertions.
  `src/lib/env.test.ts`'s own hand-built `complete` env fixture (separate
  from `vitest.config.ts`'s global stub, already updated in the prior pass)
  needed the 7 new `REPORTS_SMTP_*`/`REPORTS_FROM_*` keys added or every
  `loadEnv(complete)` test failed on the newly-required vars.

**Verified:** `pnpm typecheck` clean; `pnpm lint` clean (0 errors, only
pre-existing unused-destructure warnings elsewhere in the repo); full
`vitest run` — 215 files, 2292 tests, all passing. Migration from Task 1
still not applied against a live Postgres (unchanged from the prior
entry) — the mocked unit tests here don't exercise real RLS or the real
upsert-on-conflict behavior either.

## Reports (weekly + monthly) — Tasks 15-18, feature complete — 2026-08-12

**Why:** Final pass of the reports feature — see
`docs/superpowers/specs/2026-08-12-reports-design.md` and
`docs/superpowers/plans/2026-08-12-reports.md`. This completes the plan:
the client-facing `/reports` list + `/reports/[id]` detail pages, nav +
full i18n (en/tr), the `test-fake-report.ts` preview script, and this
final verification pass. **All 18 tasks in the plan are now implemented.**

**Changes:**
- [x] Task 15 — Nav: `'reports'` added to `NavItem['labelKey']`,
      `ClipboardText` icon, new `PRIMARY_NAV` entry after `/analytics`,
      `clientOnly: true` (`src/components/shell/nav.tsx`). i18n: `nav.reports`
      key + full `reports` namespace (10 keys, 3 nested under `tile`) added to
      both `en.json` and `tr.json` — client-facing, so fully translated per
      this repo's rule (operator-only pages are not). New
      `src/app/(app)/reports/page.tsx` — `requireUser()` + operator→`/crm`
      redirect matching `/home`'s pattern exactly, `listReportsForClient`
      (Task 4), `EmptyState` for a brand-new client, type badge + period +
      generated-date row list. `loading.tsx`/`error.tsx` alongside, matching
      every other route's shape.
- [x] Task 16 — `src/app/(app)/reports/[id]/page.tsx`: `getReportById`
      (RLS-scoped, 404s via `notFound()` for another client's report or a
      still-`'generating'`/`'send_failed'` row), stat tiles, AI-commentary
      callout block, the real `ReportChart` (Task 14), and — monthly only —
      the weekly-recap table linking to each individual weekly report.
      `loading.tsx`/`error.tsx` alongside.
- [x] Task 17 — `scripts/test-fake-report.ts` (+ `pnpm test-fake-report`
      alias in `package.json`, precedented by `test-fake-email`'s own
      alias): synthetic weekly (4 backdated + 1 current) and monthly
      reports written through the real `upsertReport()`, emailed through
      the real mailer + real rotating templates to one hardcoded address,
      no AI call, no real recipient resolution — matching spec §10 exactly.
      Fixed one more spec-vs-`tsc` mismatch found while implementing: the
      plan's own code comment claimed "TypeScript narrows a `const` binding
      across a closure defined later in the same scope" for a
      nullable-then-checked `client` read as `client.name` inside a nested
      `async function emailPreview(...)` — real `tsc --noEmit` disagreed
      (`'client' is possibly 'null'`, TS18047). Pulled `clientName` out as
      its own `const` right after the null check instead of relying on
      cross-closure narrowing that doesn't actually hold.
- [x] Task 18 — Full verification pass (below) and this roadmap entry.

**`pnpm test-fake-report` — ran end-to-end successfully (update: this
superseded the same-day note below).** First attempt failed correctly at
env validation (`CONFIG_ERROR`) because `REPORTS_SMTP_*`/`REPORTS_FROM_*`
weren't in `.env.local` yet. Shengul added the 7 real SMTP vars to
`.env.local` directly; re-ran and it completed cleanly: printed 6 report
rows (5 backdated/silent weekly + 1 current weekly + 1 monthly, exactly
the shape §10 specifies), 2 preview emails sent to
`shengul@shengulai.com`. This also answered the open question about
migration `0039_reports.sql`: contrary to the note below, it turns out
**it is applied** on the hosted Supabase project — the `reports`/
`report_deliveries` tables already exist there (local Docker/Supabase
being unavailable in this sandbox only ever blocked the `migration up
--local` verification path, not the hosted project's actual state).
Re-ran the script a second time and got back the identical 6 UUIDs,
confirming `upsertReport`'s `(client_id, type, period_start)`
upsert-on-conflict semantics hold — no duplicate rows on a re-run.
Not confirmed from this session (needs Shengul's own inbox/browser):
the emails' actual from-address/BCC rendering, and clicking through to
the report pages to see the real charts and weekly-recap links render.

**Verified:** `pnpm typecheck` clean; `pnpm lint` clean (0 errors, same 9
pre-existing warnings as every prior entry, none newly introduced); full
`vitest run` — 215 files, 2292 tests, all passing (no new test files in
this pass — Tasks 15-17 are pages/a script with no automated tests,
matching this repo's established precedent: thin Server Component pages
composing already-tested `lib` functions, and a manually-run smoke script
like `test-fake-email.ts`); `pnpm test-fake-report` run twice against the
real hosted project, both clean, as detailed above. The feature is
implemented end-to-end. Remaining before the first real cron tick:
`pnpm schedule-reports-weekly-cron` / `pnpm schedule-reports-monthly-cron`
against that environment (needs `QSTASH_TOKEN`) — see the plan's
"Post-implementation" section.

## Pipeline latency: event-driven stage chaining — 2026-08-12

**Trigger:** Shengul reported the live pipeline feels very slow — discover
runs, then ~5 minutes later research runs, then ~5 minutes later write
runs — making manual testing painful and drawing client complaints about
turnaround time.

**Root cause investigation:** `research-fanout` and `write-fanout`
(`/api/pipeline/research-fanout`, `/api/pipeline/write-fanout`) are pure
polling scans — `listCasesByStatus(supabase, 'new'|'ready', 200)` — run on
independent `*/5 * * * *` QStash crons (`scripts/schedule-research-cron.ts`,
`scripts/schedule-write-cron.ts`). Nothing in `group-lead.ts` (case reaches
`new`) or `research.ts` (case reaches `ready`) ever notified the next
stage directly — a case sat idle until the *next* cron tick noticed its
status, up to ~5 minutes per hand-off (avg ~2.5 min). Chained across
`new`→`ready`→`contacted`, that's up to ~10 minutes of pure idle polling
on top of real processing time, matching exactly what was reported.
`discover-fanout`'s own 5-minute tick is unrelated — it's a deliberate
per-campaign daily-quota gate (`next_discover_at`), not part of this gap.

**Pattern check:** the codebase already solves this correctly in two other
places — `followup.ts`'s `scheduleFirstFollowup` enqueues the next
follow-up step immediately after the DB write instead of polling, and
`research.ts` already calls `enqueueCrmSync` (a best-effort `publishJson`
wrapped in try/catch) right after marking a case `ready`. The fix mirrors
that exact, already-proven pattern rather than introducing a new one.

**Fix:**
- [x] `group-lead.ts` (`groupVerifiedLead`): the instant a case is sitting
      at `status === 'new'`, immediately `publishJson('/api/pipeline/research',
      { caseId })`. Guarded on `'new'` so a later contact grouped into an
      already-progressed case never re-triggers research. Publish failure
      is caught and logged via `logWarn` (`pipeline.research_trigger_failed`)
      — never thrown, so a QStash hiccup can't turn a successful discovery
      run into a failure.
- [x] `research.ts` (`runResearchForCase`): the instant a case is marked
      `ready`, immediately `publishJson('/api/pipeline/write', { caseId })`,
      same best-effort try/catch → `logWarn` (`pipeline.write_trigger_failed`).
- [x] Both `research/route.ts` and `write/route.ts` already claim-guard on
      `status !== 'new'/'ready'` before doing any work, so it's safe for the
      new direct trigger and the periodic fanout to race on the same case —
      whichever arrives first claims it, the second no-ops.
- [x] `research-fanout`/`write-fanout` crons left unchanged at `*/5 * * * *`
      — they're now a safety net (same role as `stuck-sweep`) for a failed
      publish, not the primary trigger, so nothing regresses if a publish
      is ever dropped.

**Effect:** end-to-end stage-to-stage latency drops from "up to ~5 min of
idle polling per hand-off" to "processing time + a sub-second QStash publish
round trip" — seconds instead of minutes, for both live client campaigns
and manual testing.

**Verified:** `pnpm typecheck` clean; `pnpm lint` clean on all four touched
files; full `vitest run` — 215 files, 2298 tests, all passing (6 new: 3 in
`group-lead.test.ts` covering trigger-fires-on-new / no-trigger-when-not-new
/ publish-failure-is-swallowed, 3 mirrored in `research.test.ts`).

## False 'contacted' status on write failure + Gemini overload long-retry — 2026-08-12

**Trigger:** Shengul reported two live issues: (1) when a pipeline error
happens, a case can show `contacted` (or read as researched) even though no
email actually went out / no research completed; (2) Gemini has started
returning `503 UNAVAILABLE — high demand` this week, and asked whether the
"only 2 retries" behavior could back off 5 minutes and retry again instead
of failing outright.

**Root cause investigation:**
- `write/route.ts` claimed the case as `'contacted'` — its own terminal,
  "done" status — *before* calling `runWriteForCase`. `research/route.ts`
  does this correctly (claims the distinct in-progress `'researching'`,
  only `runResearchForCase` sets the terminal `'ready'`, and only on real
  success), but write had no equivalent in-progress status: `'contacted'`
  was doing double duty as both "claimed, in progress" and "done". Any
  failure mid-write (a Gemini error being the most common trigger this
  week) left the case permanently reading `'contacted'` with zero emails
  sent. `find_stuck_cases()` (0006) already knew this was ambiguous — its
  own comment says so — and only self-heals it after a 30-minute cutoff +
  up to a 15-minute sweep-tick lag, which is what was actually being
  observed as "false status." Traced every path in `research.ts` for an
  equivalent false-`'ready'` bug and found none — a failed research run
  correctly stays at `'researching'`, never `'ready'`; what reads as
  "says researched" is a case stuck at `'researching'` on the same
  30-45-minute recovery clock, not a second version of the write bug.
- Checked the Vercel AI SDK docs directly (not memory, via context7):
  `generateObject`/`generateText` default to `maxRetries: 2` — confirming
  Shengul's "I think we retry only 2 times" — all within seconds
  (SDK-internal backoff), not configured anywhere in this codebase. Once
  those 2 are exhausted, `llm/client.ts` immediately wrapped and rethrew —
  zero application-level retry existed. The failure propagated straight to
  the route, 500'd, and left the case claimed (compounding the bug above).
  The only recovery was `stuck-sweep`'s 30+ minute cutoff — not 5 minutes,
  and during a sustained Gemini "high demand" window that's the *actual*
  cadence today: fast-fail in seconds, then silence for ~30-45 min, repeat.

**Fixes:**
- [x] Migration `0040_case_status_writing.sql` — `case_status` gains
      `'writing'` (`after 'ready'`), a genuine in-progress claim mirroring
      `'researching'`. Migration `0041_stuck_sweep_writing_status.sql` —
      `find_stuck_cases()` gets a pure age-based `'writing'` branch
      (mirrors `'researching'`'s branch); the old `'contacted'`-with-no-
      step-0-email branch is kept as a backstop for cases already stranded
      there from before this shipped, not removed. `src/types/database.ts`
      updated to match.
- [x] `write/route.ts` now claims `'writing'` instead of `'contacted'`;
      `write.ts`'s own `updateCaseStatus(..., 'contacted')` at the end of
      the leads loop is unchanged and is now the only place that ever sets
      it. `stuck-sweep/route.ts`'s `requeueTarget` resets a stranded
      `'writing'` case back to `'ready'`, same as it already did for
      `'contacted'`.
- [x] `PRE_CONTACT_STATUSES` (`cases/[id]/send-actions.ts`, manual
      first-touch send) gained `'writing'` — a manual send landing while
      the pipeline's own write attempt is in flight should still advance
      the case to `'contacted'`, same as `'new'`/`'researching'`/`'ready'`.
- [x] `src/lib/ui/status.ts` (`CASE_STATUS`), `src/app/globals.css`
      (`--status-writing` in both light/dark themes, `--color-status-writing`
      bridge var), and `src/lib/seed/generate.ts` (`CASE_PLANS` +
      `CASE_STATUS_ORDER`) all updated for the new enum member — `tsc`'s
      `Record<CaseStatus, ...>` exhaustiveness check caught every one of
      these as compile errors, which is exactly how they were found.
- [x] `llm/client.ts`: new `toLlmAppError` helper (replacing 4 duplicated
      catch-block tails) preserves the AI SDK's `APICallError.statusCode`/
      `.isRetryable` onto the thrown `AppError`'s context instead of
      flattening it to a message string. New exported
      `isModelOverloadedError(error)` — true for a 503/429 statusCode or
      `isRetryable === true`, false for everything else (bad schema, auth,
      invalid request — failures worth failing fast on, not retrying).
- [x] New `src/lib/pipeline/overload-retry.ts` — `handleModelOverload()`:
      reverts the route's in-progress claim, then schedules a delayed
      QStash redelivery of the *same case to the same route* 5 minutes
      later via `publishJsonWithDelay` (the same primitive `followup.ts`
      already uses for its 3/7/14-day cadence — a serverless route can't
      just `sleep(5 min)` in-process), incrementing a `retryCount` carried
      in the message body. Capped at `MAX_OVERLOAD_RETRIES = 5` (~25 more
      minutes of runway on top of the SDK's own fast retries) — past the
      cap it gives up and leaves the case claimed for `stuck-sweep`'s
      slower cadence, so a sustained outage decays to a slower retry
      rhythm instead of hammering Gemini every 5 minutes forever. Never
      throws — a revert or reschedule failure is logged and absorbed, not
      allowed to mask the original error or crash the route.
- [x] `research/route.ts` and `write/route.ts`: the call to
      `runResearchForCase`/`runWriteForCase` is now wrapped in its own
      try/catch. `isModelOverloadedError` true → `handleModelOverload`
      (revert to `'new'`/`'ready'` respectively, long-retry) → `200` with
      `{ overload: outcome }`, no `route_failed` log. Anything else →
      rethrown to the existing outer catch, unchanged (`500`,
      `route_failed` logged, case stays claimed for `stuck-sweep`). Both
      route body schemas gained an optional `retryCount` field (absent on
      a normal fanout/direct-trigger delivery; only present on an
      overload-redelivered one).

**Verified:** Confirmed the AI SDK's `maxRetries: 2` default via the
official docs (context7 `/websites/ai-sdk_dev`), not assumed from memory.
`pnpm typecheck` clean; `pnpm lint` clean on every touched file; full
`vitest run` — 216 files, 2324 tests, all passing (26 new: `client.test.ts`
overload-detection coverage, new `overload-retry.test.ts`, route-level
overload-handling + `'writing'`-claim regression tests in
`research/route.test.ts` / `write/route.test.ts`, a `'writing'` branch test
in `stuck-sweep/route.test.ts`, and a `PRE_CONTACT_STATUSES` regression
test in `send-actions.test.ts`). Migrations `0040`/`0041` are **unverified
against a real Postgres** — Docker is unavailable in this sandbox, same
caveat as every prior migration added from this environment — SQL was
hand-checked against `0006`'s and `0011`'s already-applied, identically-
shaped precedents (`ALTER TYPE ... ADD VALUE`, the `find_stuck_cases()`
`UNION ALL` structure) but `supabase db push`/`migration up` needs to run
for real before the first Gemini-overload case actually exercises this
path in production.

## Landing hero copy + live-animated outcome panel — 2026-08-13

Requested directly (no spec/plan doc — small, scoped UI change): new hero
headline/subtext, and the hero's visual (`OutcomePanel`) made to feel "live"
rather than a static screenshot. User picked the "meetings roll in" option
of 3 proposed via `AskUserQuestion` (dot pulse only / cycling row highlight
/ meetings roll in) over `animate-pulse`-only or a pure row-highlight sweep.

- `src/components/landing/hero.tsx`: headline → "More qualified meetings.
  Less manual prospecting."; subtext → "Shengul AI finds your ideal
  prospects, researches them, creates personalized outreach, follows up
  automatically, and turns outbound into a predictable sales channel."
  (widened `max-w-[46ch]` → `max-w-[50ch]`, the new subtext is longer).
- `src/components/landing/outcome-panel.tsx` converted to a client
  component (`useRollingMeetings` hook): an 8-entry illustrative
  `MEETING_POOL` (was 3, hardcoded) rotates through a 3-row visible window
  on a 4.5s interval — new row slides in with a brief monochrome highlight
  flash + "New" tag, oldest row slides out via `motion/react`
  `AnimatePresence` + `layout`. The "meetings booked" counter ticks up
  through the pool's 5 extra entries (68→73) then holds, so the number
  never runs away on a long-open tab. Added a pulsing "Live" badge next to
  "This month", monochrome (`--l-accent`) to match the page's zero-chroma
  palette — the existing "Example figures" honesty label is untouched and
  still visible. `prefers-reduced-motion` (`useReducedMotion`, same
  contract as `Reveal`) disables the interval and the highlight/badge
  entirely, rendering the original static first-three-rows/68 view.
- Not a DB-backed or business-logic change (illustrative marketing data,
  same as before) — no new tests added, consistent with this component's
  prior "Critical paths only" status and the 2026-08-07 landing-copy-
  simplification precedent (no tests for landing-page-only changes).

Verified: `tsc --noEmit` clean (project-wide), `eslint` clean on both
touched files and the full `landing/` directory. Not verified: no manual
in-browser render — no dev server in this environment; the 4.5s interval,
row roll animation, and reduced-motion fallback are unexercised by any
automated check.

## Mailreach warmup surfacing — Tasks 1–6 — 2026-08-13

Implemented from `docs/superpowers/specs/2026-08-13-mailreach-warmup-surfacing-design.md`
+ `docs/superpowers/plans/2026-08-13-mailreach-warmup-surfacing.md`, tasks 1–6
(the fix + shared plumbing + Home/Analytics surfacing; Reports — tasks 7+ —
not yet done). Executed inline in-session (TDD steps from the plan: write
failing test → verify fail → implement → verify pass), commits skipped per
instruction — nothing has been committed yet, working tree only.

1. **`src/lib/mailreach/client.ts`**: the broken `getAccountStats` (read a
   `reputation_score` field that doesn't exist on the real
   `GET /v1/accounts/{id}/stats` response — confirmed `null` for every
   mailbox since launch) split into `getAccount` (real reputation `score`
   from `GET /v1/accounts/{id}`) + a corrected `getAccountStats` (the real
   messaging-volume fields, `total_messages_sent` / `_received` / `_spam` /
   `config_current_conversation_running`, requested with `past_days=180`).
   Old `{ reputationScore }` shape removed entirely — breaking change, only
   caller (`mailreach-sync.ts`) fixed in the same batch.
2. **DB**: new migration `0042_mailreach_stats_fields.sql` adds
   `mailreach_total_messages_sent/_received/_spam` +
   `mailreach_current_conversations` (all nullable `integer`) to
   `mailboxes`; `database.ts` hand-authored types updated to match.
   `updateMailboxMailreachStats` now writes all 5 fields;
   `listMailreachConnectedMailboxes` gained an optional `clientId` filter
   (sync sweep keeps calling with none; Home/Analytics/Reports scope to one
   client) plus a stable `order('email_address')`.
3. **`src/lib/pipeline/mailreach-sync.ts`**: `runMailreachStatsSync` now
   calls `getAccount` + `getAccountStats` concurrently per mailbox inside
   the same per-mailbox `try/catch` — either failing skips that mailbox
   for the run rather than writing partial stats.
4. **New `src/lib/mailbox/mailreach-gate.ts` exports**:
   `summarizeMailboxWarmup` (pure DB-rows → `MailboxWarmupInfo[]`, the one
   summarizer shared by all three consumers), `closestToReady`,
   `totalMessagesExchanged`.
5. **Home** (`src/app/(app)/home/page.tsx` + new `warmup-banner.tsx`): a
   banner between `PageHeader` and the stat-tile grid, shown only when ≥1
   mailbox is still gated — day counter, closest-to-ready mailbox,
   reputation score, messages exchanged, link to `/settings`.
6. **Analytics** (`analytics-view.tsx`): new "Mailbox warmup" `Section`
   after "Mailboxes", shown only when `warmup.length > 0` — per-mailbox
   table (status/reputation/sent/received/spam/active conversations).

Both `/home` and `/analytics` are client-facing → real English **and**
Turkish translations added for every new string (`home.warmupBanner`,
`analytics.sectionMailboxWarmup` + `analytics.mailboxWarmupTable`), no
English fallback left in `tr.json`.

**Verified:** `pnpm typecheck` clean, `pnpm lint` clean (only 9 pre-existing
warnings, none in touched files), full `pnpm test` — 216 files / 2342 tests,
all passing. Migration `0042` unverified against a real Postgres — same
Docker-unavailable caveat as every prior migration from this environment.

**Not done yet (plan tasks 7+):** Reports — frozen warmup snapshot in
`types/reports.ts`/`metrics.ts`, LLM commentary + fallback-commentary
warmup branch, the dedicated warmup email template, `generate.ts` wiring,
and the report-detail-page warmup panel.

## Mailreach warmup surfacing — Tasks 7–12 (Reports + full verification) — 2026-08-13

Continuation of the entry above — plan tasks 7–12, completing all of
`docs/superpowers/plans/2026-08-13-mailreach-warmup-surfacing.md`. Same
approach: inline in-session, TDD steps from the plan, commits skipped per
instruction.

7. **`src/types/reports.ts`**: `reportMetricsSnapshotSchema` gains an
   optional `warmup: MailboxWarmupInfo[]` array (`mailboxWarmupSchema`,
   `satisfies z.ZodType<MailboxWarmupInfo>`). `src/lib/reports/metrics.ts`:
   `buildReportMetrics` now also fetches the client row + Mailreach-
   connected mailboxes and freezes `summarizeMailboxWarmup`'s result into
   the snapshot (`undefined` when no mailbox is enrolled). `BuildReportMetricsInput`
   gained a required `now: Date`.
8. **`src/lib/reports/commentary.ts`**: `GenerateReportCommentaryInput`
   gained required `warmup: MailboxWarmupInfo[]`; `buildPrompt` appends a
   "Mailbox warmup in progress" block (day counters, reputation scores,
   messages exchanged) only when ≥1 mailbox is gated. Instructions tell the
   LLM to lead with warmup progress over dwelling on low counts when that's
   the actual cause. `buildFallbackCommentary` gained a `warmup` 3rd
   parameter and a warmup-first branch, checked before the normal fallback,
   triggered on `emailsSent === 0 && gated.length > 0`.
9. **`src/lib/reports/email-templates.ts`**: new `WarmupTemplateContext` +
   `buildWarmupTemplateContext` (aggregates gated mailboxes, keeps only the
   closest-to-ready one for the day counter). New `WARMUP_TEMPLATE`,
   deliberately outside the 7-template rotation (YAGNI). `pickTemplate`
   gained a required `useWarmupTemplate: boolean` 2nd parameter —
   `ReportEmailTemplateInput` gained a required `warmup: WarmupTemplateContext | null`.
   Fixed a latent bug in the plan's own `generate.test.ts` fixtures along
   the way: `mailboxId: 'm1'` fails the schema's real (unmocked)
   `.uuid()` check inside `generate.ts` — replaced with a valid UUID in
   both new tests before they could pass.
10. **`src/lib/reports/generate.ts`**: wires `now` into `buildReportMetrics`,
    `warmup` into both commentary calls, and template selection —
    `useWarmupTemplate = emailsSent === 0 && gatedMailboxes.length > 0`
    (narrower than "any mailbox gated": only fires when that's also *why*
    the numbers are near-zero).
11. **Report detail page** (`src/app/(app)/reports/[id]/page.tsx` + new
    `warmup-panel.tsx`): panel rendered from the *frozen* snapshot (so it
    reflects generation-time state, not live), right after `PageHeader`,
    shown only when `metrics.warmup` is non-empty — one-line summary +
    per-mailbox day-counter/reputation list.
12. **Full verification**: `pnpm test` — 216 files / **2359 tests**, all
    passing (+17 over the Tasks 1–6 checkpoint). `pnpm typecheck` clean
    repo-wide — also caught and fixed an out-of-plan caller,
    `scripts/test-fake-report.ts` (a manual preview script, unmocked
    `pickTemplate`/`renderTemplate` call), updated to the new 2-arg
    `pickTemplate` signature and `warmup: null`. `pnpm lint` clean (same 9
    pre-existing warnings, none in touched files). `en.json`/`tr.json` key-
    parity check passes — identical key sets, no English fallback left in
    Turkish.

Both `/home`, `/analytics`, and `/reports` are client-facing → every new
string got a real English and a real Turkish translation
(`reports.warmupPanel`), consistent with Tasks 1–6.

**Not verified (needs a real deploy, per plan §Task 12 Step 6):**
1. Apply migration `0042` to the live database.
2. Confirm a real `/api/pipeline/mailreach-sync` run populates the 5
   mailreach stat columns from the real Mailreach API (mocked unit tests
   can't prove this end-to-end).
3. Confirm `/home` banner + `/analytics` section render for a real
   mid-warmup client.
4. Trigger a real report generation and confirm the warmup email/panel
   framing appears when `emailsSent` is 0.
