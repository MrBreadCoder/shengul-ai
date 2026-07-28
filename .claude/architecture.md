# Architecture — AI B2B Lead Generation & Outreach System

**Status:** Approved design (v2 — Apollo-based discovery/verify)
**Date:** 2026-07-18
**Stack:** Next.js · Vercel AI SDK · Gemini · Apollo.io API · Brightdata (MCP, P2 Research Agent only) · Supabase (Postgres + Auth + RLS + Storage) · QStash · Gmail API · Microsoft Graph

---

## 1. Purpose

An **agency-operated** system that, for each client, runs an end-to-end cold-outreach pipeline:

1. Discover ICP-matching people daily via **Apollo.io People Search + Enrichment**, which reveals and verifies each email in the same step — never guess, never use a separate verifier.
2. Group people into a **case** per company.
3. Research each case into a rich dossier.
4. Write and send human-sounding cold emails.
5. Follow up on a 3 / 7 / 14-day cadence.
6. Handle replies — answer, escalate knowledge gaps to a human, or hand off on price.

The operator (agency) sets up each client campaign manually. Clients get a read-mostly CRM view of their pipeline.

---

## 2. Design Principles

- **No guessing.** Email addresses come from Apollo's database, and an address only activates a lead if Apollo reports it `verified` **and** Emailable independently confirms it `deliverable` — never a pattern guess. Emailable only ever narrows: it can demote a lead Apollo verified, never promote one Apollo did not. Facts the AI cannot establish are escalated to a human, never invented.
- **Human-sounding, not bulk.** Emails read like a person wrote them: personalized, no tracking pixels, no unsubscribe footer, no bulk markers.
- **Safety over legal compliance.** We protect deliverability (caps, throttling, warmup, suppression) rather than build a GDPR/CAN-SPAM legal layer.
- **Deterministic where possible, agentic where necessary.** Discovery, verification, matching/keying is plain code (Apollo API + our own logic, no LLM). LLM agents are used only where judgment or generation is required (research, writing, replies).
- **Every action is observable.** All agent decisions and state changes are written to an `events` audit log.
- **Provider interfaces are swappable.** People discovery + email verification (Apollo), mailbox providers, and the LLM are behind interfaces or isolated client modules.

---

## 3. High-Level Diagram

```
                        ┌─────────────── Supabase (Postgres + Auth + RLS + Storage) ───────────────┐
                        │  clients · campaigns · leads · cases · case_knowledge · emails ·          │
                        │  sequences · knowledge_requests · mailboxes · suppressions · events       │
                        └──────────────────────────────────────────────────────────────────────────┘

  QStash cron (daily) ─▶ /api/pipeline/discover-fanout ─▶ one QStash message per active campaign
                                    │
                                    ▼
                     /api/pipeline/discover ─▶ Apollo People-Search + Enrich
                                    │            (finds ICP-matching people, reveals + verifies
                                    │             email in the same call — no LLM)
                                    ▼
                     Emailable /v1/verify (deliverability guard, no LLM)
                                    │            (only state=deliverable activates; risky,
                                    │             unknown, undeliverable are parked)
                                    ▼
                     Grouping (system: company-key → Case; 1+ verified person = a case)
                                    │
  QStash fan-out ──────▶ /api/pipeline/research ─▶ Research Agent (Brightdata + Gemini) → case_knowledge
                                    │
  QStash ──────────────▶ /api/pipeline/write ────▶ Email-Writer Agent → draft
                                    │
                       reply mode (per-campaign): auto-send │ human-approve │ hybrid
                                    ▼
       Gmail API / MS Graph  ◀── Mailbox Sender (throttle · jitter · caps · warmup · rotation)
                                    │
  QStash delay(3d/7d/14d) ─▶ /api/pipeline/followup ─▶ (no reply?) next step or stop
                                    │
  Gmail/Graph watch ───────▶ /api/inbound/reply ────▶ Reply Agent
                                    ├─ answerable      → draft / auto-send (per setting)
                                    ├─ knowledge gap   → Knowledge Request → notify human → ingest → send
                                    └─ price detected  → book-call reply + notify + case=Hot/Handoff → STOP
```

