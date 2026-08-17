# Roadmap — AI B2B Lead Generation & Outreach System

**Companion to:** `architecture.md` (system design/architecture lives there — this file tracks progress, not design).

The product: Apollo-sourced leads → AI research → AI-written cold email → 3/7/14-day
follow-up cadence → AI reply handling with human escalation for price asks and unknown
facts. Multi-client, deliverability-hardened, with an operator console and a read-mostly
client view.

---

## Phase Status

| Phase | Goal | Status |
|---|---|---|
| P0 — Foundations | Next.js + Supabase + RLS, mailbox OAuth (Gmail/Outlook), QStash, `events` audit log | DONE |
| P1 — Discovery | Apollo search + bulk-match (email reveal + verification in one call) → company-grouped cases → `/crm` | DONE |
| P2 — Research/Write/Send/Follow-up | Per-case research dossier → AI-written first email → rotated-mailbox send → 3/7/14-day follow-up sequencer → `/inbox` human-approval | DONE |
| P3 — Reply Handling | Inbound mailbox polling (Gmail History API / Outlook delta) → intent classification → price/not-interested/question routing → knowledge-gap escalation | DONE |
| P4 — Deliverability + Observability | Warmup ramp, bounce-rate health + auto-pause, DSN/OOO detection, suppression enforcement, kill switches, `/analytics` dashboard | DONE |

Apollo's bulk-match replaced the original separate Brightdata+Gemini lead-gen agent and
Emailable-only verification — one deterministic, mostly-LLM-free pipeline. Emailable was
later reintroduced as a *second-opinion* deliverability guard layered on top (see log).

---

## Backlog / Not Started

- Dedicated `EmailFinder` provider or a full secondary verifier, if Apollo+Emailable yield is ever insufficient.
- Upstash Workflow for durable multi-step agent runs (only if the current QStash-fanout approach hits a wall).
- A/B testing of subject lines / openers.
- Client-facing notifications (email/Slack) beyond in-app.
- More reply intents: reschedule, referral to a colleague.
- Self-serve client onboarding + billing — explicitly out of scope for MVP.

---

## Known Open Items

- **Cases show `contacted` before a human approves.** `runWriteForCase` sets the case to
  `contacted` unconditionally once the leads loop finishes, regardless of whether the
  outcome was `sent` vs `drafted`. For `human_approve` clients this makes
  `analytics_by_campaign` report cases as contacted before anyone approved the draft.
  Distinct from the earlier "claimed contacted before write ran" bug (fixed 2026-08-12) —
  this is the unconditional end-of-function write. Flagged 2026-08-13, not yet fixed.
- **No automated retention purge for `events`.** `deleteExpiredEvents` (`src/lib/db/events.ts`)
  exists but is never called by a cron/route — the table has no wired-up sweep.
- **Legal documents need counsel review.** Privacy Notice, Terms, DPA, etc. (`/legal/*`,
  rewritten 2026-07-25) reflect the system's real behavior but the legal positions
  (legitimate-interests basis, arbitration clause, liability cap, SCC elections) have not
  been reviewed by a lawyer.
- **Person-level research is disabled** via a feature flag (not deleted) as of 2026-08-11 —
  see log entry for why. Re-enabling requires revisiting the guardrails that shipped
  alongside the flag.

---

## Log

Chronological, most recent last. Entries are one-line unless a decision or an open
question needs to survive.

