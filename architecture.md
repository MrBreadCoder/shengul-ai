# Architecture — AI B2B Lead Generation & Outreach System

**Status:** Approved design (v1)
**Date:** 2026-07-18
**Stack:** Next.js · Vercel AI SDK · Gemini · Brightdata (MCP) · Supabase (Postgres + Auth + RLS + Storage) · QStash · Emailable · Gmail API · Microsoft Graph

---

## 1. Purpose

An **agency-operated** system that, for each client, runs an end-to-end cold-outreach pipeline:

1. Discover leads daily (Brightdata + Gemini grounding).
2. Verify real email addresses (Emailable) — never guess.
3. Group people into a **case** per company.
4. Research each case into a rich dossier.
5. Write and send human-sounding cold emails.
6. Follow up on a 3 / 7 / 14-day cadence.
7. Handle replies — answer, escalate knowledge gaps to a human, or hand off on price.

The operator (agency) sets up each client campaign manually. Clients get a read-mostly CRM view of their pipeline.

---

## 2. Design Principles

- **No guessing.** Email addresses come from real sources and are verified by Emailable before any send. Facts the AI cannot establish are escalated to a human, never invented.
- **Human-sounding, not bulk.** Emails read like a person wrote them: personalized, no tracking pixels, no unsubscribe footer, no bulk markers.
- **Safety over legal compliance.** We protect deliverability (caps, throttling, warmup, suppression) rather than build a GDPR/CAN-SPAM legal layer.
- **Deterministic where possible, agentic where necessary.** Matching/keying/verification is plain code. LLM agents are used only where judgment or generation is required.
- **Every action is observable.** All agent decisions and state changes are written to an `events` audit log.
- **Provider interfaces are swappable.** Email verification, email discovery, mailbox providers, and the LLM are behind interfaces.

---

## 3. High-Level Diagram

```
                        ┌─────────────── Supabase (Postgres + Auth + RLS + Storage) ───────────────┐
                        │  clients · campaigns · leads · cases · case_knowledge · emails ·          │
                        │  sequences · knowledge_requests · mailboxes · suppressions · events       │
                        └──────────────────────────────────────────────────────────────────────────┘

  QStash cron (daily) ─▶ /api/pipeline/discover ─▶ Lead-Gen Agent  (Brightdata MCP + Gemini grounding)
                                    │
                                    ▼
                     Email Acquisition + Verify (system: sources + Emailable)
                                    │
                                    ▼
                     Grouping (system: company-key → Case; 1+ person = a case)
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

The system is **5 LLM agents + 2 deterministic systems + orchestration + frontend**.

| # | Component | Type | Responsibility |
|---|-----------|------|----------------|
| 1 | Lead-Gen Agent | LLM agent | Find companies matching the ICP and real people at them |
| 2 | Email Acquisition + Verify | System (code) | Pull real addresses from sources, verify with Emailable |
| 3 | Grouping | System (code + tiny LLM tiebreaker) | Key each lead to a company → create/attach case |
| 4 | Research Agent | LLM agent | Build the per-case dossier (company + people) |
| 5 | Email-Writer Agent | LLM agent | Compose personalized cold emails from case context |
| 6 | Reply Agent | LLM agent | Classify + respond to inbound; escalate or hand off |
| 7 | Mailbox Sender | System (code) | Send via Gmail/Graph with caps, throttle, warmup, rotation |
| 8 | Orchestrator | QStash + route handlers | Schedule, fan out, delay follow-ups, retry |

---

## 5. Data Model (Supabase Postgres)

All tables carry `client_id` and are protected by Row-Level Security so a client can only ever read its own rows. Timestamps (`created_at`, `updated_at`) are on every table.

### clients
The agency's customers.
`id · name · status · settings (jsonb) · created_at`

### campaigns
Belongs to a client. Holds targeting and behavior settings.
```
id · client_id · name · status(active|paused|archived)
icp: { industries[], geos[], company_size, target_titles[], keywords[] }
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
source · raw(jsonb)                         -- raw scrape payload
email · email_status(unverified|verified|invalid|risky|not_found)
email_verified_at · status(new|parked|active) · created_at
```

### cases
One per target company per campaign.
```
id · client_id · campaign_id · company_name · company_domain
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

### Stage 1 — Discovery (Lead-Gen Agent)
- Trigger: QStash daily cron → `/api/pipeline/discover`, one job per active campaign.
- Tools: Brightdata MCP (`search_engine`, `scrape_as_markdown`, `scrape_batch`), Gemini Google grounding.
- Output: candidate people matching the ICP, ≥1 per company (2+ preferred). Deduped against existing leads by `(campaign_id, linkedin_url|email|name+company)`.
- Writes: `leads` (status `new`), `events`.

### Stage 2 — Email Acquisition + Verify (system)
- Pull real addresses from available sources (Brightdata scrapes, company sources). **No pattern guessing.**
- Verify each with **Emailable**. Only `deliverable` → `email_status = verified` → lead becomes `active`.
- `invalid|risky|not_found` → lead `parked`, case flagged incomplete for that person.
- Provider interface `EmailVerifier` (Emailable now, swappable). Optional future `EmailFinder` interface for a dedicated finder.

### Stage 3 — Grouping (system)
- **Deterministic.** Key = `(campaign_id, company identity)`. Company identity resolved from `company_domain` first; fallback to normalized `company_name` (lowercase, strip legal suffixes like Inc/LLC/GmbH, collapse whitespace).
- Create case if none exists for the key; else attach lead. **A case activates with 1+ verified person.**
- Edge case: domain missing AND names ambiguous → a narrow single-shot LLM tiebreaker answers "same company? yes/no". This is the only LLM touch in grouping.
- Writes: `cases`, updates `leads.case_id`, `events`.

