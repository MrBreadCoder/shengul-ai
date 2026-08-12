# Client Home Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `/home` landing page for client-role users that summarizes, at a glance: 7-day activity metrics, what's pending their approval, running campaigns, the latest leads found, and recent outbound mail. It becomes the post-login destination for clients; operators are unaffected.

**Architecture:** A new Server Component route (`src/app/(app)/home/`) that composes existing, already-tested `lib/db` read functions plus one new one (`listRecentLeadsForClient`). Three presentational components used by both `/analytics` and `/home` (`StatTile`, `SparklineChart`, `RealtimeRefresher`) move from `src/app/(app)/analytics/` to `src/components/` so both routes share one implementation instead of duplicating it. Three new presentational components (`NeedsActionCard`, `CampaignRow`, `LeadRow`) are route-local to `/home` since nothing else consumes them, matching this codebase's existing convention (single-consumer presentational pieces stay next to their page; multi-consumer ones live in `src/components/`).

**Tech Stack:** Next.js App Router Server Components, Supabase (RLS-scoped reads via `createServerClient`), next-intl (`en`/`tr`), Tailwind, Phosphor icons, Vitest.

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (`.claude/QUALITY.md`).
- Every list/query function lives in `src/lib/db/`, one function per DB operation, RLS-scoped via the session-bound `createServerClient()` (never the admin client) (`.claude/QUALITY.md`, `.claude/architecture.md §11`).
- DB columns are snake_case; TypeScript types are camelCase — map explicitly.
- Every thrown error is an `AppError` with `code`/`message`/`context` — never a bare `Error`, never a swallowed catch.
- This page is client-facing, so every user-visible string is translated (`en.json` + `tr.json`, kept in exact key-path parity — enforced by `src/messages/messages.test.ts`). Per `CLAUDE.md`: "TRANSLATE ONLY IN CLIENT FACING PLACES" — this page qualifies.
- No `console.log`. No commented-out code. No `TODO`/`FIXME`/`HACK`.
- Named exports only (default exports reserved for Next.js pages/layouts).
- Early returns over nested conditionals. Functions under ~40 lines.
- Imports ordered: external libs → internal absolute (`@/lib/...`, `@/components/...`) → relative (`./...`).
- `dont branch use main` (`CLAUDE.md`) — work happens directly on the current branch.
- `UPDATE THE .claude/roadmap.md EVERY TIME YOU MAKE PROGRESS` (`CLAUDE.md`) — the final task does this.
- Commit after each task, using the message conventions already present in `git log` (`type(scope): summary`), ending with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  ```

---

## Task 1: Hoist `StatTile`, `SparklineChart`, `RealtimeRefresher` into `src/components/`

These three components are pure, generic presentational pieces with zero analytics-specific logic. `/home` needs all three unchanged. Every other multi-route presentational component in this codebase already lives in `src/components/` (`case-row.tsx`, `email-message.tsx`, `company-mark.tsx`, `status-dot.tsx`, `empty-state.tsx`) — this follows that exact convention rather than importing across sibling route folders.

**Files:**
- Create: `src/components/stat-tile.tsx`
- Create: `src/components/sparkline-chart.tsx`
- Create: `src/components/realtime-refresher.tsx`
- Delete: `src/app/(app)/analytics/stat-tile.tsx`
- Delete: `src/app/(app)/analytics/sparkline-chart.tsx`
- Delete: `src/app/(app)/analytics/realtime-refresher.tsx`
- Modify: `src/app/(app)/analytics/analytics-view.tsx`
- Modify: `src/app/(app)/analytics/page.tsx`

**Interfaces:**
- Produces: `StatTile({ label, value, hint?, index? }): React.ReactElement` from `@/components/stat-tile`
- Produces: `SparklineChart({ title, values, color, total, index? }): Promise<React.ReactElement>` from `@/components/sparkline-chart`
- Produces: `RealtimeRefresher({ channel }): React.ReactElement | null` from `@/components/realtime-refresher` — `channel: string` is new (previously hardcoded to `'analytics-metrics'` internally)

- [ ] **Step 1: Create `src/components/stat-tile.tsx`** (identical content to the current `src/app/(app)/analytics/stat-tile.tsx`)

```tsx
interface StatTileProps {
  label: string
  value: string
  hint?: string
  /** Position in its grid, used only to stagger the entrance animation. */
  index?: number
}

// Caps the stagger so a tile far down a long grid never waits noticeably
// longer than one at the top — the reveal should read as "together," not "in order."
const MAX_STAGGER_STEPS = 8
const STAGGER_STEP_MS = 40

export function StatTile({ label, value, hint, index }: StatTileProps): React.ReactElement {
  const style =
    index !== undefined ? { animationDelay: `${Math.min(index, MAX_STAGGER_STEPS) * STAGGER_STEP_MS}ms` } : undefined

  return (
    <div
      className="border-hairline bg-surface card-interactive animate-rise min-w-0 rounded-lg border p-4"
      style={style}
    >
      <p className="text-muted-foreground truncate text-xs">{label}</p>
      <p className="tnum mt-2 text-2xl font-semibold tracking-tight">{value}</p>
      {hint ? <p className="text-faint mt-1 text-[11px] leading-snug">{hint}</p> : null}
    </div>
  )
}
```

- [ ] **Step 2: Create `src/components/sparkline-chart.tsx`** (identical content to the current `src/app/(app)/analytics/sparkline-chart.tsx` — still reads the `analytics` i18n namespace's `sparkline.*` keys, which is fine: those three strings are generic chart copy, not analytics-page-specific meaning)

```tsx
import { getTranslations } from 'next-intl/server'
import { buildSparkline } from '@/lib/analytics/sparkline'

