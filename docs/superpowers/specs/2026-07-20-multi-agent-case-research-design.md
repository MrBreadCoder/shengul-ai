# Multi-Agent Case Research

**Date:** 2026-07-20
**Status:** Approved design, not yet implemented

## Problem

`runResearchForCase` (`src/lib/pipeline/research.ts`) currently runs one Brightdata
SERP search covering the whole case (company + all leads combined), then one LLM
call extracts a shared dossier from the top 8 snippets. Facts are shallow and
generic: every person on the case shares the same 8 snippets, there is no
per-person angle, and there's no way to go deeper than a single search — the
model gets one shot at whatever Google's SERP happened to return.

Goal: give each subject on a case (the company, and each active lead) its own
research agent that can search *and* read pages, producing a richer, more
personalized dossier — without changing anything downstream. `write.ts`,
`reply.ts`, and `knowledge-answer.ts` all consume the dossier purely through
`listKnowledgeForCase`, so they require zero changes.

## Architecture

`runResearchForCase` becomes an orchestrator. For a case with N active leads it
builds N+1 independent research tasks — one company task, one task per lead —
and runs them concurrently in-process via `Promise.allSettled`. No new QStash
routing: the existing one-message-per-case fan-out is unchanged: a single
function invocation still handles one case end to end, just with N+1 agents
running inside it instead of one shared call.

Each task is a **research agent**: a two-phase unit shared by both roles
(company vs. person differ only in seed query and system prompt text):