### Stage 4 — Research (Research Agent)
- Trigger: QStash fan-out per newly-ready case → `/api/pipeline/research`.
- Tools: Brightdata MCP + Gemini grounding.
- Builds: company dossier (what they do, recent news, likely pain points), per-person angle. Every fact carries a `source_url`/citation.
- Writes: `case_knowledge` (append-only), sets `cases.status = ready`.

### Stage 5 — Write & Send (Email-Writer Agent + Mailbox Sender)
- Trigger: QStash per ready case → `/api/pipeline/write`.
- The writer receives the **full case context**: campaign value prop, case dossier, per-person notes, any prior thread. Produces a personalized, human-sounding first-touch email (no bulk footer, no unsubscribe, no tracking pixel).
- Reply-mode gate:
  - `auto_send` → Mailbox Sender sends immediately (subject to caps/throttle).
  - `human_approve` → draft lands in `/inbox` for a human to send.
  - `hybrid` → treated as `auto_send` for first-touch (confidence high); escalation logic applies to replies.
- Mailbox Sender: pick a healthy mailbox (rotation), check `sent_today < daily_cap`, apply randomized delay/jitter, send via Gmail API / MS Graph, record `provider_message_id` + `thread_id`.
- On send: create/advance a `sequences` row and enqueue the first follow-up.

### Stage 6 — Follow-ups (Orchestrator)
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

- **Daily cron** (QStash schedule) → discovery, one message per active campaign.
- **Fan-out**: each case/lead stage is its own QStash message → its own Next.js route → one unit of work per invocation, so nothing hits Vercel's function time limit. QStash retries failed deliveries automatically.
- **Delays**: follow-ups use QStash `delay`. Each fired follow-up decides whether to enqueue the next.
- **Cancellation**: a reply cancels the pending QStash message (stored `qstash_message_id`) or the follow-up route no-ops when it sees the reply.
- **Idempotency**: every route is idempotent on `(entity_id, step)` so a retried delivery can't double-send. Signed QStash requests are verified at each endpoint.

---

## 9. Deliverability & Safety

- Per-mailbox `daily_cap` with a `sent_today` counter (reset daily); never exceed.
- Randomized send delays / jitter between messages.
- Warmup ramp for newly connected mailboxes (gradually increasing cap).
- Mailbox rotation across a campaign's connected accounts.
- Suppression on any reply, bounce, price-handoff, or opt-out language.
- Plain, personal formatting — no tracking pixel, no unsubscribe footer, no bulk headers.
- Per-campaign and per-mailbox **kill-switch**.
- Mailbox `health` monitoring (bounce/complaint rate) → auto-pause on `blocked`.

---

## 10. External Integrations (interfaces)

| Concern | Provider (v1) | Interface | Swappable |
|---------|---------------|-----------|-----------|
| Lead discovery / scraping | Brightdata (MCP) | `LeadSource` | yes |
| Web grounding | Gemini Google grounding | `Grounding` | yes |
| Email verification | Emailable | `EmailVerifier` | yes |
| Email discovery (future) | — | `EmailFinder` | planned |
| Sending / inbox (Google) | Gmail API | `MailboxProvider` | yes |
| Sending / inbox (Microsoft) | MS Graph | `MailboxProvider` | yes |
| Scheduling / delays | QStash | `Scheduler` | yes |
| LLM | Gemini via Vercel AI SDK | `LLM` | yes |
| Booking | Campaign `booking_link` (Cal.com/Google) | link field | yes |

---

## 11. Frontend (Next.js)

- **/crm** — client-facing, read-mostly. Cases as a pipeline board; per-case timeline showing the dossier, the full email thread, and status.
- **/inbox** — human action queue: approval drafts (`human_approve`/`hybrid`), open **knowledge requests** (the answer box), and hot handoffs.
- **/campaigns** — operator setup: ICP, value prop, reply/handoff modes, connected mailboxes, daily target.
- **/settings** — mailbox OAuth (Gmail/Outlook), per-mailbox caps, warmup, kill-switch.

Auth via Supabase Auth. RLS enforces per-client isolation on every query. Operators have an elevated role that spans clients.

---

## 12. Known Risks & Open Items

- **Email acquisition is the #1 risk.** LinkedIn rarely exposes addresses; "other sources" is unproven. If real-address yield is low, we add a dedicated `EmailFinder` provider (the interface exists for this). Until then, cases only send to Emailable-verified addresses and low-yield campaigns will simply produce fewer sends.
- **Reply detection reliability.** Gmail/Graph push subscriptions expire and must be renewed; a polling fallback is required for correctness.
- **Deliverability at scale.** Human-like sending caps throughput. Scaling means more warmed mailboxes, not higher per-mailbox volume.
- **QStash vs. durable workflow.** QStash covers scheduling/delay/retry. If multi-step agent runs need durable step state, Upstash Workflow can layer on without changing the model.

---

## 13. What This Design Deliberately Excludes (YAGNI)

- Self-serve client signup / billing (agency sets up clients manually).
- A legal compliance layer (GDPR/CAN-SPAM records, consent tracking).
- Visible unsubscribe management (by design — human-sounding sends).
- A dedicated worker service / Redis queue (QStash + route handlers suffice for MVP).