interface SparklineChartProps {
  title: string
  values: number[]
  /** CSS colour expression, taken from the status palette by the caller. */
  color: string
  total: string
  /** Position among its sibling charts, used only to stagger the entrance animation. */
  index?: number
}

const STAGGER_STEP_MS = 40

export async function SparklineChart({
  title,
  values,
  color,
  total,
  index,
}: SparklineChartProps): Promise<React.ReactElement> {
  const t = await getTranslations('analytics')
  const { width, height, max, bars } = buildSparkline(values)
  const style = index !== undefined ? { animationDelay: `${index * STAGGER_STEP_MS}ms` } : undefined

  return (
    <div className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4" style={style}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground truncate text-xs">{title}</span>
        <span className="tnum text-lg font-semibold tracking-tight">{total}</span>
      </div>

      {bars.length === 0 ? (
        <p className="text-faint mt-3 text-xs">{t('sparkline.noData')}</p>
      ) : (
        <svg
          role="img"
          aria-label={t('sparkline.ariaLabel', { title, total, days: bars.length, max })}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          className="mt-3 block h-12 w-full"
        >
          {bars.map((bar, index) => (
            <rect
              key={`${title}-${index}`}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1}
              fill={color}
              // Recent days read stronger than the tail of the window.
              opacity={0.45 + (0.55 * (index + 1)) / bars.length}
            />
          ))}
        </svg>
      )}

      <p className="text-faint tnum mt-2 text-[11px]">
        {t('sparkline.peakLabel', { max, days: bars.length })}
      </p>
    </div>
  )
}
```

- [ ] **Step 3: Create `src/components/realtime-refresher.tsx`** (adds a required `channel` prop; the local `.channel()` variable is renamed to `realtimeChannel` to avoid shadowing the prop)

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

// The pipeline writes in bursts (a discovery run inserts dozens of leads), so
// coalesce a burst into one server round-trip instead of one per row.
const REFRESH_DEBOUNCE_MS = 1500

interface RealtimeRefresherProps {
  /** Unique per page so concurrent subscriptions are distinguishable in
   *  Supabase's realtime logs. The tables watched are the same everywhere. */
  channel: string
}

// Renders nothing. It listens for "a row that feeds a metric changed" and asks
// the server to recompute — the aggregation itself stays server-side and
// RLS-scoped. Realtime applies the same RLS policies to the subscription, so a
// client-role viewer is only woken by its own client's rows.
export function RealtimeRefresher({ channel }: RealtimeRefresherProps) {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        router.refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    const realtimeChannel = supabase
      .channel(channel)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'emails' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'emails' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cases' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cases' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(realtimeChannel)
    }
  }, [router, channel])

  return null
}
```

- [ ] **Step 4: Delete the three old route-local files**

```bash
rm "src/app/(app)/analytics/stat-tile.tsx" "src/app/(app)/analytics/sparkline-chart.tsx" "src/app/(app)/analytics/realtime-refresher.tsx"
```

- [ ] **Step 5: Update `src/app/(app)/analytics/analytics-view.tsx` imports**

Read the file first, then replace the two relative imports near the bottom of the import block:

Old:
```tsx
import { StatusPill } from '@/components/status-dot'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatTile } from './stat-tile'
import { SparklineChart } from './sparkline-chart'
import { AnalyticsFilters } from './filters'
```

New:
```tsx
import { StatusPill } from '@/components/status-dot'
import { StatTile } from '@/components/stat-tile'
import { SparklineChart } from '@/components/sparkline-chart'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AnalyticsFilters } from './filters'
```

- [ ] **Step 6: Update `src/app/(app)/analytics/page.tsx`**

Read the file first, then:

Old:
```tsx
import { RealtimeRefresher } from './realtime-refresher'
```
New:
```tsx
import { RealtimeRefresher } from '@/components/realtime-refresher'
```

Old:
```tsx
      <RealtimeRefresher />
```
New:
```tsx
      <RealtimeRefresher channel="analytics-metrics" />
```

- [ ] **Step 7: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: both pass clean.

- [ ] **Step 8: Manually verify `/analytics` still renders**

Run `pnpm dev`, sign in, open `/analytics`, confirm stat tiles and sparkline charts render exactly as before and the page still live-refreshes. Stop the dev server after confirming.

- [ ] **Step 9: Commit**