- **2026-07-20** — Fixed 10 code-review findings across the inbound/reply pipeline (pagination cursor safety, idempotent knowledge-answer retry, ambiguous-lead-match fail-closed, timeout race, etc).
- **2026-07-20** — Replaced the single shared research call with **one agent per subject** (company + each active lead), run concurrently, each citing its own sources into `case_knowledge`.
- **2026-07-21** — Fixed a prod-crashing bug where the server env schema (`src/lib/env.ts`) was being bundled into client code; split into `env.ts` (server) / `env-public.ts` (client-safe, literal `NEXT_PUBLIC_*` access so Turbopack inlines it).
- **2026-07-21** — First real design system: Tailwind v4 + shadcn/ui + Phosphor icons, dark-default. Built the `/cases/[id]`, `/mail`, `/knowledge` surfaces that already had DB support but no UI. Found and fixed a real RLS bypass: `/settings` was listing every client's mailboxes via the admin client with no filter.
- **2026-07-21** — `/clients` admin page + invite-link account provisioning (Supabase `generateLink`), then rebuilt into `/clients/[id]` as a header+tabs workspace (Campaigns/Analytics/Users) mirroring the case-detail UI, with pause/resume/archive/delete lifecycle actions and a 2-step confirm on the destructive ones. Pausing a client now also stops in-flight research/write/follow-up, not just new discovery.
- **2026-07-21** — Gemini calls gained an opt-in `thinkingLevel`; set to `medium` for the research agent's gather step and reply classification (judgment-heavy), left at default elsewhere.
- **2026-07-21** — Client-scoped error logging: every Gemini/Apollo/Brightdata/mailbox failure is now attributed to a client and severity-tagged (`events.severity`/`source`), surfaced later as the operator Logs tab.
- **2026-07-21** — Emailable deliverability guard shipped: a second-opinion check layered on top of Apollo's own `email_status`, fail-open on Emailable errors. Loosened 2026-08-08 (see below) after production data showed the strict policy parking too many address-unconfirmable-but-fine catch-all domains.
- **2026-07-23** — Apollo's existing bulk-match response already carries company firmographics (industry, headcount, founded year, description) — now captured into `case_knowledge` at zero extra API cost.
- **2026-07-23** — Client knowledge base: operator uploads/crawls a client's website + PDFs, chunked and embedded (pgvector), retrieved and injected into the write/follow-up/reply/knowledge-answer prompts. Similarity floor (0.5 cosine) added same day to stop weakly-related chunks leaking in.
- **2026-07-24** — Public marketing page at `/` (previously just redirected to `/crm`), copy written to sell the outcome not the machinery — no vendor names, no multi-client framing.
- **2026-07-25** — Brand rename Beacon → Shengul AI across all user-visible surfaces; typeface Geist Sans → Inter.
- **2026-07-25** — AEO/SEO pass: `robots.txt`/`sitemap.xml`/`llms.txt` were actually 302ing to `/login` (audit was scoring a login page as "present") — fixed the middleware matcher; added AI-crawler allowlist, canonical URLs, OG images, JSON-LD, FAQ schema.
- **2026-07-25** — Legal documents (`docs/legal/`) were describing an entirely different product ("Founderside AI", Stripe billing, free trial) and were never linked into the app. Rewrote all 7 documents to describe this system's real data flows and served them at `/legal/<slug>`. Needs counsel review — see Known Open Items. Contact details updated 2026-08-12 to the real operating domain (`shengulai.com`).
- **2026-07-25** — WebMCP: registered read-only tools + declarative-mutation form annotations so a browsing agent can act on the console pages without ever getting write access via a tool call directly.
- **2026-07-26** — Fixed QStash-driven pipeline workers being redirected to `/login` (405s, burning all retries) and a separate outage where invite links opened the marketing page instead of signing the user in.
- **2026-07-26** — Invite links changed from single-use to reusable within a fixed window.
- **2026-07-26 / 2026-07-28** — AI Resources: client collateral (one-pagers, case studies) the agent can attach and send; the agent now reads the actual resource file content (not just its title) when deciding what to send.
- **2026-07-28** — Client notes (internal, not sent) + client-written manual email composer added to the case thread.
- **2026-07-29 → 2026-08-13** — Mailreach warmup integration: connect a mailbox to Mailreach, gate new campaign sends until 14 days of warmup, surface warmup status in `/settings` and Reports. Iterated across several passes (initial schema/client Aug-29, SMTP-connect 404 fix Aug-04, per-client API key Aug-12, full status surfacing Aug-13, sync cadence tightened 6h → 10min Aug-13).
- **2026-07-29** — Google Tag Manager + Consent Mode v2 installed; caught that the published cookie/privacy policies claimed "no tracking, no consent banner" — rewrote those docs to match reality instead of leaving GTM undisclosed.
- **2026-08-02** — CRM integrations: HubSpot and Pipedrive two-way sync (OAuth connect, `/settings/crm`, background sync worker), shipped across 13 tasks.
- **2026-08-03** — Case Mail split into per-contact tabs; reply mode (`auto_send`/`hybrid`/`human_approve`) made client-configurable; CRM settings moved into the main `/settings` page.
- **2026-08-03** — Per-mailbox warmup caps made configurable (was a single hardcoded ramp).
- **2026-08-04** — Knowledge-base retrieval upgraded to hybrid (vector + keyword) search; added a "re-scrape all" button; mailbox connect opened up to client-role users (previously operator-only).
- **2026-08-05** — Discovery pipeline precision/cost pass (6 tasks); inbox draft gained an AI-redesign box plus manual editing; follow-up cadence (3/7/14-day) made configurable per campaign.
- **2026-08-06** — Dashboard localized to English/Turkish (18 tasks); lazy-start warmup ramp (a new mailbox doesn't start ramping until first real send); campaign settings became editable with a read-only client view.
- **2026-08-07** — Diagnosed a QStash-cron outage: all pipeline crons had silently stopped since 08-04 (fixed). Shipped per-client/per-campaign discovery scheduling (a client or campaign can now run discovery at a specific time/timezone instead of one global cron), fixed the company research agent's search tool always failing, and added a depth-first retry loop to discovery.
- **2026-08-07** — Client contact signature (phone + address) added to outbound emails.
- **2026-08-08** — Diagnosed two live production error clusters from the Logs tab (email-write JSON truncation; Bright Data search/scrape aborts) — root-caused and iterated on through 2026-08-10, see below. Upgraded the human-voice email prompt to pattern-based rules with a regeneration preview tool. Shipped a per-client formal-intro email style, applied to Uniforms Fashion (rewrote its 8 pending drafts).
- **2026-08-08** — Emailable accept-all catch-all carve-out: production data showed the `risky` bucket was 100% domain-level "can't confirm" (`accept_all: true`), not address-level bad — now activates that specific case instead of parking it. Two follow-up fixes landed within days: a stranded-lead bug where `listActiveLeadsForCase` still required `email_status = 'verified'` after the carve-out, and a client-facing label fix so a catch-all-activated lead reads "Verified" to the client (still "Risky" to the operator).
- **2026-08-09** — Closed 5 prompt gaps in the formal-intro system prompt; every email-writing agent switched to `gemini-3.6-flash`. Email styles made editable/addable via a DB-backed CRUD + UI (was hardcoded). Manual company-info field added to replace the auto-generated website-RAG "About our company" blurb (more control, less risk of a bad scrape summary reaching a prospect). `write.ts`/`redesign.ts` thinking level flipped `minimal` → `medium` — this is what caused the Cluster A truncation bug fixed the next day.
- **2026-08-10** — New `contactsPerCompany` campaign setting, fixing a bug where discovery was silently capping near 1 lead per company. Error-cluster fixes: **Cluster A** (Gemini `generateObject` truncation on write/redesign) fixed by raising the output-token ceiling 1,600 → 2,600. **Cluster B** (Bright Data search/scrape aborts) mitigated by raising every timeout in the request path — the actual fix (a concurrency cap on Bright Data calls) was explicitly deferred, later shipped 2026-08-15. Research-agent system prompts rewritten to stop hallucinated facts and to trust Apollo's own data instead of re-verifying it. Extraction step downgraded to `flash-lite` and scrape truncation tightened, both for cost. Also: campaign time-picker validation bug fixed, campaign save errors now surface which field failed.
- **2026-08-11** — Fixed a formal-intro false-footprint claim and an isolated-fact regression; tightened dossier fact-selection and negative-fact guardrails globally. **Disabled person-level research** behind a feature flag (not deleted) — see Known Open Items. Shipped the Client Home Dashboard, then a visual redesign of it same week.
- **2026-08-12** — Root-caused irrelevant email hooks for Uniforms Fashion's school-uniform campaigns and fixed it. Reports (weekly + monthly digests) shipped across 18 tasks. Pipeline latency reduced by chaining stages event-driven instead of waiting for the next cron tick. Fixed a case being claimed `contacted` before the write actually ran, and a Gemini-overload long-retry issue.
- **2026-08-13** — Landing page hero rewritten with a live-animated outcome panel. Turkish i18n + language switcher shipped for the landing page (13 tasks). Campaign mailbox picker UI added — surfaced (and backfilled) a real bug: every Uniforms Fashion campaign had `mailbox_ids: []` with no UI to ever set it, silently stranding approved drafts. In the same investigation, found the still-open unconditional-`contacted` bug (see Known Open Items). Fixed a schema bug where Emailable's `score: null` (vs. omitted) crashed validation, and added Apollo confidential-org redaction handling. Investigated a reported "Ryanair dedup not working" — confirmed correct behavior, no fix needed. Fixed discovery depth-phase freshness-cap and breadth-quota starvation bugs, plus a company-key desync and an unsafe cast found in the same review.
- **2026-08-14** — Per-campaign contact-signature override; code-review fixes for `contactsPerCompany` capacity enforcement and the live-discovery test script.
- **2026-08-14 / 2026-08-15** — Person + company social scraping: Bright Data LinkedIn/X post scraping keyed to Apollo-verified profile URLs, attributed per-lead (`case_knowledge.lead_id`) so a fact about one lead can't leak into another lead's dossier on the same case. Code review after shipping added a DB trigger enforcing the lead's `case_id`/`client_id` actually matches the knowledge row (previously silently un-enforced) and switched the FK to `on delete cascade` (was `set null`, which would have let a deleted lead's fact resurface as "company-wide").
- **2026-08-15** — Concurrency limiter added for Bright Data calls (`BRIGHTDATA_MAX_CONCURRENT = 5`, shared FIFO semaphore across search/scrape/social-discovery) — closes the Cluster B gap flagged 2026-08-10.
- **2026-08-15** — Per-campaign email templates: the client-only `email_styles`/`email_style_id` mechanism (2026-08-08/09) was renamed to `email_templates`/`email_template_id` (migration 0046) and given a `campaigns.email_template_id` override — same nullable-inherit convention as the signature override (2026-08-14). The row's content model also changed: it's now a literal reference email the operator pastes verbatim (client's own words), not abstract voice instructions — `write.ts`'s `buildSystemPrompt` wraps whatever text is there with a fixed "personalize this, don't copy it verbatim, resolve [bracketed] placeholders, pick the matching example if there's a `---`-separated multi-sample template" instruction, so the two original rows (Concise/Formal introduction, still instruction-prose) keep working unchanged. Seeded and assigned 6 of Uniforms Fashion's 8 live campaigns with the operator's real hand-written templates (Public Safety, Border & Aviation Security, Defense Prime Contractor, Transport & Ground Ops, Hospitality & Travel, Cargo & Courier — the last three each concatenate 2-3 sub-vertical samples per operator instruction). Healthcare Sector and Schools deliberately left on the client-level default — no matching sample yet, per the existing 2026-08-15 ICP-doc gap. Applied directly to prod (operator ran the migration; this session's `supabase migration list` found 0001-45 untracked in the remote history table, so a plain `db push` was avoided as unsafe). `regenerate-sample-emails.ts`/`rewrite-draft-emails.ts` updated to resolve the same campaign→client→default precedence via the new exported `resolveEmailTemplate` instead of duplicating it.
- **2026-08-15** — Client account-creation invites: TTL raised 2 hours → 3 days (`INVITE_TTL_MINUTES`, `formatInviteTtl` now day-aware); the invite link is now emailed to the client automatically (new `lib/auth/invite-email.ts` template, sent via the existing `lib/reports/mailer.ts` SMTP sender) instead of only being shown for the operator to copy. Send is best-effort — SMTP failure doesn't roll back the created login, the response/UI carry an `emailSent` flag so the operator falls back to the still-present copy button when delivery fails.
- **2026-08-16** — Fixed a client-reported "wrong warmup day" bug: `MailboxWarmupInfo.elapsedDays` (0-indexed, from `mailreach-gate.ts`) was being shown directly as "Day N" on the home banner, Reports/Analytics warmup panels, and the report-commentary LLM prompt/fallback/email template, while the settings/warmup-tab daily-cap ramp counter used a 1-indexed `dayNumber` (`elapsedDays + 1`) for the same concept — two different "Day N" meanings depending which screen a client looked at. Added `dayNumber` to `MailboxWarmupInfo` and switched every display call-site to it; `elapsedDays` stays 0-indexed internally for gating/ordering math only. `WarmupTemplateContext.closestElapsedDays` renamed to `closestDayNumber` to match.
- **2026-08-17** — Rolled the existing `RealtimeRefresher` pattern (already live on `/analytics`/`/home`) out to `/mail`, `/crm`, and `/inbox` — each now carries a pulsing "Live" badge and refreshes on relevant Supabase Realtime `postgres_changes` events (debounced `router.refresh()`), so new leads/mail/knowledge-requests appear without a manual reload. Added migration `0047` putting `knowledge_requests` into the `supabase_realtime` publication (`emails`/`leads`/`cases` were already in it since migration `0008`) and extended the shared refresher component to also listen for `knowledge_requests` INSERT/UPDATE.
- **2026-08-17** — Follow-up audit found the same gap in three more places, one of them a real bug: `client_knowledge_sources` was never added to the `supabase_realtime` publication, so `/clients/[id]`'s knowledge-scrape-status refresher had been silently dead since it shipped (a `postgres_changes` subscription on a table outside the publication never fires — Supabase drops it). Migration `0048` adds `case_knowledge`, `client_knowledge_sources`, and `client_resources` to the publication. Shipped: `KnowledgeSourcesRealtimeRefresher` (moved out of `clients/[id]` into `components/`, `clientId` now optional so `/knowledge/sources` can reuse it unfiltered across every visible client), `CaseKnowledgeRealtimeRefresher` for `/knowledge`, `ResourcesRealtimeRefresher` for `/knowledge/resources`, and a case-scoped `CaseRealtimeRefresher` (800ms debounce, shorter than the 1.5s dashboard default since this is the page open mid-conversation) for `/cases/[id]` watching its own case's emails/leads/knowledge/knowledge_requests plus the case row itself. All four pages now carry the same "Live" badge as the rest. Migrations `0047` and `0048` still need to be applied to prod (operator-run, per the established convention).