---

## 4. Component Inventory

The system is **3 LLM agents + 5 deterministic systems + orchestration + frontend**.

| # | Component | Type | Responsibility |
|---|-----------|------|----------------|
| 1 | Apollo People-Search + Enrich | System (code, no LLM) | Find ICP-matching people at target companies; reveal + verify each email via Apollo in the same pass |
| 2 | Emailable Deliverability Guard | System (code, no LLM) | Second-opinion verification of every Apollo-`verified` address; only `deliverable` activates a lead |
| 3 | Grouping | System (code + tiny LLM tiebreaker) | Key each lead to a company → create/attach case |
| 4 | Research Agent | LLM agent | Build the per-case dossier (company + people) |
| 5 | Email-Writer Agent | LLM agent | Compose personalized cold emails from case context |
| 6 | Reply Agent | LLM agent | Classify + respond to inbound; escalate or hand off |
| 7 | Mailbox Sender | System (code) | Send via Gmail/Graph with caps, throttle, warmup, rotation |
| 8 | Orchestrator | QStash + route handlers | Schedule, fan out, delay follow-ups, retry |
| 9 | Client Resources | System (code) + one Gemini read per file | Sendable client collateral (`client_resources`), attached to a reply as real MIME. Since `0019_resource_content.sql` each file's content is **also** derived at upload time — text extraction where the file has a usable text layer, Gemini vision for images and text-thin PDFs — and embedded into the client knowledge index through a companion `client_knowledge_sources` row linked by `resource_id`. The agent can therefore answer from a resource as well as send it, and a retrieved chunk from a resource in the current attach menu is labelled `attachable #N` so the model knows it may send the file the fact came from. This **reverses** the separation `0018` and the 2026-07-26 spec described; see `docs/superpowers/specs/2026-07-27-resource-content-design.md`. `src/lib/db/client-resources.ts`, `src/lib/resources/menu.ts`, `src/lib/resources/derive-content.ts`, `/api/pipeline/resource-read` |

> **Changed from v1:** the old "Lead-Gen Agent" (Brightdata + Gemini) is replaced by the Apollo People-Search + Enrich system. Emailable, dropped in v2, returned in v3 (2026-07-21) in a narrower role: it is no longer an email *acquisition* system, only a deliverability guard layered on top of Apollo's `verified` status. Brightdata + Gemini remain in the stack for the P2 **Research Agent only** (§6 Stage 3).

---

## 5. Data Model (Supabase Postgres)

All tables carry `client_id` and are protected by Row-Level Security so a client can only ever read its own rows. Timestamps (`created_at`, `updated_at`) are on every table.

Client-role sessions are read-only on every table **except two**, as of `0018_client_resources.sql`: they may insert `client_knowledge_sources` and `client_resources` for their own `client_id`, and may update or delete only rows whose `created_by` matches their own user id. See §11 for why the policy is not the enforcement point on those paths.

### clients
The agency's customers.
`id · name · status · settings (jsonb) · created_at`

### campaigns
Belongs to a client. Holds targeting and behavior settings.
```
id · client_id · name · status(active|paused|archived)
icp: { personTitles[], organizationLocations[], employeeRangeMin, employeeRangeMax, keywords[] }
     -- maps directly to Apollo People-Search filters (§10). `keywords[]` also carries
     -- any industry terms — Apollo's documented API has no separate industry filter,
     -- so industry signals are folded into the free-text `q_keywords` search term.
value_prop · booking_link
reply_mode(auto_send|human_approve|hybrid)
price_handoff_mode(book_call_and_notify|notify_only|configurable)
mailbox_ids[] · daily_target · created_at
```

### leads
A single person.
```
id · client_id · campaign_id · case_id(nullable)
full_name · title · company_name · company_domain · linkedin_url
source · source_id(nullable)                -- Apollo person id; unique per (campaign_id, source_id) for dedup
raw(jsonb)                                  -- full raw Apollo person object, for audit + future re-parsing
email · email_status(unverified|verified|invalid|risky|not_found)
email_verified_at · email_verification(jsonb)   -- Emailable verdict, or the
                                                -- recorded failure when the guard
                                                -- was unavailable (fail-open)
status(new|parked|active) · created_at
```