```bash
git add src/components/stat-tile.tsx src/components/sparkline-chart.tsx src/components/realtime-refresher.tsx "src/app/(app)/analytics/analytics-view.tsx" "src/app/(app)/analytics/page.tsx"
git rm "src/app/(app)/analytics/stat-tile.tsx" "src/app/(app)/analytics/sparkline-chart.tsx" "src/app/(app)/analytics/realtime-refresher.tsx"
git commit -m "refactor(analytics,home): hoist StatTile/SparklineChart/RealtimeRefresher to shared components

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `listRecentLeadsForClient` DB function

**Files:**
- Modify: `src/lib/db/leads.ts`
- Modify: `src/lib/db/leads.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors/app-error`, `Database` from `@/types/database` (already imported in `leads.ts`)
- Produces: `RecentLeadForClient` interface and `listRecentLeadsForClient(supabase, { limit }): Promise<RecentLeadForClient[]>` — Task 6 (`/home/page.tsx`) depends on this exact name and shape:
  ```ts
  interface RecentLeadForClient {
    id: string
    fullName: string
    title: string | null
    companyName: string | null
    companyDomain: string | null
    status: Database['public']['Enums']['lead_status']
    emailStatus: Database['public']['Enums']['lead_email_status']
    caseId: string | null
    createdAt: string
  }
  ```

- [ ] **Step 1: Write the failing tests**

Read `src/lib/db/leads.test.ts` first. Add `listRecentLeadsForClient` to the existing import list at the top:

```ts
import {
  getKnownSourceIds,
  insertLeads,
  updateLeadCase,
  getVerifiedLeadCompanies,
  getLeadById,
  listActiveLeadsForCase,
  findContactedLeadByEmail,
  parkLead,
  countLeadsForCampaign,
  listOtherActiveLeadsForCollisionNotice,
  listRecentLeadsForClient,
} from './leads'
```

Append this block at the end of the file:

```ts
function mockRecentLeads(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => Promise.resolve(result),
        }),
      }),
    }),
  } as never
}

