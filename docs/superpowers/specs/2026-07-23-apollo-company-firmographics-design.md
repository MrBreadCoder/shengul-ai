# Apollo Company Firmographics on Cases

**Date:** 2026-07-23
**Status:** Approved design, not yet implemented

## Problem

The Case page (`src/app/(app)/cases/[id]/page.tsx`) shows only `company_name`
and `company_domain` for the company a case represents. There is no
"what does this company do / how big is it" panel, and the AI email writer
(`src/lib/pipeline/write.ts`) has no firmographic context either — it only
sees whatever the web-research agent happens to dig up per case.

Apollo already gives this away for free. `bulkMatchPeople` (People
Enrichment, `POST /people/bulk_match`) is called for every candidate during
discovery (`enrichCandidates` in `src/lib/pipeline/discover.ts`) and its
response includes a full `organization` object — industry, employee count,
founded year, description, city/state/country. The current client
(`src/lib/apollo/client.ts`) only reads `name`, `primary_domain`, and
`website_url` off that object and throws the rest away.

Note: Apollo's plain **People Search** endpoint (`mixed_people/api_search`,
used for candidate discovery before enrichment) is deliberately locked down —
its `organization` sub-object is just `has_industry` / `has_revenue` /
`has_employee_count` booleans, not real values. Only the enrichment call
(already made, already paid for) carries real firmographic data. This design
adds no new Apollo call and no new cost.

## Vendor reference (Apollo `organization` object on `people/bulk_match`,
confirmed against Apollo API docs 2026-07-23)

Fields captured by this design (core firmographics, per operator decision —
see Decisions): `industry` (string), `estimated_num_employees` (number),
`founded_year` (number), `short_description` (string), `city` / `state` /
`country` (strings). All nullable/optional — Apollo does not guarantee any
of them are populated for a given company.

Explicitly out of scope for this pass: `annual_revenue` / `total_funding` /
`funding_events` (financials), `technology_names` / `current_technologies`
(tech stack), `publicly_traded_symbol`, `alexa_ranking`, `suborganizations`,
intent signals. See Out of scope.

## Decisions

Settled during brainstorming, not open questions:

1. **Field scope:** core firmographics only (industry, employee count,
   founded year, description, location). No financials, no tech stack.
2. **Fetch trigger:** during discovery, off the existing `bulkMatchPeople`
   response. No new Apollo endpoint, no new API call, no new cost.
3. **Storage:** a `case_knowledge` row (`kind: 'company'`). No migration, no
   new columns on `cases`. This is deliberately not a dedicated structured
   panel — it rides the existing Knowledge tab and the existing dossier
   pipeline into the AI prompt.
4. **Dedup:** check-before-insert. Before writing, query for an existing
   `kind: 'company'` row on the case; skip if one exists. Accepted risk: two
   `groupVerifiedLead` calls for the same brand-new case racing across
   concurrent discovery runs could both pass the check and both insert —
   the same class of risk the codebase already accepts elsewhere (this
   sequence is not wrapped in a DB-level constraint). Within a single
   discovery run this cannot happen: `discover.ts` calls `groupVerifiedLead`
   sequentially in a `for...of` loop, never concurrently.
5. **Summary format:** one plain-text sentence, not a labeled bullet list.
   Matches the free-text style of every other `case_knowledge.content` value
   (research-agent dossier entries are prose, not structured fields), so the
   Knowledge tab stays visually consistent and the writer's dossier
   (`k => \`- (${k.kind}) ${k.content}\``) reads as one more natural-language
   fact among the others rather than a formatting outlier.

## Architecture

No new module. Three existing files change, one new pure-function file is
added:

```
src/lib/apollo/
  client.ts                    # widen organizationSchema (modified)
  types.ts                     # widen ApolloEnrichedPerson (modified)
  format-company-summary.ts    # new: pure formatter
src/lib/db/
  case-knowledge.ts            # add insertCompanyKnowledgeIfMissing (modified)
src/lib/pipeline/
  group-lead.ts                # call the formatter + the new db function (modified)
  discover.ts                  # pass lead.raw through to groupVerifiedLead (modified)
```

`groupVerifiedLead` is the hook point because it is the one place in the
pipeline where a `caseId` first exists for a verified lead — see
`.claude/architecture.md §6` (Stage 2: a verified lead activates a case).
Nothing about case creation, lead grouping, or the write-stage dossier
assembly changes structurally; this only adds one more knowledge row to a
pipeline stage that already exists.

## Components

### `src/lib/apollo/client.ts` (modified)

Widen the shared `organizationSchema` (used by both `searchPersonSchema` and
`enrichedPersonSchema`):

```ts
const organizationSchema = z.object({
  name: z.string().nullable().optional(),
  primary_domain: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  estimated_num_employees: z.number().nullable().optional(),
  founded_year: z.number().nullable().optional(),
  short_description: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
}).nullable().optional()
```

`bulkMatchPeople`'s return mapping gains the matching fields, read off the
same `p.organization` already being destructured for `name`/domain:

