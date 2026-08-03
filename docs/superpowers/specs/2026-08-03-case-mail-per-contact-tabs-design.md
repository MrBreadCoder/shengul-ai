# Case page — per-contact mail tabs — design

**Date:** 2026-08-03
**Status:** approved, ready for an implementation plan

## Problem

The case page's Mail tab (`src/app/(app)/cases/[id]/page.tsx`) renders every
email on the case — outbound and inbound, across every contact — as one flat
chronological list. On a case with more than one contacted person, replies and
drafts for different people interleave with no visual separation, so the
thread reads as noise instead of two (or more) conversations.

`emails.lead_id` already exists on every row and is already populated by every
real write path (`write.ts`, `followup.ts`, `reply.ts`, `inbound.ts` — the
inbound poller only stores a message once `findContactedLeadByEmail` matches
it to a lead; an unmatched sender is skipped entirely, never stored with a
null `lead_id`). No schema change is needed — this is a presentation-layer
regrouping of data that already exists.

## Scope

- Split the Mail tab into one sub-tab per contacted lead (a lead with ≥1
  email on this case), ordered the same way the Contacts section already
  orders leads. The first contact in that order is the default sub-tab.
- Each sub-tab shows that lead's own email thread and a compose form scoped
  to that one recipient.
- A case may have contacts who are eligible to email but have never been
  contacted yet (active, non-parked, has an address) — the compose form
  currently serves as the only way to start that first email, so a trailing
  **"New"** sub-tab preserves that: a compose form with a recipient dropdown
  over the not-yet-contacted eligible leads. It only appears when such leads
  exist.
- Out of scope: changing what an `EmailMessage` looks like, changing the
  outer Mail/Knowledge/Questions/Activity tab row, any DB/migration change,
  any change to send behavior (`sendManualEmail`, suppression, cadence).

## Data layer — `src/lib/ui/mail-threads.ts`

New pure module, colocated `mail-threads.test.ts`. Grouping and per-contact
subject defaulting are real logic worth unit-testing on their own, separate
from the JSX that consumes them.

```ts
export interface ContactThread {
  leadId: string
  fullName: string
  emails: EmailRow[]              // this lead's emails only, oldest-first
  composeContact: ComposeContact | null  // null when parked / no address
  defaultSubject: string          // "Re: <last outbound subject to this lead>", else ''
}

export interface MailThreads {
  threads: ContactThread[]
  newContactOptions: ComposeContact[]
}

export function buildContactThreads(
  leads: readonly LeadRow[],
  emails: readonly EmailRow[],
  composeContacts: readonly ComposeContact[],
): MailThreads
```

Behavior:

1. Group `emails` by `lead_id`, skipping any row with a null `lead_id`
   (defensive only — see Problem; not a real path today).
2. Walk `leads` in their existing order. A lead with ≥1 email in the group
   becomes a `ContactThread`; a lead with none is skipped from `threads`
   entirely (only "contacted" people get a tab, per product decision).
3. `composeContact` on a thread is the matching entry from `composeContacts`
   (already filtered upstream to active, non-parked, has-address leads), or
   `null` if this lead is parked or lost its address since being contacted —
   the thread still shows history, just can't be sent to further.
4. `defaultSubject` is computed per lead from that lead's own emails only
   (last outbound subject, reversed, `Re: ` prefixed unless already
   present) — this replaces the current case-wide computation at
   `page.tsx:122-127`, which would otherwise leak one contact's subject line
   into another contact's reply box.
5. `newContactOptions` = `composeContacts` minus every lead that already has
   a thread.

## Component structure

New file `src/app/(app)/cases/[id]/mail-tab.tsx` (Server Component), replacing
the current inline `<TabsContent value="mail">` body
(`page.tsx:288-320`) — keeps `page.tsx` from growing further and matches the
existing split of `NotesPanel` / `ComposeForm` / `CrmLinkBadge` into their own
files.

```tsx
interface MailTabProps {
  caseId: string
  threads: readonly ContactThread[]
  newContactOptions: readonly ComposeContact[]
  resources: readonly ResourceSummary[]
  now: Date
}
```

Three layouts, chosen by the counts already computed in `mail-threads.ts`:

1. **`threads.length === 0 && newContactOptions.length === 0`** — today's
   `EmptyState` only ("No mail on this case…"). Nobody to email, nothing
   sent.
2. **`threads.length === 0 && newContactOptions.length > 0`** — today's
   `EmptyState` plus a single `ComposeForm` over `newContactOptions`. This is
   the untouched "case's very first email" layout; tabs add nothing when
   there is no history yet to separate.
3. **`threads.length >= 1`** — a nested `Tabs` (reusing the existing
   `Tabs` / `TabsList` / `TabsTrigger` / `TabsContent` primitives from
   `@/components/ui/tabs`, same visual language as the outer tab row):
   - One `TabsTrigger` per thread, in `threads` order, `defaultValue` the
     first thread's `leadId`: `{fullName} <span class="tnum text-faint">{emails.length}</span>`.
   - If `newContactOptions.length > 0`, one trailing `TabsTrigger
     value="new"` with a `Plus` icon and label "New".
   - Each thread's `TabsContent`: its `emails` rendered as today via
     `EmailMessage` (unchanged component), then a `ComposeForm` with
     `contacts={thread.composeContact ? [thread.composeContact] : []}` and
     `defaultSubject={thread.defaultSubject}`.
   - The `"new"` tab's `TabsContent`: just a `ComposeForm` with
     `contacts={newContactOptions}` and `defaultSubject=''` — no email list,
     since there is no history yet.

## `ComposeForm` change

`src/app/(app)/cases/[id]/compose-form.tsx`: when `contacts.length === 1`
(the normal case inside a per-contact tab), render a static "To: {fullName}
— {email}" line instead of the `Select` — a one-option dropdown is noise
once the tab already implies the recipient. The `Select` stays for
`contacts.length > 1` (the "New" tab, still choosing who to write to). The
existing `contacts.length === 0` empty message
("No contact on this case has a verified address yet…") is unchanged, and is
now also reached from a thread whose `composeContact` is `null`.

No other prop or behavior of `ComposeForm` changes — `sendManualEmail`,
attachments, and error mapping are untouched.

## `page.tsx` change

- Remove the case-wide `lastOutboundSubject` / `defaultSubject` computation
  (`page.tsx:122-127`) — superseded by per-thread `defaultSubject` in
  `mail-threads.ts`.
- After computing `composeContacts` (`page.tsx:117-120`, unchanged), call
  `buildContactThreads(leads, emails, composeContacts)`.
- Replace the current inline Mail `TabsContent` body with
  `<MailTab caseId={kase.id} threads={threads} newContactOptions={newContactOptions} resources={composeResources} now={now} />`.
- The outer `TabsTrigger` for "Mail" keeps its existing
  `{emails.length}` count — unchanged, still the total across every contact.

## Testing

Per `.claude/QUALITY.md`: 100% on the new pure function, 80%+ on the
DB-adjacent view logic.

- `mail-threads.test.ts`:
  - groups emails by lead correctly, including a lead with only inbound mail
    and a lead with only outbound;
  - thread order matches `leads` order, not email recency or count;
  - a lead with zero emails produces no thread;
  - `defaultSubject` prefixes `Re: ` once, does not double-prefix an already
    `Re: `-prefixed subject, and is `''` when the lead has no outbound email;
  - a parked/no-address lead with existing emails still produces a thread,
    with `composeContact: null`;
  - `newContactOptions` excludes every lead that already has a thread and
    preserves `composeContacts` order for the rest;
  - a row with a null `lead_id` is skipped, not thrown on.
- Manual verification in-browser (per `run` skill): a case with 2+ contacted
  leads shows 2+ tabs, each with only that lead's emails; a case with zero
  contacted leads keeps today's single-form layout; sending from the "New"
  tab creates that lead's own thread, visible as a new tab after refresh; a
  parked contact's tab shows history with no compose form.

## Explicitly out of scope

- Any change to `EmailMessage`'s markup or the outer Mail/Knowledge/
  Questions/Activity tab row.
- Any DB/migration change — `lead_id` already exists and is already
  populated on every real row.
- Unread/needs-reply indicators on sub-tabs.
- Reordering sub-tabs by recency instead of `leads` order.
- Any change to `sendManualEmail`, suppression, or cadence behavior.