### cases
One per target company per campaign.
```
id · client_id · campaign_id · company_name · company_domain
company_key                                 -- deterministic dedup key: company_domain if known,
                                             -- else normalized company_name. Unique per (campaign_id, company_key).
status(new|researching|ready|contacted|in_conversation|hot_handoff|won|lost|dead)
summary · created_at · updated_at
```

### case_knowledge
Append-only enrichment. The "comprehensive context" fed to every agent.
```
id · case_id · kind(company|person|news|pain_point|answer)
content(text) · source_url · citation · created_by(agent|human) · created_at
```

### emails
Every message in and out.
```
id · client_id · case_id · lead_id · thread_id · provider_message_id
direction(outbound|inbound) · subject · body · status(draft|queued|sent|delivered|bounced|failed)
sequence_step(nullable) · mailbox_id · sent_at · created_at
```

### sequences
Drives follow-up cadence per lead.
```
id · client_id · case_id · lead_id
state(active|paused|stopped|completed) · current_step(0..3)
next_action_at · qstash_message_id · created_at · updated_at
```

### knowledge_requests
The escalation box.
```
id · client_id · case_id · lead_id · email_id
question(text) · status(open|answered|dismissed)
human_answer(text nullable) · answered_by · answered_at · created_at
```

### mailboxes
Connected sending accounts.
```
id · client_id · provider(gmail|outlook) · email_address · display_name
oauth(jsonb: tokens) · daily_cap · sent_today · warmup_state · health(ok|warning|blocked)
created_at
```

### suppressions
Do-not-contact.
`id · client_id · email · reason(replied|bounced|manual|price_handoff) · created_at`

### events
Audit log for observability.
`id · client_id · case_id(nullable) · actor(agent_name|system|human) · type · payload(jsonb) · created_at`

---

## 6. Pipeline Stages (detail)

### Stage 1 — Discovery + Verify (Apollo People-Search + Enrich)
- Trigger: QStash daily cron → `/api/pipeline/discover-fanout`, which loads every active campaign and publishes one QStash message per campaign to `/api/pipeline/discover`.
- **Deterministic system, no LLM.** Apollo REST API, base URL `https://api.apollo.io/api/v1`, `x-api-key` header auth (requires an Apollo plan with API + master-key access — see §12):
  1. `POST /mixed_people/api_search` — find candidates matching the campaign ICP (`personTitles`, `organizationLocations`, `employeeRange`, `keywords`). Free (no Apollo credits consumed); does not return email/phone.
  2. `POST /people/bulk_match?reveal_personal_emails=true` (≤10 people per call) — reveal each candidate's email plus Apollo's own `email_status`. Costs 1 Apollo credit per net-new verified email.
- Daily quota = `campaigns.daily_target` (default 50/day, per campaign), split into two search passes (`src/lib/pipeline/discover.ts`): pass 1 finds at most 1 person per brand-new company (up to half the quota); pass 2 runs a company-scoped Apollo search targeting every company — today's or an earlier day's — that currently has exactly 1 verified contact, trying to find a second person there for multi-threading. A company that never yields a second qualifying candidate still passes with 1. Candidates whose Apollo person id (`leads.source_id`) is already known for that campaign are skipped **before** the enrich call, so credits are only spent on genuinely new people.
- Apollo `email_status` → our `lead_email_status`: `verified`→`verified` (lead becomes `active`), `catch_all`→`risky`, `unverified`/`update_required`→`unverified`, `unavailable`/missing→`not_found`. Everything except `verified` stays `parked` — **never send to an unverified address.**
- **Emailable deliverability guard.** Every Apollo-`verified` lead with a non-empty email is re-checked against Emailable's `GET /v1/verify`; only `state: 'deliverable'` activates it. Emailable narrows only — it can demote a lead Apollo verified, never promote one Apollo did not. Any Emailable call failure blanket fails open onto Apollo's verdict (`src/lib/emailable/`, shipped 2026-07-21 — see §12).
- Writes: `leads`, `events`.