```ts
organizationIndustry: p.organization?.industry ?? null,
organizationEmployeeCount: p.organization?.estimated_num_employees ?? null,
organizationFoundedYear: p.organization?.founded_year ?? null,
organizationDescription: p.organization?.short_description ?? null,
organizationCity: p.organization?.city ?? null,
organizationState: p.organization?.state ?? null,
organizationCountry: p.organization?.country ?? null,
```

`searchPeople`'s mapping is untouched — it never reads these fields, and
since Apollo's search response won't carry them anyway (see Problem), there
is nothing to gain by adding them there.

### `src/lib/apollo/types.ts` (modified)

`ApolloEnrichedPerson` gains the seven fields above, following the existing
flat `organizationName`/`organizationDomain` naming convention (not a nested
`organization` object — consistent with how the rest of the interface already
denormalizes Apollo's nesting):

```ts
export interface ApolloEnrichedPerson {
  // ...existing fields unchanged...
  organizationIndustry: string | null
  organizationEmployeeCount: number | null
  organizationFoundedYear: number | null
  organizationDescription: string | null
  organizationCity: string | null
  organizationState: string | null
  organizationCountry: string | null
}
```

`discover.ts`'s `enrichCandidates` already does `raw: { ...person }` when
building each `LeadInsert` — no change needed there. The new fields ride
along automatically inside `leads.raw` once the type carries them.

### `src/lib/apollo/format-company-summary.ts` (new)

Pure, no I/O, 100%-testable:

```ts
export interface CompanyFirmographics {
  industry: string | null
  employeeCount: number | null
  foundedYear: number | null
  description: string | null
  city: string | null
  state: string | null
  country: string | null
}

export function formatCompanySummary(
  companyName: string,
  firmographics: CompanyFirmographics,
): string | null
```

Returns `null` when every field is null — nothing worth writing, and the
caller must not insert an empty/junk knowledge row. Otherwise builds one
sentence, omitting any missing piece gracefully rather than emitting
"null" or an empty clause:

- All fields present: `"Acme Corp — Software industry, ~120 employees, founded 2016. Acme builds workflow automation for logistics teams. Based in Austin, TX, United States."`
- Partial (no description, no founded year): `"Acme Corp — Software industry, ~120 employees. Based in Austin, TX, United States."`
- Location-only: `"Acme Corp — Based in Austin, TX, United States."`

Location itself omits missing parts (`city`/`state`/`country` independently
optional): `state` alone renders `"Based in TX."`; `city` + `country` with no
`state` renders `"Based in Austin, United States."`

### `src/lib/db/case-knowledge.ts` (modified)

```ts
export async function insertCompanyKnowledgeIfMissing(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; caseId: string; content: string; sourceUrl: string | null },
): Promise<KnowledgeRow | null>
```

Queries `case_knowledge` for an existing row with `case_id = input.caseId
AND kind = 'company'` (`.limit(1)`); if found, returns `null` (skip, per
Decision 4). Otherwise inserts one row via the existing `insert` pattern
(matching `insertKnowledge`'s error handling — Supabase `{ data, error }`
destructured, mapped to `AppError('DB_ERROR', ...)` on failure):

```ts
{ client_id, case_id, kind: 'company', content, source_url, citation: 'Apollo', created_by: 'agent' }
```

### `src/lib/pipeline/group-lead.ts` (modified)

`LeadToGroup` gains `raw: Json` (the same `Json` type already on
`LeadRow['raw']`).

After the existing `findOrCreateCase` + `updateLeadCase` calls, before the
`pipeline.lead_grouped` log:

```ts
const org = parseCompanyFirmographicsFromRaw(lead.raw)
const summary = org ? formatCompanySummary(companyName, org) : null
if (summary) {
  try {
    await insertCompanyKnowledgeIfMissing(supabase, {
      clientId: lead.clientId,
      caseId: kase.id,
      content: summary,
      sourceUrl: lead.companyDomain ? `https://${lead.companyDomain}` : null,
    })
  } catch (error) {
    await logWarn({
      clientId: lead.clientId,
      caseId: kase.id,
      actor: 'system',
      type: 'pipeline.company_knowledge_failed',
      source: 'pipeline',
      error,
      payload: { leadId: lead.id },
    })
  }
}
```

`parseCompanyFirmographicsFromRaw` is a small Zod-validated extractor (new,
colocated in `group-lead.ts` — it is a one-shot boundary parse, not a
reusable client concern):

```ts
const rawOrgFieldsSchema = z.object({
  organizationIndustry: z.string().nullable().optional(),
  organizationEmployeeCount: z.number().nullable().optional(),
  organizationFoundedYear: z.number().nullable().optional(),
  organizationDescription: z.string().nullable().optional(),
  organizationCity: z.string().nullable().optional(),
  organizationState: z.string().nullable().optional(),
  organizationCountry: z.string().nullable().optional(),
}).passthrough()
```

`lead.raw` is `{ ...person }` where `person` is the already-mapped
`ApolloEnrichedPerson` (camelCase), not raw Apollo API JSON — despite the
column's name, so this schema mirrors `ApolloEnrichedPerson`'s field names,
not Apollo's snake_case wire format. `.safeParse()`; on failure (missing/old
`raw`, e.g. a lead inserted before this feature shipped) treat as "no
firmographics" and skip silently — this is not an error condition, just a
lead without this data.

Company-knowledge failure is deliberately isolated (own try/catch, `logWarn`
— best-effort, matching `logWarn`'s documented use for "a degraded-but-
handled condition") so it can never turn an already-successful case
grouping into a failed pipeline run. Mirrors the existing isolation pattern
one level up in `discover.ts` (`groupVerifiedLead` failures don't fail the
whole discovery run either).

### `src/lib/pipeline/discover.ts` (modified)

One-line change: the `groupVerifiedLead` call site inside the `for (const
lead of inserted)` loop passes `raw: lead.raw` alongside the existing
fields. `lead` is already a `LeadRow`, which already has `.raw` — no new
data is fetched.

## Data model

None. No migration. `case_knowledge.kind = 'company'` already exists in the
`knowledge_kind` enum (`src/types/database.ts:671`) and is already rendered
by the Case page's `KnowledgeItem` component in the existing Knowledge tab.

## Observability

- `src/lib/ui/log.ts` — add a `SENTENCE_BUILDERS` entry:
  ```ts
  'pipeline.company_knowledge_failed': (p) =>
    `Could not save Apollo company info for a case: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  ```
  (`logWarn` already appends `errorCode`/`errorMessage` to the payload, per
  `src/lib/events/log-event.ts`.)
