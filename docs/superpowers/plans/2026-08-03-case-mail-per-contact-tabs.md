# Case Mail Per-Contact Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the case page's Mail tab from one flat chronological list of every email into one sub-tab per contacted person, so a case with multiple contacts reads as separate conversations instead of an interleaved mess.

**Architecture:** A new pure grouping function (`buildContactThreads`) turns the case's existing `leads` and `emails` arrays into per-contact "threads" plus a list of not-yet-contacted eligible leads. A new `MailTab` Server Component renders those threads as nested tabs (reusing the existing Radix-based `Tabs` primitives), each with its own scoped `ComposeForm`. No schema or DB-layer change — `emails.lead_id` already exists and is already populated on every real row.

**Tech Stack:** Next.js 16 Server Components, TypeScript strict mode, Zod (unaffected here), Vitest for unit tests, existing `@/components/ui/tabs` (Radix `Tabs` primitive), `@phosphor-icons/react`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-case-mail-per-contact-tabs-design.md` — read it before starting if anything below is ambiguous.
- No `any` anywhere; no `!` non-null assertion without a comment proving it is safe (this codebase's existing convention — see `src/lib/db/emails.ts` `data[0]!` sites).
- `noUncheckedIndexedAccess: true` is on — every array index access is `T | undefined` until narrowed or asserted with a proved comment.
- Sub-tab order = `leads` order (case creation order), not email recency or count. The first thread is the default sub-tab.
- Only a lead with ≥1 email gets a sub-tab. A not-yet-contacted eligible lead (active, non-parked, has an address) is reachable only through the trailing "New" tab, which appears only when such leads exist.
- No DB/migration change. No change to `sendManualEmail`, suppression, or cadence behavior.
- New pure functions require 100% test coverage (`.claude/QUALITY.md`); React components here get manual verification only — there is no `@testing-library/react` / `.test.tsx` setup in this repo, so do not invent one.
- Run `pnpm typecheck` and `pnpm test` after every task; both must be clean before moving on.

---

### Task 1: Extract `ComposeContact` into `@/types/mail`

**Files:**
- Create: `src/types/mail.ts`
- Modify: `src/app/(app)/cases/[id]/compose-form.tsx:17-21` (remove the inline interface, add an import)

**Interfaces:**
- Produces: `interface ComposeContact { id: string; fullName: string; email: string }` importable from `@/types/mail`. Every later task that needs a "recipient" shape uses this.

`ComposeContact` currently lives inline inside a `'use client'` component
(`compose-form.tsx`), which violates `.claude/QUALITY.md`'s "Export types from
`/types` — never define shared types inline in components." It is about to be
needed by a plain (non-client) module (`mail-threads.ts`, Task 2) and a second
component (`mail-tab.tsx`, Task 4), so this is the moment to fix it rather
than duplicate the shape three times.

- [ ] **Step 1: Create the type file**

```ts
// src/types/mail.ts
export interface ComposeContact {
  id: string
  fullName: string
  email: string
}
```

- [ ] **Step 2: Update `compose-form.tsx` to import it instead of declaring it**

Remove these lines (currently `compose-form.tsx:17-21`):

```ts
export interface ComposeContact {
  id: string
  fullName: string
  email: string
}
```

Add this import, grouped with the other `@/...` absolute imports (after the
`import type { ResourceSummary } from '@/components/resource-list'` line):

```ts
import type { ComposeContact } from '@/types/mail'
```

Nothing else in `compose-form.tsx` changes — `ComposeContact` is still used
exactly the same way in the `ComposeFormProps` interface below it.

- [ ] **Step 3: Verify nothing else referenced the old export**

Run: `grep -rn "ComposeContact" src --include="*.ts" --include="*.tsx"`
Expected: only `src/types/mail.ts` (the `export interface`) and
`src/app/(app)/cases/[id]/compose-form.tsx` (the `import type` and its use in
`ComposeFormProps`).

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: both clean — this is a pure type move, nothing should break.

- [ ] **Step 5: Commit**

```bash
git add src/types/mail.ts src/app/\(app\)/cases/\[id\]/compose-form.tsx
git commit -m "refactor: move ComposeContact to src/types/mail"
```

---

### Task 2: `buildContactThreads` grouping function

**Files:**
- Create: `src/lib/ui/mail-threads.ts`
- Test: `src/lib/ui/mail-threads.test.ts`

**Interfaces:**
- Consumes: `ComposeContact` from `@/types/mail` (Task 1); `Database['public']['Tables']['leads']['Row']` and `Database['public']['Tables']['emails']['Row']` from `@/types/database` (generated, already exist).
- Produces:
  ```ts
  export interface ContactThread {
    leadId: string
    fullName: string
    emails: EmailRow[]
    composeContact: ComposeContact | null
    defaultSubject: string
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
  Task 4 (`MailTab`) and Task 5 (`page.tsx`) both consume this exact signature.

- [ ] **Step 1: Write the failing test file**

```ts
// src/lib/ui/mail-threads.test.ts
import { describe, it, expect } from 'vitest'
import { buildContactThreads } from './mail-threads'
import type { Database } from '@/types/database'
import type { ComposeContact } from '@/types/mail'

type LeadRow = Database['public']['Tables']['leads']['Row']
type EmailRow = Database['public']['Tables']['emails']['Row']

function makeLead(id: string, fullName: string): LeadRow {
  return {
    id,
    client_id: 'client-1',
    campaign_id: 'campaign-1',
    case_id: 'case-1',
    full_name: fullName,
    title: null,
    company_name: null,
    company_domain: null,
    linkedin_url: null,
    source: null,
    source_id: null,
    raw: {},
    email: `${id}@example.com`,
    email_status: 'verified',
    email_verified_at: null,
    email_verification: null,
    status: 'active',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

function makeEmail(overrides: {
  id: string
  lead_id: string | null
  direction: EmailRow['direction']
  subject?: string | null
  created_at?: string
}): EmailRow {
  return {
    id: overrides.id,
    client_id: 'client-1',
    case_id: 'case-1',
    lead_id: overrides.lead_id,
    thread_id: null,
    provider_message_id: null,
    direction: overrides.direction,
    subject: overrides.subject ?? null,
    body: null,
    status: 'sent',
    sequence_step: null,
    mailbox_id: null,
    sent_at: null,
    in_reply_to_email_id: null,
    sent_by: null,
    created_at: overrides.created_at ?? '2026-08-01T00:00:00.000Z',
  }
}

function makeContact(id: string, fullName: string): ComposeContact {
  return { id, fullName, email: `${id}@example.com` }
}

describe('buildContactThreads', () => {
  it('should group emails by lead, including a lead with only one direction', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadB = makeLead('lead-b', 'Bob Ross')
    const emails = [
      makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' }),
      makeEmail({ id: 'e2', lead_id: 'lead-b', direction: 'inbound' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace'), makeContact('lead-b', 'Bob Ross')]

    const { threads } = buildContactThreads([leadA, leadB], emails, contacts)

    expect(threads).toHaveLength(2)
    expect(threads[0]).toMatchObject({ leadId: 'lead-a', emails: [emails[0]] })
    expect(threads[1]).toMatchObject({ leadId: 'lead-b', emails: [emails[1]] })
  })

  it('should order threads by leads order, not email recency or count', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadB = makeLead('lead-b', 'Bob Ross')
    const emails = [
      makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound', created_at: '2026-08-01T00:00:00.000Z' }),
      makeEmail({ id: 'e2', lead_id: 'lead-b', direction: 'outbound', created_at: '2026-08-02T00:00:00.000Z' }),
      makeEmail({ id: 'e3', lead_id: 'lead-b', direction: 'inbound', created_at: '2026-08-03T00:00:00.000Z' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace'), makeContact('lead-b', 'Bob Ross')]

    const { threads } = buildContactThreads([leadA, leadB], emails, contacts)

    expect(threads.map((thread) => thread.leadId)).toEqual(['lead-a', 'lead-b'])
  })

  it('should skip a lead with zero emails', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadNoMail = makeLead('lead-c', 'No Mail')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' })]
    const contacts = [makeContact('lead-a', 'Ada Lovelace'), makeContact('lead-c', 'No Mail')]

    const { threads } = buildContactThreads([leadA, leadNoMail], emails, contacts)

    expect(threads.map((thread) => thread.leadId)).toEqual(['lead-a'])
  })

  it('should prefix Re: once for the last outbound subject and not double-prefix', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [
      makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound', subject: 'Hello', created_at: '2026-08-01T00:00:00.000Z' }),
      makeEmail({ id: 'e2', lead_id: 'lead-a', direction: 'inbound', subject: 'Re: Hello', created_at: '2026-08-02T00:00:00.000Z' }),
      makeEmail({ id: 'e3', lead_id: 'lead-a', direction: 'outbound', subject: 'Re: Hello', created_at: '2026-08-03T00:00:00.000Z' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace')]

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads[0]?.defaultSubject).toBe('Re: Hello')
  })

  it('should default to an empty subject when the lead has no outbound email yet', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'inbound', subject: 'Question' })]
    const contacts = [makeContact('lead-a', 'Ada Lovelace')]

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads[0]?.defaultSubject).toBe('')
  })

  it('should set composeContact to null for a lead with emails but no longer eligible to send', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' })]
    // leadA has history but is absent from composeContacts (parked, or lost its address)
    const contacts: ComposeContact[] = []

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads[0]?.composeContact).toBeNull()
  })

  it('should exclude leads that already have a thread from newContactOptions, preserving order', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadB = makeLead('lead-b', 'Bob Ross')
    const leadC = makeLead('lead-c', 'Cleo King')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' })]
    const contacts = [
      makeContact('lead-a', 'Ada Lovelace'),
      makeContact('lead-b', 'Bob Ross'),
      makeContact('lead-c', 'Cleo King'),
    ]

    const { newContactOptions } = buildContactThreads([leadA, leadB, leadC], emails, contacts)

    expect(newContactOptions.map((contact) => contact.id)).toEqual(['lead-b', 'lead-c'])
  })

  it('should skip an email row with a null lead_id instead of throwing', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [
      makeEmail({ id: 'e1', lead_id: null, direction: 'outbound' }),
      makeEmail({ id: 'e2', lead_id: 'lead-a', direction: 'outbound' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace')]

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads).toHaveLength(1)
    expect(threads[0]?.emails).toEqual([emails[1]])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/ui/mail-threads.test.ts`
Expected: FAIL — `Cannot find module './mail-threads'` (the module does not
exist yet).

- [ ] **Step 3: Write `mail-threads.ts`**

```ts
// src/lib/ui/mail-threads.ts
import type { Database } from '@/types/database'
import type { ComposeContact } from '@/types/mail'

type LeadRow = Database['public']['Tables']['leads']['Row']
type EmailRow = Database['public']['Tables']['emails']['Row']

export interface ContactThread {
  leadId: string
  fullName: string
  emails: EmailRow[]
  composeContact: ComposeContact | null
  defaultSubject: string
}

export interface MailThreads {
  threads: ContactThread[]
  newContactOptions: ComposeContact[]
}

// Splits a case's flat email list into one thread per contacted lead (leads
// order, so tab order and the default tab match the Contacts section), plus
// the leads that are eligible to email but have no thread yet.
export function buildContactThreads(
  leads: readonly LeadRow[],
  emails: readonly EmailRow[],
  composeContacts: readonly ComposeContact[],
): MailThreads {
  const emailsByLeadId = new Map<string, EmailRow[]>()
  for (const email of emails) {
    // Every real write path sets lead_id (see the pipeline callers of
    // claimOutboundEmail / insertInboundEmail / insertManualEmail); the
    // column is nullable only because the DB doesn't enforce it.
    if (!email.lead_id) continue
    const existing = emailsByLeadId.get(email.lead_id)
    if (existing) {
      existing.push(email)
    } else {
      emailsByLeadId.set(email.lead_id, [email])
    }
  }

  const composeContactByLeadId = new Map(composeContacts.map((contact) => [contact.id, contact]))

  const threads: ContactThread[] = []
  for (const lead of leads) {
    const leadEmails = emailsByLeadId.get(lead.id)
    if (!leadEmails || leadEmails.length === 0) continue
    threads.push({
      leadId: lead.id,
      fullName: lead.full_name,
      emails: leadEmails,
      composeContact: composeContactByLeadId.get(lead.id) ?? null,
      defaultSubject: replySubject(leadEmails),
    })
  }

  const threadLeadIds = new Set(threads.map((thread) => thread.leadId))
  const newContactOptions = composeContacts.filter((contact) => !threadLeadIds.has(contact.id))

  return { threads, newContactOptions }
}

// "Re: <last outbound subject>" for one lead's own emails, or '' if this lead
// has no outbound email yet. Scoped per lead so one contact's subject line
// can no longer leak into another contact's reply box, which the case-wide
// version this replaces did.
function replySubject(leadEmails: readonly EmailRow[]): string {
  const lastOutbound = [...leadEmails].reverse().find((email) => email.direction === 'outbound')
  if (!lastOutbound || !lastOutbound.subject) return ''
  return lastOutbound.subject.startsWith('Re: ') ? lastOutbound.subject : `Re: ${lastOutbound.subject}`
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/ui/mail-threads.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: both clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/mail-threads.ts src/lib/ui/mail-threads.test.ts
git commit -m "feat: group case emails into per-contact threads"
```

---

### Task 3: Collapse `ComposeForm`'s recipient picker for a single contact

**Files:**
- Modify: `src/app/(app)/cases/[id]/compose-form.tsx:81-96`

**Interfaces:**
- Consumes: `ComposeContact` from `@/types/mail` (Task 1) — no new prop, no signature change; `ComposeFormProps` is unchanged, so every existing and future caller is unaffected.
- Produces: same `ComposeForm` export, same props — only its internal rendering changes.

A one-option `<Select>` is noise once a per-contact tab (Task 4) already
implies who the recipient is. When `contacts.length === 1`, show a static
"To: Name — email" line instead. The dropdown stays for `contacts.length >
1` (the future "New" tab, still choosing a recipient), and the existing
`contacts.length === 0` empty-state message (`compose-form.tsx:54-60`) is
untouched.

- [ ] **Step 1: Replace the recipient block**

Current (`compose-form.tsx:81-96`):

```tsx
        <div className="flex min-w-56 flex-col gap-1.5">
          <Label htmlFor="compose-recipient">To</Label>
          <Select value={leadId} onValueChange={setLeadId}>
            <SelectTrigger id="compose-recipient">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  {contact.fullName} — {contact.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
```

Replace with:

```tsx
        <div className="flex min-w-56 flex-col gap-1.5">
          <Label htmlFor={contacts.length > 1 ? 'compose-recipient' : undefined}>To</Label>
          {contacts.length === 1 ? (
            // length check above guarantees index 0 exists
            <p className="text-sm font-medium">
              {contacts[0]!.fullName} — {contacts[0]!.email}
            </p>
          ) : (
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger id="compose-recipient">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    {contact.fullName} — {contact.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
```

- [ ] **Step 2: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: both clean — no test file covers this component (no `.test.tsx`
setup in this repo), so this step is the only automated signal; Task 6
covers it visually.

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/cases/\[id\]/compose-form.tsx
git commit -m "feat: collapse ComposeForm recipient picker to a static line for one contact"
```

---

### Task 4: `MailTab` component

**Files:**
- Create: `src/app/(app)/cases/[id]/mail-tab.tsx`

**Interfaces:**
- Consumes: `ContactThread`, `MailThreads` shape from `@/lib/ui/mail-threads` (Task 2); `ComposeContact` from `@/types/mail` (Task 1); the updated `ComposeForm` from `./compose-form` (Task 3); `ResourceSummary` from `@/components/resource-list` (existing); `EmailMessage` from `@/components/email-message` (existing, unchanged); `EmptyState` from `@/components/empty-state` (existing); `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent` from `@/components/ui/tabs` (existing).
- Produces:
  ```ts
  interface MailTabProps {
    caseId: string
    threads: readonly ContactThread[]
    newContactOptions: readonly ComposeContact[]
    resources: readonly ResourceSummary[]
    now: Date
  }
  export function MailTab(props: MailTabProps): React.ReactElement
  ```
  Task 5 (`page.tsx`) renders this with exactly these props.

- [ ] **Step 1: Write the component**

```tsx
// src/app/(app)/cases/[id]/mail-tab.tsx
import { Envelope, Plus } from '@phosphor-icons/react/dist/ssr'
import { EmailMessage } from '@/components/email-message'
import { EmptyState } from '@/components/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { ResourceSummary } from '@/components/resource-list'
import type { ContactThread } from '@/lib/ui/mail-threads'
import type { ComposeContact } from '@/types/mail'
import { ComposeForm } from './compose-form'

interface MailTabProps {
  caseId: string
  threads: readonly ContactThread[]
  newContactOptions: readonly ComposeContact[]
  resources: readonly ResourceSummary[]
  now: Date
}

export function MailTab({
  caseId,
  threads,
  newContactOptions,
  resources,
  now,
}: MailTabProps): React.ReactElement {
  // No contact has been emailed yet: no thread to separate, so this stays
  // the original single-form layout instead of a tab row with one empty tab.
  if (threads.length === 0) {
    return (
      <div className="flex max-w-[80ch] flex-col gap-4">
        <EmptyState
          icon={Envelope}
          title="No mail on this case"
          description="Outbound drafts appear here once the writer agent runs, and replies land automatically when the inbound poller picks them up."
        />
        <ComposeForm caseId={caseId} contacts={newContactOptions} resources={resources} defaultSubject="" />
      </div>
    )
  }

  // length check above (threads.length === 0 returns early) guarantees index 0 exists
  const defaultThreadId = threads[0]!.leadId

  return (
    <Tabs defaultValue={defaultThreadId} className="gap-4">
      <TabsList>
        {threads.map((thread) => (
          <TabsTrigger key={thread.leadId} value={thread.leadId}>
            {thread.fullName}
            <span className="tnum text-faint">{thread.emails.length}</span>
          </TabsTrigger>
        ))}
        {newContactOptions.length > 0 ? (
          <TabsTrigger value="new">
            <Plus size={14} weight="light" />
            New
          </TabsTrigger>
        ) : null}
      </TabsList>

      {threads.map((thread) => (
        <TabsContent key={thread.leadId} value={thread.leadId}>
          <div className="flex max-w-[80ch] flex-col gap-4">
            <div className="flex flex-col gap-3">
              {thread.emails.map((email) => (
                <EmailMessage
                  key={email.id}
                  direction={email.direction}
                  status={email.status}
                  subject={email.subject}
                  body={email.body}
                  sequenceStep={email.sequence_step}
                  timestamp={email.sent_at ?? email.created_at}
                  now={now}
                  sentByHuman={email.sent_by !== null}
                />
              ))}
            </div>
            <ComposeForm
              caseId={caseId}
              contacts={thread.composeContact ? [thread.composeContact] : []}
              resources={resources}
              defaultSubject={thread.defaultSubject}
            />
          </div>
        </TabsContent>
      ))}

      {newContactOptions.length > 0 ? (
        <TabsContent value="new">
          <div className="max-w-[80ch]">
            <ComposeForm caseId={caseId} contacts={newContactOptions} resources={resources} defaultSubject="" />
          </div>
        </TabsContent>
      ) : null}
    </Tabs>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean. (`page.tsx` still imports the old `EmailMessage`/`ComposeForm`
directly and will report unused-import lint noise until Task 5 — that's
expected and fixed there, not here. `pnpm test` is unaffected since no test
imports this file yet.)

- [ ] **Step 3: Commit**

```bash
git add src/app/\(app\)/cases/\[id\]/mail-tab.tsx
git commit -m "feat: add MailTab component with per-contact sub-tabs"
```

---

### Task 5: Wire `MailTab` into the case page

**Files:**
- Modify: `src/app/(app)/cases/[id]/page.tsx`

**Interfaces:**
- Consumes: `buildContactThreads` from `@/lib/ui/mail-threads` (Task 2); `MailTab` from `./mail-tab` (Task 4).
- Produces: the finished feature — no new exports for later tasks.

- [ ] **Step 1: Update imports**

Remove these two lines (currently `page.tsx:30` and `page.tsx:36`):

```ts
import { EmailMessage } from '@/components/email-message'
```

```ts
import { ComposeForm } from './compose-form'
```

Add, grouped with the other `@/lib/...` imports (after the
`import { CASE_STATUS, KNOWLEDGE_REQ_STATUS, LEAD_EMAIL_STATUS } from '@/lib/ui/status'`
line):

```ts
import { buildContactThreads } from '@/lib/ui/mail-threads'
```

Add, grouped with the other relative imports (replacing the removed
`ComposeForm` import's spot, alphabetically after `notes-panel`):

```ts
import { MailTab } from './mail-tab'
```

- [ ] **Step 2: Replace the case-wide subject computation with the grouping call**

Current (`page.tsx:115-127`):

```ts
  // Parked leads are excluded: outreach to them was deliberately stopped, and a
  // send would be refused by the suppression check anyway.
  const composeContacts = leads
    .filter((lead) => lead.status !== 'parked' && lead.email !== null)
    // safe: filtered on lead.email !== null immediately above
    .map((lead) => ({ id: lead.id, fullName: lead.full_name, email: lead.email! }))

  const lastOutboundSubject = [...emails]
    .reverse()
    .find((email) => email.direction === 'outbound')?.subject ?? null
  const defaultSubject = lastOutboundSubject
    ? (lastOutboundSubject.startsWith('Re: ') ? lastOutboundSubject : `Re: ${lastOutboundSubject}`)
    : ''
```

Replace with:

```ts
  // Parked leads are excluded: outreach to them was deliberately stopped, and a
  // send would be refused by the suppression check anyway.
  const composeContacts = leads
    .filter((lead) => lead.status !== 'parked' && lead.email !== null)
    // safe: filtered on lead.email !== null immediately above
    .map((lead) => ({ id: lead.id, fullName: lead.full_name, email: lead.email! }))

  const { threads: mailThreads, newContactOptions } = buildContactThreads(leads, emails, composeContacts)
```

- [ ] **Step 3: Replace the inline Mail tab body**

Current (`page.tsx:288-320`):

```tsx
        <TabsContent value="mail">
          <div className="flex max-w-[80ch] flex-col gap-4">
            {emails.length === 0 ? (
              <EmptyState
                icon={Envelope}
                title="No mail on this case"
                description="Outbound drafts appear here once the writer agent runs, and replies land automatically when the inbound poller picks them up."
              />
            ) : (
              <div className="flex flex-col gap-3">
                {emails.map((email) => (
                  <EmailMessage
                    key={email.id}
                    direction={email.direction}
                    status={email.status}
                    subject={email.subject}
                    body={email.body}
                    sequenceStep={email.sequence_step}
                    timestamp={email.sent_at ?? email.created_at}
                    now={now}
                    sentByHuman={email.sent_by !== null}
                  />
                ))}
              </div>
            )}
            <ComposeForm
              caseId={kase.id}
              contacts={composeContacts}
              resources={composeResources}
              defaultSubject={defaultSubject}
            />
          </div>
        </TabsContent>
```

Replace with:

```tsx
        <TabsContent value="mail">
          <MailTab
            caseId={kase.id}
            threads={mailThreads}
            newContactOptions={newContactOptions}
            resources={composeResources}
            now={now}
          />
        </TabsContent>
```

`Envelope` stays imported — it is still used by the outer "Mail" `TabsTrigger`
icon (`page.tsx:268`). `EmptyState` stays imported — still used by the
Knowledge, Questions and Activity tabs.

- [ ] **Step 4: Typecheck and run the full suite**

Run: `pnpm typecheck && pnpm test`
Expected: both clean.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: clean — this step is what confirms the removed `EmailMessage` /
`ComposeForm` imports in `page.tsx` left no unused-import warnings.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/cases/\[id\]/page.tsx
git commit -m "feat: render the case Mail tab as per-contact sub-tabs"
```

---

### Task 6: Manual verification in the browser

**Files:** none (verification only).

**Interfaces:** none produced — this is the terminal task.

- [ ] **Step 1: Find or seed a case with 2+ contacted leads**

Run: `pnpm seed:dev` if the local Supabase project has no case with multiple
contacted leads yet (check via the `/crm` board — open a case and look at its
Contacts section and existing Mail tab first).

- [ ] **Step 2: Start the dev server and open the case**

Use the `run` skill to start the app, then in the browser navigate to
`/cases/<id>` for that case and open the **Mail** tab.

Verify:
- One sub-tab per contacted lead, in the same order as the Contacts section
  above, each labeled with that person's name and their email count.
- The first sub-tab is selected by default.
- Each sub-tab shows only that person's emails (not another contact's), and
  its compose form shows a static "To: Name — email" line, not a dropdown.
- If any eligible lead has never been emailed, a trailing "New" tab is
  present with a recipient dropdown over just those people.

- [ ] **Step 3: Send from the "New" tab, if present**

Compose and send a message to a not-yet-contacted lead. After the page
revalidates, confirm that lead now has their own sub-tab showing the sent
message, and no longer appears in the "New" tab's dropdown.

- [ ] **Step 4: Check the zero-contact case**

Open (or seed) a case with no contacted leads yet. Verify the Mail tab shows
the original single "No mail on this case" empty state plus one compose form
with a recipient dropdown — no tabs.

- [ ] **Step 5: Check a parked contact with existing history**

If a seeded case has a parked lead who was emailed before being parked,
open their sub-tab and verify their thread still displays, with the "nobody
to write to" message in place of a compose form (matches
`compose-form.tsx`'s existing `contacts.length === 0` state).

- [ ] **Step 6: Final full check**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean. Nothing left to commit for this task — it is
verification only.
