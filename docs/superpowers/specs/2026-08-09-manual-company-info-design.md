# Manual company info replaces website-RAG "About our company"

## Problem

Every outbound-email pipeline stage (first-touch write, follow-up, redesign,
reply, knowledge-answer) injects an "About our company" block built by
embedding the current dossier/instruction and running a similarity search
over `client_knowledge_chunks` — a table populated by crawling the client's
website (sitemap.ts) and by uploaded resource files. The operator has no
direct control over what that block says: it's whatever the crawler scraped
and the embedding model judged most similar.

The operator wants direct control: a single free-text box they fill in per
client, injected verbatim, instead of automated website scraping.

## Decision

Add `clients.company_info` (nullable `text`), edited from a new dialog on the
client page. Every pipeline stage's "About our company" line now reads
`client.company_info` directly instead of calling
`retrieveClientKnowledge`.

## The reply.ts complication

`reply.ts` calls `retrieveClientKnowledge` for a second, unrelated reason:
finding a specific excerpt from an uploaded resource file that answers the
prospect's question, tagged `attachable #N` so the model can name it in
`attachResourceIds`. That lookup must survive — losing it would break the
"AI attaches the right file to a reply" feature.

`retrieveClientKnowledge` searches one table that mixes two source kinds:
website pages (`resource_id is null`) and resource files
(`resource_id is not null`). So the fix is a filter, not a removal: a new
`resourceOnly` option on `retrieveClientKnowledge` restricts matches to
`resourceId !== null` — i.e. it can now only ever surface content that came
from a file the operator explicitly uploaded as a sendable resource, never a
scraped web page. `reply.ts` keeps calling it, with `resourceOnly: true`,
under a separate prompt heading ("Company knowledge from files") distinct
from the manual "About our company" block.

`knowledge-answer.ts` also calls `retrieveClientKnowledge`, but never with
`resourceOrdinalById` — its attachments are resolved separately from a
human's explicit picks in `/inbox`. Its retrieval call serves no purpose
other than the background "About our company" text, so it's removed outright
like write/followup/redesign.

## Scope

- `company_info` is per-client, not per-campaign.
- The website-crawl knowledge base (`client_knowledge_sources`,
  `client_knowledge_chunks`, the Knowledge tab UI) is untouched — it still
  exists and still feeds `reply.ts`'s file-attachment matching for uploaded
  resources. Only its role as a source of "About our company" text is
  removed.
- Operator-only page (`/clients/[id]` 404s for non-operator roles) — the new
  dialog carries no i18n, matching `.claude/roadmap.md`'s "no translation on
  operator-only pages" rule.