### Stage 2 — Grouping (system)
- **Deterministic.** Key = `(campaign_id, company_key)`, where `company_key` is `company_domain` (lowercased) if Apollo returned one, else the normalized `company_name` (lowercase, strip legal suffixes like Inc/LLC/GmbH, collapse whitespace). Stored on `cases.company_key` with a unique index, so lookup is an exact match, not fuzzy text search.
- Create case if none exists for the key; else attach lead. **A case activates with 1+ Apollo-verified person** — leads that are `parked` (not verified) are inserted but left unattached (`case_id` null) until a verified person for the same company arrives.
- Edge case: domain missing AND names ambiguous → a narrow single-shot LLM tiebreaker answers "same company? yes/no". This is the only LLM touch in grouping, and remains optional/backlog for P1 (Apollo reliably returns a domain for the large majority of organizations).
- Writes: `cases`, updates `leads.case_id`, `events`.

### Stage 3 — Research (Research Agent)
- Trigger: QStash fan-out per newly-ready case → `/api/pipeline/research`.
- Tools: Brightdata MCP + Gemini grounding. (This is the only remaining use of Brightdata/Gemini in the pipeline — discovery no longer uses them.)
- Builds: company dossier (what they do, recent news, likely pain points), per-person angle. Every fact carries a `source_url`/citation.
- Writes: `case_knowledge` (append-only), sets `cases.status = ready`.

### Stage 4 — Write & Send (Email-Writer Agent + Mailbox Sender)
- Trigger: QStash per ready case → `/api/pipeline/write`.
- The writer receives the **full case context**: campaign value prop, case dossier, per-person notes, any prior thread. Produces a personalized, human-sounding first-touch email (no bulk footer, no unsubscribe, no tracking pixel).
- Reply-mode gate:
  - `auto_send` → Mailbox Sender sends immediately (subject to caps/throttle).
  - `human_approve` → draft lands in `/inbox` for a human to send.
  - `hybrid` → treated as `auto_send` for first-touch (confidence high); escalation logic applies to replies.
- Mailbox Sender: pick a healthy mailbox (rotation), check `sent_today < daily_cap`, apply randomized delay/jitter, send via Gmail API / MS Graph, record `provider_message_id` + `thread_id`.
- On send: create/advance a `sequences` row and enqueue the first follow-up.

### Stage 5 — Follow-ups (Orchestrator)
- On each send, enqueue a QStash message with `delay` = 3d (step 1), then 7d (step 2), then 14d (step 3).
- On fire → `/api/pipeline/followup`: if a reply exists on the thread, cancel the sequence (`completed`). Otherwise send the next step's email (writer generates a context-aware nudge), advance `current_step`, enqueue the next delay. After step 3 with no reply → `sequences.state = stopped`, `cases.status = dead`.

---

## 7. Reply Handling

Reply detection: Gmail `users.watch` / Microsoft Graph change subscriptions push to `/api/inbound/reply` (with a polling fallback job). Any inbound immediately **pauses** the lead's sequence.

The **Reply Agent** loads the full thread + `case_knowledge` and classifies intent:

1. **Answerable question** → generate a reply.
   - `reply_mode = auto_send` → send it.
   - `human_approve` → draft to `/inbox`.
   - `hybrid` → send if confident; if not confident, escalate (below).
