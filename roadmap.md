# Roadmap — AI B2B Lead Generation & Outreach System

**Companion to:** `architecture.md`
**Date:** 2026-07-18

Phases are ordered so each one produces something demonstrable and de-risks the next. Email acquisition (the #1 risk) is proven early, in P1, before we build the agents that depend on it.

---

## P0 — Foundations

**Goal:** an authenticated Next.js app on Vercel + Supabase, with the full schema and mailbox connectivity, but no pipeline yet.

**Implementation plan:** `docs/superpowers/plans/2026-07-18-p0-foundations.md` (11 tasks, TDD, bite-sized steps). Not yet executed.

- [ ] Next.js app scaffolded, deployed to Vercel.
- [ ] Supabase project: Postgres schema for all tables in `architecture.md §5`.
- [ ] Supabase Auth + **Row-Level Security** policies (per-`client_id` isolation; operator role spans clients).
- [ ] Mailbox OAuth: connect a Gmail account (Gmail API) and an Outlook account (MS Graph); store tokens in `mailboxes`; send a test email from each.
- [ ] `events` audit-log helper used everywhere.
- [ ] QStash configured; a "hello" cron + signed-request verification proven end-to-end.
- [ ] Secrets management (Brightdata, Gemini, Emailable, QStash, OAuth) in place.

**Demo:** log in as an operator, connect a Gmail + Outlook mailbox, send a test email from each, see the event logged.

---

## P1 — Lead Gen + Verify + CRM View

**Goal:** leads flow in daily, get verified, group into cases, and appear in `/crm`. This validates the riskiest assumption (real, verifiable emails) before any outreach is built.

- [ ] Campaign setup UI (`/campaigns`): ICP, value prop, settings, mailboxes.
- [ ] **Lead-Gen Agent**: Brightdata MCP + Gemini grounding → candidate leads, deduped. (`/api/pipeline/discover`, daily QStash cron per active campaign.)
- [ ] **Email Acquisition + Verify** system: pull real addresses (no guessing) → **Emailable** → set `email_status`. `EmailVerifier` interface.
- [ ] **Grouping** system: deterministic company-key → case; 1+ verified person activates a case; optional LLM tiebreaker for ambiguous no-domain names.
- [ ] **/crm** page: pipeline board of cases + per-case people list, read-mostly, RLS-scoped.

**Demo:** create a campaign, run discovery, watch real verified leads group into cases and appear in `/crm`.
**Go/No-Go gate:** is real-address yield acceptable? If not, add an `EmailFinder` provider before P2.

---

## P2 — Research + Write + Send + Follow-ups

**Goal:** a case goes from "ready" to a sent cold email, with the 3/7/14-day follow-up cadence running.

- [ ] **Research Agent**: Brightdata + Gemini grounding → `case_knowledge` dossier with citations. (`/api/pipeline/research`, QStash fan-out.)
- [ ] **Email-Writer Agent**: full-context, human-sounding first-touch email. (`/api/pipeline/write`.)
- [ ] **Mailbox Sender**: rotation, `daily_cap`/`sent_today`, jitter, records `thread_id` + `provider_message_id`.
- [ ] Reply-mode gate: `auto_send` vs `human_approve` vs `hybrid`; drafts land in `/inbox`.
- [ ] **Follow-up sequencer**: QStash `delay` 3d → 7d → 14d; each step checks for a reply and cancels or advances; stop after step 3.
- [ ] Idempotency + QStash signature verification on every pipeline route.

**Demo:** a case is researched, a personalized email is drafted/sent, and a follow-up fires on schedule when there's no reply.

---

## P3 — Reply Handling + Knowledge Gap + Price Handoff

**Goal:** the system holds a real conversation and knows when to escalate or hand off.

- [ ] Reply detection: Gmail `watch` / Graph subscriptions → `/api/inbound/reply`, plus polling fallback + subscription renewal. Inbound pauses the sequence.
- [ ] **Reply Agent**: classify intent (question / interested / price / not-interested) using full thread + `case_knowledge`.
- [ ] Answerable → reply per reply-mode.
- [ ] **Knowledge-gap escalation**: create `knowledge_request` → notify client → human answer box in `/inbox` → AI ingests, writes, sends. Never fabricates.
- [ ] **Price handoff**: one booking-link reply → notify operator + client → `hot_handoff` → suppress + stop.
- [ ] Not-interested / opt-out → suppress + stop.

**Demo:** reply to an outbound email with a question, an unknown fact, and a price ask — see answer, escalation box, and handoff behave correctly.

---

## P4 — Deliverability Hardening + Observability

**Goal:** safe to run at real volume across multiple clients.

- [ ] Mailbox **warmup** ramp; per-mailbox `health` monitoring; auto-pause on `blocked`.
- [ ] Suppression enforcement across all send paths.
- [ ] Per-campaign / per-mailbox **kill-switch**.
- [ ] Bounce/complaint handling → suppression + health downgrade.
- [ ] Operator observability dashboard from `events`: per-campaign funnel (discovered → verified → cased → sent → replied → handoff), mailbox health, error rates.
- [ ] Runbook: renew subscriptions, rotate tokens, recover stuck sequences.

**Demo:** run several campaigns concurrently within caps; dashboard shows the funnel and mailbox health; kill-switch halts a campaign instantly.

---

## Later / Backlog (post-MVP)

- Dedicated `EmailFinder` provider if verified-address yield is low.
- Upstash Workflow for durable multi-step agent runs (only if needed).
- A/B testing of subject lines / openers.
- Client-facing notifications (email/Slack) beyond in-app.
- More reply intents (reschedule, referral to colleague, out-of-office detection).
- Self-serve client onboarding + billing (explicitly out of scope for MVP).

---

## Cross-Cutting (every phase)

- Write complete code — no placeholders, no stubs (per project `QUALITY.md` / `ANTI_LAZY.md`).
- Each new provider goes behind its interface (`architecture.md §10`).
- Every agent action and state change writes to `events`.
- RLS verified on every new table/query.
- Idempotency on every QStash-triggered route.