- No new `LogSource` — `'pipeline'` already exists.

## Environment

None. No new API calls, no new vendor, no new env var.

## Testing

TDD, no network.

**`format-company-summary.test.ts`** — 100% coverage, pure function: all
fields null → `null`; every individual field present alone; all fields
present together; each combination of 1–2 missing location parts;
`employeeCount: 0` is a real value and must render (not treated as falsy/
missing — `??`/optional-chaining nullish checks, not truthiness checks).

**`client.test.ts`** (extended) — `bulkMatchPeople` maps all seven new
fields from a mocked `organization` object; a response where `organization`
is `null`/absent still parses (existing nullable behavior) and yields all
seven new fields as `null`.

**`case-knowledge.test.ts`** (extended) — `insertCompanyKnowledgeIfMissing`
returns `null` and does not call `insert` when a `kind: 'company'` row
already exists for the case; inserts and returns the row when none exists;
throws `AppError('DB_ERROR', ...)` on a Supabase error from either the
existence check or the insert.

**`group-lead.test.ts`** (extended) — `groupVerifiedLead` calls
`insertCompanyKnowledgeIfMissing` with a correctly formatted summary when
`lead.raw` carries firmographics; does not call it when `formatCompanySummary`
returns `null` (all-null firmographics); does not call it when `lead.raw`
fails schema validation (malformed/legacy data); still returns the case id
and does not throw when `insertCompanyKnowledgeIfMissing` rejects (isolation
matches the existing `logEvent`-failure test in this file).

## Documentation to update

`.claude/roadmap.md` — new entry, per the standing instruction to update it
on every increment.

## Out of scope

Deliberately excluded, each considered and rejected during design:

- **Financials** (`annual_revenue`, `total_funding`, `funding_events`) and
  **tech stack** (`technology_names`, `current_technologies`) — operator
  chose core firmographics only for this pass. Both are straightforward
  additions later: same `organizationSchema` widening, same formatter, same
  `case_knowledge` row — but that is a separate increment with its own
  approval, not assumed here.
- **Dedicated structured "Company" panel on the Case page.** Operator chose
  `case_knowledge` rows only; the existing Knowledge tab is the UI.
- **A dedicated Apollo Organization Search/Enrich API call.** Not needed —
  the data already arrives via the existing People Enrichment call at zero
  extra cost.
- **Upsert/refresh of stale firmographics.** Check-before-insert means a
  case's company info is captured once and never refreshed even if Apollo's
  data changes later. Accepted per Decision 4 — refreshing would need either
  a periodic re-enrichment job or a manual action, neither requested.
- **Backfill for existing cases.** This only fires on new verified leads
  going through `groupVerifiedLead`. Cases created before this ships (or
  whose triggering lead predates it) get no company-info row unless a new
  verified lead for that company arrives later.

## Risks

1. **Silent no-op for older leads.** Any lead inserted before this feature
   ships has a `raw` blob without the new fields; `rawOrgFieldsSchema` parses
   it fine (all seven fields are optional) but every field comes back
   `undefined` → `formatCompanySummary` returns `null` → nothing is written.
   This is correct behavior, not a bug, but means existing cases stay bare
   until a fresh verified lead re-triggers grouping for that company — which,
   for an already-activated case, may never happen again since
   `groupVerifiedLead` only runs per *newly verified* lead, not per case.
2. **Apollo firmographic coverage is inconsistent.** Smaller/lesser-known
   companies frequently have `null` for `industry`, `founded_year`, or
   `short_description` in Apollo's data. Expect a meaningful fraction of
   cases to get a short, sparse sentence (e.g. employee count only) or none
   at all — this is a data-availability limit, not an implementation gap.