2. **Knowledge gap** (AI genuinely cannot answer — a real business fact it doesn't hold) →
   - Create a `knowledge_request` with the question.
   - Notify the client/operator (`/inbox` + notification).
   - A human types the real answer into the box (`human_answer`).
   - On answer, the AI ingests it (also stored as `case_knowledge`, kind `answer`), writes the email in its own voice, and sends per reply-mode.
   - **The AI never fabricates the missing fact.**
3. **Price / pricing intent** →
   - AI sends **one** call-booking reply using the campaign `booking_link`.
   - Notify operator **and** client.
   - `cases.status = hot_handoff`, add email to `suppressions` (reason `price_handoff`), **stop** the sequence. No further automated sends — a human owns it from here.
4. **Not interested / opt-out language** → add to `suppressions`, stop sequence, mark `cases.status = lost`.

---

## 8. Orchestration (QStash)

- **Daily cron** (QStash schedule) → `/api/pipeline/discover-fanout`, which reads all active campaigns and publishes one QStash message per campaign to `/api/pipeline/discover`.
- **Fan-out**: each case/lead stage is its own QStash message → its own Next.js route → one unit of work per invocation, so nothing hits Vercel's function time limit. QStash retries failed deliveries automatically.
- **Delays**: follow-ups use QStash `delay`. Each fired follow-up decides whether to enqueue the next.
- **Cancellation**: a reply cancels the pending QStash message (stored `qstash_message_id`) or the follow-up route no-ops when it sees the reply.
- **Idempotency**: every route is idempotent on `(entity_id, step)` so a retried delivery can't double-send. Signed QStash requests are verified at each endpoint.

---

## 9. Deliverability & Safety

- Per-mailbox `daily_cap` with a `sent_today` counter (reset daily); never exceed.
- Randomized send delays / jitter between messages.
- Warmup ramp for newly connected mailboxes — **shipped**: per-client
  `warmup_profile` (`standard` / `slow` / `none`), 5/day + 3/day, enforced inside
  `claim_mailbox_send`. See `src/lib/mailbox/warmup.ts`.
- Mailbox rotation across a campaign's connected accounts.
- Suppression on any reply, bounce, price-handoff, or opt-out language —
  **shipped**: enforced centrally in `sendViaMailbox`, not per caller.
- Plain, personal formatting — no tracking pixel, no unsubscribe footer, no bulk headers.
- Per-campaign and per-mailbox **kill-switch** — **shipped**, plus a per-lead
  stop available to client-role users.
- Mailbox `health` monitoring (bounce rate) → auto-pause on `blocked` —
  **shipped** via the 6-hourly `/api/pipeline/mailbox-health` sweep. Complaint
  rate is not observable per-mailbox; see `docs/runbooks/deliverability.md`.

---

## 10. External Integrations (interfaces)

| Concern | Provider (v2) | Interface | Swappable |
|---------|---------------|-----------|-----------|
| People discovery + email verification | Apollo.io API | `src/lib/apollo/client.ts` (direct client, not yet behind a formal interface) | in practice — call sites are isolated to the discovery pipeline |
| Web research (P2 Research Agent only) | Brightdata SERP API | `WebResearch` — `src/lib/research/provider.ts`, impl `src/lib/research/brightdata.ts` | yes |
| Web grounding (P2) | Gemini Google grounding | `Grounding` — (unimplemented; P2 uses Brightdata SERP above) | yes |
| Sending / inbox (Google) | Gmail API | `MailboxProvider` (send + fetchInbound) | yes |
| Sending / inbox (Microsoft) | MS Graph | `MailboxProvider` (send + fetchInbound) | yes |
| Scheduling / delays | QStash | `src/lib/qstash/client.ts` (`publishJson`, `publishJsonWithDelay`, `scheduleCron`) | yes |
| LLM | Gemini via Vercel AI SDK | `src/lib/llm/client.ts` (`generateJson`, `generateText`) | yes |
| Booking | Campaign `booking_link` (Cal.com/Google) | link field | yes |

---

## 11. Frontend (Next.js)

- **/crm** — client-facing, read-mostly. Cases as a pipeline board; per-case timeline showing the dossier, the full email thread, and status.
- **/inbox** — human action queue: approval drafts (`human_approve`/`hybrid`), open **knowledge requests** (the answer box), and hot handoffs.
- **/campaigns** — operator setup: client, name, value prop, booking link, Apollo ICP filters (`personTitles`, `organizationLocations`, employee range, `keywords`), daily Apollo quota (default 50). Reply/handoff modes and mailbox assignment stay at their schema defaults until P2 needs them in the UI.
- **/settings** — mailbox OAuth (Gmail/Outlook), per-mailbox caps, warmup, kill-switch.
- **/knowledge** — three tabs. *Facts* is the case-knowledge feed. *Sources* lists the pages and files the agent reads to answer from. *Resources* lists the files the agent may send to a lead who asks to see something. A client-role user curates their own rows on the latter two; an operator sees every client's, read-only, and uploads from `/clients/[id]` instead — `app_users.client_id` is null for operators, so there is no single client to scope an upload to.

Auth via Supabase Auth. RLS enforces per-client isolation on every query. Operators have an elevated role that spans clients.

**Client-role writes are not enforced by RLS.** The four routes that accept them — resource upload and delete, knowledge file upload and source delete — use `createAdminClient()`, which bypasses RLS entirely, as every other write path in the app does. `src/lib/auth/can-manage-client.ts` (`canManageClient`, `canManageOwnRow`) is therefore the whole authorization boundary on those paths; the policies added in `0018` only cover a hypothetical session-bound client. Never add a client-writable route without that guard.

---

## 12. Known Risks & Open Items

- **Apollo dependency (replaces the old "email acquisition" risk).** Discovery and verified-email yield now depend entirely on Apollo's database coverage and its own verification accuracy (Apollo publishes ~84% email match rate and >90% accuracy on `verified` emails). `/mixed_people/api_search` and `/people/bulk_match` both require an Apollo plan with API **and master-key** access — this must be provisioned (a real `APOLLO_API_KEY`) before P1 can run against live data. If verified-yield for a client's ICP is too low, backlog options are: (a) a secondary verifier layered on top of Apollo's `verified` status, or (b) a dedicated `EmailFinder` provider. Option (a) **shipped on 2026-07-21** as the Emailable deliverability guard (`src/lib/emailable/`). It was adopted for bounce protection rather than for yield: it narrows the activated set and never widens it, so if verified-yield is ever the problem, option (b) — a dedicated `EmailFinder` provider — remains the answer.
- **Fail-open verification gap.** Any Emailable failure — including a persistent `402` (out of credits) or `403` (rotated key) — activates the lead on Apollo's word alone, by explicit operator decision on 2026-07-21. Discovery never stalls, but bounce protection is off for the duration. The only signals are `emailable.verify.failed` error events and the `emailableFailedOpen` counter on `pipeline.discover.completed`; `leads.email_verification` is the durable per-lead record, since events are purged at 30/90 days. Revisit with real bounce data.
- **Apollo API response-shape ambiguity.** Apollo's public docs are inconsistent about exact field names for `/mixed_people/api_search` and `/people/bulk_match` (e.g. `matches` vs `people`, where `email_status` nests). The client (`src/lib/apollo/client.ts`) parses defensively — accepts either wrapper key, falls back across the documented field paths — and stores the full raw response in `leads.raw` for audit and future re-parsing. Reconcile the schema against a real sandbox response (gated integration test, see the P1 plan) the first time a real `APOLLO_API_KEY` is available.
- **Reply detection reliability.** Gmail/Graph push subscriptions expire and must be renewed; a polling fallback is required for correctness.
- **Deliverability at scale.** Human-like sending caps throughput. Scaling means more warmed mailboxes, not higher per-mailbox volume.
- **QStash vs. durable workflow.** QStash covers scheduling/delay/retry. If multi-step agent runs need durable step state, Upstash Workflow can layer on without changing the model.

---

## 13. What This Design Deliberately Excludes (YAGNI)

- **Re-verification of stale or fail-open leads.** The guard runs once, at discovery. There is no staleness re-check before follow-up sends and no automatic re-verification of leads activated while Emailable was unavailable.
- **Score thresholds and shape-based blocking** (`role`, `disposable`, `no_reply`, `mailbox_full`). These fields are stored on `leads.email_verification` but the policy branches on `state` alone.
- Self-serve client signup / billing (agency sets up clients manually).
- A legal compliance layer (GDPR/CAN-SPAM records, consent tracking).
- Visible unsubscribe management (by design — human-sounding sends).
- A dedicated worker service / Redis queue (QStash + route handlers suffice for MVP).