describe('listRecentLeadsForClient', () => {
  it('should return mapped recent leads when the query succeeds', async () => {
    const supabase = mockRecentLeads({
      data: [
        {
          id: 'lead1',
          full_name: 'Jane Doe',
          title: 'VP Sales',
          company_name: 'Acme',
          company_domain: 'acme.com',
          status: 'active',
          email_status: 'verified',
          case_id: 'case1',
          created_at: '2026-08-10T00:00:00Z',
        },
      ],
      error: null,
    })
    const result = await listRecentLeadsForClient(supabase, { limit: 5 })
    expect(result).toEqual([
      {
        id: 'lead1',
        fullName: 'Jane Doe',
        title: 'VP Sales',
        companyName: 'Acme',
        companyDomain: 'acme.com',
        status: 'active',
        emailStatus: 'verified',
        caseId: 'case1',
        createdAt: '2026-08-10T00:00:00Z',
      },
    ])
  })

  it('should return an empty array when there are no leads', async () => {
    const supabase = mockRecentLeads({ data: [], error: null })
    const result = await listRecentLeadsForClient(supabase, { limit: 5 })
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = mockRecentLeads({ data: null, error: { message: 'boom' } })
    await expect(listRecentLeadsForClient(supabase, { limit: 5 })).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm test leads.test.ts
```
Expected: FAIL — `listRecentLeadsForClient` is not exported from `./leads`.

- [ ] **Step 3: Implement `listRecentLeadsForClient` in `src/lib/db/leads.ts`**

Read the file first, then append this to the end (after `listOtherActiveLeadsForCollisionNotice`):

```ts
export interface RecentLeadForClient {
  id: string
  fullName: string
  title: string | null
  companyName: string | null
  companyDomain: string | null
  status: Database['public']['Enums']['lead_status']
  emailStatus: Database['public']['Enums']['lead_email_status']
  caseId: string | null
  createdAt: string
}

// RLS-scoped: pass a session-bound server client so a client role only sees
// its own leads. Used by /home's "Latest leads found" widget — newest first,
// capped by the caller.
export async function listRecentLeadsForClient(
  supabase: SupabaseClient<Database>,
  { limit }: { limit: number },
): Promise<RecentLeadForClient[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, full_name, title, company_name, company_domain, status, email_status, case_id, created_at')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list recent leads for client', { limit, cause: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    title: row.title,
    companyName: row.company_name,
    companyDomain: row.company_domain,
    status: row.status,
    emailStatus: row.email_status,
    caseId: row.case_id,
    createdAt: row.created_at,
  }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm test leads.test.ts
```
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat(db): add listRecentLeadsForClient for the home dashboard

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `home` + `nav.home` i18n keys

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/tr.json`

**Interfaces:**
- Produces: `nav.home` and the full `home.*` namespace, consumed by Task 4 (nav) and Task 5/6 (page + components) via `useTranslations('home')` / `getTranslations('home')`.

- [ ] **Step 1: Add `nav.home` to `src/messages/en.json`**

Read the file first, then:

Old:
```json
  "nav": {
    "pipeline": "Pipeline",
```
New:
```json
  "nav": {
    "home": "Home",
    "pipeline": "Pipeline",
```

- [ ] **Step 2: Add the `home` namespace to `src/messages/en.json`**, right after the `nav` block closes:

Old:
```json
    "signOut": "Sign out"
  },
  "settings": {
```
New:
```json
    "signOut": "Sign out"
  },
  "home": {
    "pageTitle": "Home",
    "description": "Where your pipeline stands right now.",
    "errorTitle": "Home unavailable",
    "errorDescription": "Your dashboard could not be loaded. Nothing was affected.",
    "tile": {
      "leadsFound": "Leads found",
      "emailsSent": "Emails sent",
      "replies": "Replies",
      "activeCampaigns": "Active campaigns"
    },
    "sectionNeedsAction": "Needs your action",
    "allCaughtUpTitle": "You're all caught up",
    "allCaughtUpDescription": "Nothing is waiting on you right now.",
    "needsActionTitle": "Waiting on you",
    "draftsCount": "{count, plural, one {# draft} other {# drafts}}",
    "questionsCount": "{count, plural, one {# question} other {# questions}}",
    "sectionActivityTrend": "Activity trend",
    "sectionRunningCampaigns": "Running campaigns",
    "sectionLatestLeads": "Latest leads found",
    "sectionRecentMail": "Recent mail",
    "viewAllMail": "View all",
    "emptyCampaignsTitle": "No campaigns yet",
    "emptyCampaignsDescription": "Your operator hasn't set one up yet. Check back once a campaign is running.",
    "emptyLeadsTitle": "No leads yet",
    "emptyLeadsDescription": "New leads will appear here as soon as discovery finds them.",
    "emptyMailTitle": "No mail sent yet",
    "emptyMailDescription": "Sent messages will appear here once the agent reaches out.",
    "noCase": "Not linked to a case yet"
  },
  "settings": {
```

- [ ] **Step 3: Add `nav.home` to `src/messages/tr.json`**

Read the file first, then:

Old:
```json
  "nav": {
    "pipeline": "Fırsatlar",
```
New:
```json
  "nav": {
    "home": "Ana Sayfa",
    "pipeline": "Fırsatlar",
```

- [ ] **Step 4: Add the `home` namespace to `src/messages/tr.json`**, right after the `nav` block closes:

Old:
```json
    "signOut": "Çıkış yap"
  },
  "settings": {
```
New:
```json
    "signOut": "Çıkış yap"
  },
  "home": {
    "pageTitle": "Ana Sayfa",
    "description": "Fırsat hattınızın şu anki durumu.",
    "errorTitle": "Ana sayfaya ulaşılamıyor",
    "errorDescription": "Panonuz yüklenemedi. Hiçbir şey etkilenmedi.",
    "tile": {
      "leadsFound": "Bulunan kişi",
      "emailsSent": "Gönderilen e-posta",
      "replies": "Yanıtlar",
      "activeCampaigns": "Aktif kampanya"
    },
    "sectionNeedsAction": "Sizi bekleyenler",
    "allCaughtUpTitle": "Bekleyen işlem yok",
    "allCaughtUpDescription": "Şu anda sizi bekleyen bir şey yok.",
    "needsActionTitle": "Sizi bekliyor",
    "draftsCount": "{count, plural, other {# taslak}}",
    "questionsCount": "{count, plural, other {# soru}}",
    "sectionActivityTrend": "Etkinlik trendi",
    "sectionRunningCampaigns": "Yürüyen kampanyalar",
    "sectionLatestLeads": "Son bulunan kişiler",
    "sectionRecentMail": "Son e-postalar",
    "viewAllMail": "Tümünü gör",
    "emptyCampaignsTitle": "Henüz kampanya yok",
    "emptyCampaignsDescription": "Operatörünüz henüz bir tane oluşturmadı. Bir kampanya çalışmaya başladığında tekrar kontrol edin.",
    "emptyLeadsTitle": "Henüz kişi yok",
    "emptyLeadsDescription": "Keşif yeni kişiler bulduğunda burada görünecek.",
    "emptyMailTitle": "Henüz gönderilmiş e-posta yok",
    "emptyMailDescription": "Ajan iletişime geçtiğinde gönderilen mesajlar burada görünecek.",
    "noCase": "Henüz bir vakaya bağlı değil"
  },
  "settings": {
```

- [ ] **Step 5: Run the message parity test**

```bash
pnpm test messages.test.ts
```
Expected: PASS — identical key structure across locales, no empty strings.

- [ ] **Step 6: Commit**

```bash
git add src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): add home namespace and nav.home key

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Add the Home nav item

**Files:**
- Modify: `src/components/shell/nav.tsx`

**Interfaces:**
- Consumes: `home` key from the `nav` i18n namespace (Task 3), `House` icon from `@phosphor-icons/react`.
- Produces: nothing new consumed by later tasks — this is a leaf change.

- [ ] **Step 1: Read the file, then update the icon import**

Old:
```tsx
import {
  ChartLineUp,
  Envelope,
  Gear,
  Kanban,
  Lightning,
  type IconProps,
  Stack,
  Buildings,
  Tray,
} from '@phosphor-icons/react'
```
New:
```tsx
import {
  ChartLineUp,
  Envelope,
  Gear,
  House,
  Kanban,
  Lightning,
  type IconProps,
  Stack,
  Buildings,
  Tray,
} from '@phosphor-icons/react'
```

- [ ] **Step 2: Extend `NavItem` with `'home'` and a `clientOnly` flag**

Old:
```tsx
interface NavItem {
  readonly href: string
  readonly labelKey: 'pipeline' | 'inbox' | 'mail' | 'knowledge' | 'analytics' | 'clients' | 'campaigns' | 'settings'
  readonly icon: ComponentType<IconProps>
  /** Operator-only destinations are hidden from client-role users entirely. */
  readonly operatorOnly?: boolean
}
```
New:
```tsx
interface NavItem {
  readonly href: string
  readonly labelKey:
    | 'home'
    | 'pipeline'
    | 'inbox'
    | 'mail'
    | 'knowledge'
    | 'analytics'
    | 'clients'
    | 'campaigns'
    | 'settings'
  readonly icon: ComponentType<IconProps>
  /** Operator-only destinations are hidden from client-role users entirely. */
  readonly operatorOnly?: boolean
  /** Client-only destinations are hidden from operators entirely (the inverse of operatorOnly). */
  readonly clientOnly?: boolean
}
```

- [ ] **Step 3: Add the Home entry at the top of `PRIMARY_NAV`**

Old:
```tsx
const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/crm', labelKey: 'pipeline', icon: Kanban },
```
New:
```tsx
const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/home', labelKey: 'home', icon: House, clientOnly: true },
  { href: '/crm', labelKey: 'pipeline', icon: Kanban },
```

- [ ] **Step 4: Gate rendering on `clientOnly`**

Old:
```tsx
  const renderItem = (item: NavItem): React.ReactElement | null => {
    if (item.operatorOnly && role !== 'operator') return null
    const active = isActive(pathname, item.href)
```
New:
```tsx
  const renderItem = (item: NavItem): React.ReactElement | null => {
    if (item.operatorOnly && role !== 'operator') return null
    if (item.clientOnly && role !== 'client') return null
    const active = isActive(pathname, item.href)
```

- [ ] **Step 5: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: both pass clean.

- [ ] **Step 6: Commit**

```bash
git add src/components/shell/nav.tsx
git commit -m "feat(nav): add client-only Home nav item

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Home-scoped presentational components

**Files:**
- Create: `src/app/(app)/home/needs-action-card.tsx`
- Create: `src/app/(app)/home/campaign-row.tsx`
- Create: `src/app/(app)/home/lead-row.tsx`

**Interfaces:**
- Consumes: `StatusPill` from `@/components/status-dot`; `CAMPAIGN_STATUS`, `leadEmailStatusMetaFor` from `@/lib/ui/status`; `CompanyMark` from `@/components/company-mark`; `formatAbsolute`, `formatRelative` from `@/lib/format`; `home`/`campaigns` i18n namespaces (Task 3 + existing).
- Produces (consumed by Task 6's `page.tsx`):
  - `NeedsActionCard({ draftCount: number, questionCount: number }): Promise<React.ReactElement>`
  - `CampaignRow({ id: string, name: string, status: Database['public']['Enums']['campaign_status'], dailyTarget: number }): Promise<React.ReactElement>`
  - `LeadRow({ fullName: string, title: string | null, companyName: string | null, companyDomain: string | null, emailStatus: Database['public']['Enums']['lead_email_status'], caseId: string | null, createdAt: string, now: Date }): Promise<React.ReactElement>`

- [ ] **Step 1: Create `src/app/(app)/home/needs-action-card.tsx`**

```tsx
import Link from 'next/link'
import { CheckCircle } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'

interface NeedsActionCardProps {
  draftCount: number
  questionCount: number
}

export async function NeedsActionCard({
  draftCount,
  questionCount,
}: NeedsActionCardProps): Promise<React.ReactElement> {
  const t = await getTranslations('home')
  const total = draftCount + questionCount

  if (total === 0) {
    return (
      <div className="border-hairline bg-surface flex items-center gap-3 rounded-lg border p-4">
        <CheckCircle size={18} weight="light" className="text-faint shrink-0" />
        <div>
          <p className="text-sm font-medium">{t('allCaughtUpTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('allCaughtUpDescription')}</p>
        </div>
      </div>
    )
  }

  return (
    <Link
      href="/inbox"
      className="border-hairline bg-surface hover:bg-surface-raised flex items-center gap-3 rounded-lg border p-4 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      <span className="bg-primary/15 text-primary tnum grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold">
        {total}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t('needsActionTitle')}</p>
        <p className="text-muted-foreground truncate text-xs">
          {draftCount > 0 ? t('draftsCount', { count: draftCount }) : null}
          {draftCount > 0 && questionCount > 0 ? ' · ' : null}
          {questionCount > 0 ? t('questionsCount', { count: questionCount }) : null}
        </p>
      </div>
    </Link>
  )
}
```

- [ ] **Step 2: Create `src/app/(app)/home/campaign-row.tsx`**

```tsx
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { StatusPill } from '@/components/status-dot'
import { CAMPAIGN_STATUS } from '@/lib/ui/status'
import type { Database } from '@/types/database'

interface CampaignRowProps {
  id: string
  name: string
  status: Database['public']['Enums']['campaign_status']
  dailyTarget: number
}

export async function CampaignRow({
  id,
  name,
  status,
  dailyTarget,
}: CampaignRowProps): Promise<React.ReactElement> {
  const t = await getTranslations('campaigns')
  return (
    <Link
      href={`/analytics?campaign=${id}`}
      className="hover:bg-surface-raised flex items-center gap-3 px-3 py-2.5 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{name}</p>
        <p className="text-faint text-[11px]">{t('leadsPerDay', { count: dailyTarget })}</p>
      </div>
      <StatusPill meta={CAMPAIGN_STATUS[status]} className="shrink-0" />
    </Link>
  )
}
```

- [ ] **Step 3: Create `src/app/(app)/home/lead-row.tsx`**

```tsx
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { CompanyMark } from '@/components/company-mark'
import { StatusPill } from '@/components/status-dot'
import { leadEmailStatusMetaFor } from '@/lib/ui/status'
import { formatAbsolute, formatRelative } from '@/lib/format'
import type { Database } from '@/types/database'

interface LeadRowProps {
  fullName: string
  title: string | null
  companyName: string | null
  companyDomain: string | null
  emailStatus: Database['public']['Enums']['lead_email_status']
  caseId: string | null
  createdAt: string
  now: Date
}

export async function LeadRow({
  fullName,
  title,
  companyName,
  companyDomain,
  emailStatus,
  caseId,
  createdAt,
  now,
}: LeadRowProps): Promise<React.ReactElement> {
  const t = await getTranslations('home')
  const subtitle = title && companyName ? `${title} · ${companyName}` : (title ?? companyName ?? '')

  const content = (
    <>
      <CompanyMark name={companyName ?? fullName} domain={companyDomain} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{fullName}</p>
        {subtitle ? <p className="text-faint truncate text-[11px]">{subtitle}</p> : null}
      </div>
      {/* Client-facing view: 'risky' collapses into 'verified' (leadEmailStatusMetaFor), matching cases/[id]/page.tsx. */}
      <StatusPill meta={leadEmailStatusMetaFor(emailStatus, 'client')} className="shrink-0" />
      <time
        dateTime={createdAt}
        title={formatAbsolute(createdAt)}
        className="text-faint w-10 shrink-0 text-right text-[11px]"
      >
        {formatRelative(createdAt, now)}
      </time>
    </>
  )

  if (!caseId) {
    return (
      <div className="flex items-center gap-3 px-3 py-2.5" title={t('noCase')}>
        {content}
      </div>
    )
  }

  return (
    <Link
      href={`/cases/${caseId}`}
      className="hover:bg-surface-raised flex items-center gap-3 px-3 py-2.5 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      {content}
    </Link>
  )
}
```

- [ ] **Step 4: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: both pass clean. (`getTranslations('home')` keys resolve because Task 3 already landed; `campaigns.leadsPerDay` already exists.)

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/home/needs-action-card.tsx" "src/app/(app)/home/campaign-row.tsx" "src/app/(app)/home/lead-row.tsx"
git commit -m "feat(home): add needs-action, campaign, and lead row components

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `/home` route

**Files:**
- Create: `src/app/(app)/home/page.tsx`
- Create: `src/app/(app)/home/loading.tsx`
- Create: `src/app/(app)/home/error.tsx`

**Interfaces:**
- Consumes everything from Tasks 1–5: `StatTile`, `SparklineChart`, `RealtimeRefresher` (`@/components/`), `listRecentLeadsForClient` (`@/lib/db/leads`), `home`/`nav` i18n keys, `NeedsActionCard`/`CampaignRow`/`LeadRow` (route-local).
- Also consumes existing, unmodified functions: `requireUser` (`@/lib/auth/require-user`), `createServerClient` (`@/lib/supabase/server`), `getOverviewMetrics`/`getDailyMetrics` (`@/lib/db/analytics`), `rangeFromDays` (`@/lib/analytics/range`), `formatCount` (`@/lib/analytics/rates`), `listCampaignsForClient` (`@/lib/db/campaigns`), `listEmailsForClient`/`listDraftEmailsForClient` (`@/lib/db/emails`), `listOpenKnowledgeRequestsForClient` (`@/lib/db/knowledge-requests`), `listCaseCompanyNames` (`@/lib/db/crm`), `PageHeader`/`Section` (`@/components/page-header`), `EmptyState` (`@/components/empty-state`), `EmailMessage` (`@/components/email-message`), `PageSkeleton` (`@/components/page-skeleton`), `ErrorPanel` (`@/components/error-panel`).

- [ ] **Step 1: Create `src/app/(app)/home/page.tsx`**

```tsx
import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Envelope, Lightning, Users } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getOverviewMetrics, getDailyMetrics } from '@/lib/db/analytics'
import { rangeFromDays } from '@/lib/analytics/range'
import { formatCount } from '@/lib/analytics/rates'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listRecentLeadsForClient } from '@/lib/db/leads'
import { listEmailsForClient, listDraftEmailsForClient } from '@/lib/db/emails'
import { listOpenKnowledgeRequestsForClient } from '@/lib/db/knowledge-requests'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { PageHeader, Section } from '@/components/page-header'
import { StatTile } from '@/components/stat-tile'
import { SparklineChart } from '@/components/sparkline-chart'
import { RealtimeRefresher } from '@/components/realtime-refresher'
import { EmptyState } from '@/components/empty-state'
import { EmailMessage } from '@/components/email-message'
import { NeedsActionCard } from './needs-action-card'
import { CampaignRow } from './campaign-row'
import { LeadRow } from './lead-row'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Home' }

// Must be one of RANGE_OPTIONS in src/lib/analytics/range.ts (7 | 30 | 90).
const HOME_RANGE_DAYS = 7
const LIST_LIMIT = 5

export default async function HomePage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // Client-only page: an operator has no single client_id to scope a
  // dashboard to, so they keep landing on /crm (the nav also hides this
  // link from them — see src/components/shell/nav.tsx's clientOnly flag).
  if (appUser.role !== 'client' || appUser.client_id === null) {
    redirect('/crm')
  }
  const clientId = appUser.client_id

  const supabase = await createServerClient()
  const t = await getTranslations('home')
  const { from, to } = rangeFromDays(HOME_RANGE_DAYS, new Date())

  const [overview, daily, campaigns, leads, mail, drafts, knowledgeRequests, cases] = await Promise.all([
    getOverviewMetrics(supabase, { from, to, campaignId: null, clientId }),
    getDailyMetrics(supabase, { from, to, campaignId: null, clientId }),
    listCampaignsForClient(supabase, clientId),
    listRecentLeadsForClient(supabase, { limit: LIST_LIMIT }),
    listEmailsForClient(supabase, { direction: 'outbound', limit: LIST_LIMIT }),
    listDraftEmailsForClient(supabase),
    listOpenKnowledgeRequestsForClient(supabase),
    listCaseCompanyNames(supabase),
  ])

  const activeCampaigns = campaigns.filter((campaign) => campaign.status === 'active')
  const companyByCaseId = new Map(cases.map((kase) => [kase.id, kase.companyName]))
  const now = new Date()

  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresher channel="home-metrics" />
      <PageHeader title={t('pageTitle')} description={t('description')} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile index={0} label={t('tile.leadsFound')} value={formatCount(overview.leadsDiscovered)} />
        <StatTile index={1} label={t('tile.emailsSent')} value={formatCount(overview.emailsSent)} />
        <StatTile index={2} label={t('tile.replies')} value={formatCount(overview.repliesReceived)} />
        <StatTile index={3} label={t('tile.activeCampaigns')} value={formatCount(activeCampaigns.length)} />
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title={t('sectionNeedsAction')}>
          <NeedsActionCard draftCount={drafts.length} questionCount={knowledgeRequests.length} />
        </Section>

        <Section title={t('sectionActivityTrend')}>
          <div className="grid gap-3 sm:grid-cols-3">
            <SparklineChart
              index={0}
              title={t('tile.emailsSent')}
              color="var(--status-contacted)"
              total={formatCount(overview.emailsSent)}
              values={daily.map((day) => day.emailsSent)}
            />
            <SparklineChart
              index={1}
              title={t('tile.replies')}
              color="var(--status-won)"
              total={formatCount(overview.repliesReceived)}
              values={daily.map((day) => day.repliesReceived)}
            />
            <SparklineChart
              index={2}
              title={t('tile.leadsFound')}
              color="var(--status-ready)"
              total={formatCount(overview.leadsDiscovered)}
              values={daily.map((day) => day.leadsDiscovered)}
            />
          </div>
        </Section>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Section title={t('sectionRunningCampaigns')}>
          {activeCampaigns.length === 0 ? (
            <EmptyState
              icon={Lightning}
              title={t('emptyCampaignsTitle')}
              description={t('emptyCampaignsDescription')}
            />
          ) : (
            <div className="border-hairline divide-hairline bg-surface animate-rise divide-y overflow-hidden rounded-lg border">
              {activeCampaigns.slice(0, LIST_LIMIT).map((campaign) => (
                <CampaignRow
                  key={campaign.id}
                  id={campaign.id}
                  name={campaign.name}
                  status={campaign.status}
                  dailyTarget={campaign.daily_target}
                />
              ))}
            </div>
          )}
        </Section>

        <Section title={t('sectionLatestLeads')}>
          {leads.length === 0 ? (
            <EmptyState icon={Users} title={t('emptyLeadsTitle')} description={t('emptyLeadsDescription')} />
          ) : (
            <div className="border-hairline divide-hairline bg-surface animate-rise divide-y overflow-hidden rounded-lg border">
              {leads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  fullName={lead.fullName}
                  title={lead.title}
                  companyName={lead.companyName}
                  companyDomain={lead.companyDomain}
                  emailStatus={lead.emailStatus}
                  caseId={lead.caseId}
                  createdAt={lead.createdAt}
                  now={now}
                />
              ))}
            </div>
          )}
        </Section>
      </div>

      <Section
        title={t('sectionRecentMail')}
        aside={
          <Link href="/mail" className="hover:text-foreground transition-colors duration-200">
            {t('viewAllMail')}
          </Link>
        }
      >
        {mail.length === 0 ? (
          <EmptyState icon={Envelope} title={t('emptyMailTitle')} description={t('emptyMailDescription')} />
        ) : (
          <ul className="flex flex-col gap-3">
            {mail.map((email) => {
              const company = email.case_id ? companyByCaseId.get(email.case_id) : undefined
              return (
                <li key={email.id} className="flex flex-col gap-1.5">
                  {email.case_id ? (
                    <Link
                      href={`/cases/${email.case_id}`}
                      className="text-muted-foreground hover:text-foreground w-fit text-[11px] transition-colors duration-200"
                    >
                      {company ?? t('noCase')}
                    </Link>
                  ) : (
                    <span className="text-faint text-[11px]">{t('noCase')}</span>
                  )}
                  <EmailMessage
                    direction={email.direction}
                    status={email.status}
                    subject={email.subject}
                    body={email.body}
                    sequenceStep={email.sequence_step}
                    timestamp={email.sent_at ?? email.created_at}
                    now={now}
                    sentByHuman={email.sent_by !== null}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
```

- [ ] **Step 2: Create `src/app/(app)/home/loading.tsx`**

```tsx
import { PageSkeleton } from '@/components/page-skeleton'

export default function Loading(): React.ReactElement {
  return <PageSkeleton variant="tiles" />
}
```

- [ ] **Step 3: Create `src/app/(app)/home/error.tsx`**

```tsx
'use client'

import { useTranslations } from 'next-intl'
import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('home')
  return <ErrorPanel title={t('errorTitle')} description={t('errorDescription')} reset={reset} />
}
```

- [ ] **Step 4: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: both pass clean.

- [ ] **Step 5: Run the full test suite**

```bash
pnpm test
```
Expected: every existing test still passes (this task adds no new test files — page composition isn't unit-tested anywhere in this codebase, matching the established pattern).

- [ ] **Step 6: Manually verify**

```bash
pnpm dev
```
Sign in as a client-role user. Confirm:
- Landing on `/home` after login is NOT yet true (Task 7 wires that) — navigate to `/home` directly via the new nav link.
- All four stat tiles render with real numbers.
- The needs-your-action card shows the right state (drafts+questions count, or "all caught up").
- The three sparkline charts render.
- Running campaigns and latest leads sections render real rows or their empty states.
- Recent mail renders real messages or its empty state.
- Every row's link target resolves (campaign → `/analytics?campaign=...`, lead → `/cases/[id]` when it has a case, mail's company link → `/cases/[id]`).

Stop the dev server after confirming.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/home/page.tsx" "src/app/(app)/home/loading.tsx" "src/app/(app)/home/error.tsx"
git commit -m "feat(home): add /home client dashboard route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Redirect clients to `/home` after login

**Files:**
- Modify: `src/app/login/page.tsx`

**Interfaces:**
- No new interfaces. Depends on Task 6 existing so the redirect target is real.

- [ ] **Step 1: Read the file, then change the post-sign-in redirect**

Old:
```tsx
    router.push('/crm')
    router.refresh()
```
New:
```tsx
    router.push('/home')
    router.refresh()
```

- [ ] **Step 2: Typecheck and lint**

```bash
pnpm typecheck && pnpm lint
```
Expected: both pass clean.

- [ ] **Step 3: Manually verify both roles land correctly**

```bash
pnpm dev
```
Sign in as a client user → confirm you land on `/home`.
Sign out, sign in as an operator user → confirm you land on `/home` momentarily redirecting to `/crm` (the page.tsx guard from Task 6 fires), or directly on `/crm` if the redirect is fast enough to not flash. Either is correct; what matters is the operator ends up on `/crm`, not stuck on `/home`.
Stop the dev server after confirming.

- [ ] **Step 4: Commit**

```bash
git add src/app/login/page.tsx
git commit -m "feat(auth): redirect clients to /home after login

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Roadmap update and final verification

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Run the full verification suite one more time**

```bash
pnpm typecheck && pnpm lint && pnpm test
```
Expected: all three clean/passing. This is the final gate before calling the feature done.

- [ ] **Step 2: Read `.claude/roadmap.md`, then append a new section at the end of the file**

(Anchor on whatever the current final lines of the file are — there is unrelated, already-in-progress content at the end from a prior session; append after it, do not disturb it.)

```markdown

---

## Client Home Dashboard — 2026-08-11

**Goal:** a `/home` landing page for client-role users summarizing analytics,
running campaigns, latest leads, pending actions, and recent mail —
replacing `/crm` as the post-login destination for clients. Operators are
unaffected, still land on `/crm`.

- [x] Design spec: `docs/superpowers/specs/2026-08-11-client-home-dashboard-design.md`.
- [x] Hoisted `StatTile`, `SparklineChart`, `RealtimeRefresher` out of
      `/analytics` into `src/components/` so `/home` and `/analytics` share
      one implementation (`RealtimeRefresher` gained a required `channel`
      prop).
- [x] `listRecentLeadsForClient` added to `src/lib/db/leads.ts`.
- [x] `/home` route: stat tiles (leads found, emails sent, replies, active
      campaigns), needs-your-action card (drafts + knowledge requests),
      7-day activity trend, running campaigns, latest leads found, recent
      mail — all RLS-scoped, real-time, fully translated (`home` i18n
      namespace + `nav.home`).
- [x] Nav: new `Home` item (client-only) at the top of the primary nav;
      login now redirects clients to `/home` (operators still land on
      `/crm`).

**Demo:** sign in as a client, land on `/home`, see campaigns, leads, mail,
and analytics at a glance; sign in as an operator, still land on `/crm`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs(roadmap): log client home dashboard completion

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
