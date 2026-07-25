# Legal documents

The published documents live in **`src/lib/legal/documents/`** and are served at `/legal/<slug>`.

They used to sit here as `.txt` files. Those files described a different product — an
AI co-founder chat app called Founderside AI, with Stripe billing, Google Analytics,
social login and a public forum, none of which exists in this system — and they were
never wired into the app, so nothing linked to them and nobody read them. They have
been replaced rather than corrected.

## Why the copy is TypeScript

A policy that exists in two places drifts, and a privacy notice that disagrees with
itself is worse than not having one. There is exactly one copy of each document, it is
type-checked, and `src/lib/legal/registry.test.ts` fails the build if a document
cross-references a sibling that does not exist, if a table row is ragged, or if a meta
description falls outside the site's length window.

## The documents

| Document | Slug | Source |
|---|---|---|
| Privacy Notice | `privacy-policy` | `src/lib/legal/documents/privacy-policy.ts` |
| If you received an email from us | `outreach-privacy-notice` | `src/lib/legal/documents/outreach-privacy-notice.ts` |
| Cookie Notice | `cookie-policy` | `src/lib/legal/documents/cookie-policy.ts` |
| Terms of Service | `terms-of-service` | `src/lib/legal/documents/terms-of-service.ts` |
| Acceptable Use Policy | `acceptable-use-policy` | `src/lib/legal/documents/acceptable-use-policy.ts` |
| Data Processing Addendum | `data-processing-addendum` | `src/lib/legal/documents/data-processing-addendum.ts` |
| Subprocessors | `subprocessors` | `src/lib/legal/documents/subprocessors.ts` |

## Changing a document

1. Edit the document module. Bump its `updatedAt` when the change is substantive —
   that date is what the page shows and what the sitemap reports.
2. Contact and entity details are in `src/lib/legal/contact.ts` and are carried over
   verbatim from the previous documents. They are facts about the business, not
   drafting choices; do not change them as a side effect of a copy edit.
3. Adding a document means adding it to `LEGAL_DOCUMENTS` in
   `src/lib/legal/registry.ts`. The route, sitemap entry, footer link and index row
   follow from that list — there is nothing else to register.

## What these documents assert about the system

Each of these is a claim a regulator could check against the code. If any of them stops
being true, the document has to change in the same commit:

- No analytics, advertising or third-party tracking, on the site or in outbound email
  (no tracking pixels, no link rewriting).
- Cookies are limited to the Supabase auth session and the two OAuth state nonces.
- Mailbox credentials are encrypted with AES-256-GCM before storage
  (`MAILBOX_ENCRYPTION_KEY`).
- Inbound mail is evaluated in memory and only stored when the sender matches a
  contacted lead (`src/lib/pipeline/inbound.ts`).
- Tenant isolation is enforced by row-level security, not application code
  (`supabase/migrations/0002_rls_policies.sql`).
- Activity log retention is 30 days for routine entries and 90 for problem entries
  (`src/app/api/pipeline/log-retention/route.ts`).
- An opt-out reply suppresses the address and stops the sequence
  (`src/lib/pipeline/reply.ts`).
- Addresses are verified by Apollo and independently by Emailable before use; they are
  never guessed from name patterns.

## Before publishing

These were written against what the system actually does, and the factual claims are
checkable. The legal positions — the legitimate-interests basis for outbound contact,
the arbitration clause, the liability cap, and the Standard Contractual Clauses
elections in the DPA — should be reviewed by counsel before they are relied on.