1. **Gather** — `generateText` with `tools: { search, scrape }` and
   `stopWhen: stepCountIs(4)` (the AI SDK's native multi-step tool-calling).
   The model can issue multiple searches, scrape a promising result, and
   decide when it has enough to stop, up to a 4-step budget. Produces
   free-text notes.
2. **Extract** — a `generateJson` call (reusing today's `dossierSchema` shape)
   turns those notes into structured `case_knowledge` entries, under the same
   anti-hallucination system prompt used today ("only facts backed by a
   snippet/page, cite sourceUrl or null, never invent").

The orchestrator merges entries from every *fulfilled* agent, inserts them all
via the existing `insertKnowledge`, and resolves case status per the
partial-failure rule below.

## Components

### `src/lib/research/brightdata.ts` (extended)

Add `scrape(url: string): Promise<string>` alongside the existing
`search(query)`. Same Brightdata API key, same `fetchJson` + `AppError`
pattern, same 8s-class timeout as `search`. Output is capped at
`MAX_SCRAPE_CHARS = 6_000` chars (truncate, don't reject) before it's ever
handed to a prompt — a full page can otherwise blow well past a reasonable
prompt budget.

### `src/lib/research/provider.ts` (extended)

`WebResearch` interface gains `scrape(url: string): Promise<string>` next to
`search`. `brightdataResearch` and any test fake implement both methods.

### `src/lib/research/tools.ts` (new)

AI SDK tool definitions (`tool({ description, inputSchema, execute })`)
wrapping `deps.research.search` and `deps.research.scrape`. Thin adapters,
no business logic. A failed `search`/`scrape` call is surfaced as a tool
result the model can see and route around (e.g. try a different query),
not a thrown exception that kills the whole agent's loop.

### `src/lib/research/agent.ts` (new)

```ts
export type ResearchAgentRole =
  | { kind: 'company'; companyName: string; companyDomain: string | null }
  | { kind: 'person'; lead: ResearchLead; companyName: string }

export async function runResearchAgent(
  context: LlmCallContext,
  deps: { research: WebResearch },
  args: { role: ResearchAgentRole; valueProp: string | null },
): Promise<AgentDossierEntry[]>
```

- `gather()`: builds the seed query + system prompt for the role (see
  "Seed queries & prompts" below), runs the tool loop, returns accumulated
  notes text.
- `extract()`: `generateJson` with `dossierSchema`, prompt = notes + subject
  context, same "never invent, cite sourceUrl or null" system prompt as
  today's `research.ts`.
- Role is a discriminated union so `gather`/`extract` share one code path;
  only the seed query and a short role-specific prompt fragment differ.

### `src/lib/pipeline/research.ts` (rewritten orchestration)

`runResearchForCase` builds `[companyTask, ...leadTasks]` from the case's
active leads, runs `Promise.allSettled`, and resolves per "Error handling"
below. `dossierSchema`, the top-level anti-hallucination system prompt text,
and the `insertKnowledge`/`updateCaseStatus`/`logEventSafe` calls are reused
essentially as-is from the current implementation.

## Seed queries & prompts

**Company agent** — seed query: `"{companyName} {companyDomain} news
funding"`. System prompt directs it to actively look for: industry/size/
product facts, recent news or funding, the company's LinkedIn/X presence and
recent posts/announcements, hiring/careers pages (growth or pain signals),
and public reviews or complaints (G2, Glassdoor) as pain-point signals. It can
issue further `search` calls for any of these within its 4-step budget and
`scrape` a specific promising page (e.g. the real "About" or careers page)
instead of trusting a two-line snippet.

**Person agent** (one per active lead) — seed query: `"{fullName}
{companyName} linkedin"`. System prompt directs it toward the person's role/
background and, explicitly, *recent public activity* — LinkedIn posts,
X/Twitter, interviews, conference talks, or articles quoting them — framed as
"look for something this specific person said or did recently: a genuine
personalization hook, not generic bio facts." If a search surfaces the person
specifically quoted or mentioned in an article, that's captured as a `news`
entry attributed to their research, not left to the company agent.

Social content (a LinkedIn post, an X thread) is classified into the
**existing** `knowledge_kind` enum (`company | person | news | pain_point`) by
the extraction step based on its substance — e.g. "posted about switching
CRMs" → `pain_point`, "announced a funding round" → `news`. No new enum value,
no DB migration.

## Merge behavior

The orchestrator flattens entries from every fulfilled agent into one list and
inserts them via the existing `insertKnowledge` — no extra tagging needed,
since `extract()` already sets `case_id`/`client_id`/`kind` per entry. **No
deduplication in v1**: company and person agents have distinct seed queries/
subjects, so near-duplicate entries are unlikely, and downstream consumers
(`write.ts`, `reply.ts`) already treat the dossier as a flat list of free-form
facts.

## Error handling

Each agent task is wrapped individually so one failure can't sink the others:

- A rejected agent (LLM timeout, Brightdata error, schema validation failure)
  is caught by `Promise.allSettled`, logged as `pipeline.research.agent_failed`
  with `{ caseId, role: 'company' | 'person', leadId?, errorCode }`, and simply
  excluded from the merged entries.
- **≥1 agent succeeded**: insert whatever entries came in, case → `'ready'`.
  A partial dossier is strictly better than none — `write.ts` already handles
  `(no dossier facts)` gracefully for whatever's missing.
- **All agents failed** (e.g. Brightdata is down entirely): do **not** flip
  the case to `'ready'` with an empty dossier — that would be silently
  indistinguishable from "we researched and found nothing." Leave the case in
  `'researching'` so the existing stuck-case sweep
  (`listStuckCases`/`find_stuck_cases` RPC) picks it up and retries later.
  Log `pipeline.research.completed` with `knowledgeCount: 0, agentsFailed: N`
  instead of a misleadingly successful-looking event.

This reuses machinery that already exists (the stuck-sweep job) rather than
inventing a second retry path.

## Scope / budget

- **Lead coverage**: every active lead on the case gets its own person agent
  (no cap) — cases are typically a handful of contacts per company, so this
  stays cheap in practice.
- **Step budget**: `stopWhen: stepCountIs(4)` per agent for the gather phase
  (mix of `search`/`scrape` calls). The extract call is a single
  non-agentic `generateJson` call, same token ceiling class as today
  (`MAX_OUTPUT_TOKENS = 1_400`).
- **Concurrency**: in-process `Promise.allSettled` within the single QStash-
  triggered `/api/pipeline/research` invocation — no new fan-out endpoints,
  no join/count-tracking logic needed.

## Testing

- **`brightdata.test.ts`**: add cases for `scrape(url)` — success, non-2xx,
  timeout, oversized body truncated to `MAX_SCRAPE_CHARS`.
- **`tools.test.ts`** (new): tool wrappers call `deps.research.search`/
  `scrape` with correct args; a failed call surfaces as a tool-result error,
  not a thrown exception.
- **`agent.test.ts`** (new): `runResearchAgent` with a mocked
  `generateText`/`generateJson` — verifies gather→extract wiring, the step
  budget is passed through, and company vs. person roles produce the right
  seed query/system prompt fragment.
- **`research.test.ts`** (rewritten): mock `runResearchAgent` at the module
  boundary. Cases: all agents succeed → merged dossier, `'ready'`; one of N
  person agents fails → partial dossier, `'ready'`, one `agent_failed` event;
  all agents fail → case stays `'researching'`, `knowledgeCount: 0` event, no
  `insertKnowledge` call with an empty array.
- `write.test.ts` / `reply.test.ts` / `knowledge-answer.test.ts`: unchanged —
  they depend only on `case_knowledge` rows existing, not on how research
  produced them.

## Explicitly out of scope (v1)

- Deduplication/overlap detection between agents' entries.
- A cap on the number of person agents per case.
- Authenticated/login-walled scraping (e.g. full LinkedIn profile pages
  behind auth) — only whatever Brightdata's SERP search and public-page
  scrape can reach.
- New `knowledge_kind` enum values for social-specific facts — social content
  is classified into the existing four kinds.
- QStash fan-out per agent (each agent is a Promise inside one function
  invocation, not a separate queued job).
