# Dashboard i18n (English / Turkish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the authenticated dashboard and login/set-password screens into English and Turkish, with a per-user language preference and an operator-set per-client default.

**Architecture:** `next-intl` in its no-URL-routing mode. Locale is resolved server-side, per request, from `app_users.locale` (nullable override) falling back to `clients.default_locale` (client role) or `'en'` (operator role), and from the `Accept-Language` header when there is no session at all (pre-login). No cookies, no URL prefix — every render re-resolves from the DB, so a language change takes effect on next navigation with a plain `revalidatePath`.

**Tech Stack:** Next.js 16 App Router, `next-intl`, Supabase/Postgres, Zod, Vitest.

## Global Constraints

- Supported locales: `en` (default), `tr` — designed to extend later without restructuring.
- No URL-visible locale (`/en/...`) — this is an authenticated dashboard, not an SEO'd site.
- Scope: every static UI string in `src/app/(app)/*/`, `src/components/shell/`, `src/app/login/`, `src/app/set-password/`. Out of scope: business data, AI-drafted email content, `(marketing)` routes.
- Language preference is per-user (`app_users.locale`, nullable = inherit); operators set a per-client default (`clients.default_locale`) that unset client users inherit.
- Language switcher lives only on `/settings`, visible to every role. Operators additionally get a "default language" control on `/clients/[id]`.
- Turkish translations must be real, natural Turkish — never machine-placeholder text.
- Follow this codebase's existing conventions exactly: Server Actions throw `AppError` (settings-style) or return `{ ok: true } | { ok: false; code }` (clients/[id]-style, matching `mailreach-actions.ts`); DB functions live in `src/lib/db/`, destructure `{ data, error }`, throw `AppError('DB_ERROR', ...)`.

---

## Task 1: Migration + `AppLocale` type + hand-edited `database.ts`

**Files:**
- Create: `supabase/migrations/0029_locale_preferences.sql`
- Create: `src/types/i18n.ts`
- Modify: `src/types/database.ts:12-43` (clients table), `src/types/database.ts:44-67` (app_users table), `src/types/database.ts:1034-1035` (Enums)

**Interfaces:**
- Produces: `AppLocale = 'en' | 'tr'`, `SUPPORTED_LOCALES: readonly ['en', 'tr']` from `@/types/i18n`. `ClientRow['default_locale']: AppLocale`, `AppUserRow['locale']: AppLocale | null`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0029_locale_preferences.sql
-- Per-user dashboard language, with an operator-set per-client default that
-- unset users inherit. See
-- docs/superpowers/specs/2026-08-05-dashboard-i18n-design.md

create type app_locale as enum ('en', 'tr');

alter table clients add column default_locale app_locale not null default 'en';
alter table app_users add column locale app_locale;
```

- [ ] **Step 2: Create the shared locale type**

```ts
// src/types/i18n.ts
export const SUPPORTED_LOCALES = ['en', 'tr'] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
```

- [ ] **Step 3: Hand-edit `database.ts` to match the migration**

`database.ts` has no live Supabase connection to regenerate from (see its header comment) — every migration to date has been applied to it by hand. Do the same here.

In `clients.Row` (after `followup_delays_days: number[]`):
```ts
          followup_delays_days: number[]
          default_locale: Database['public']['Enums']['app_locale']
```
In `clients.Insert` (after `followup_delays_days?: number[]`):
```ts
          followup_delays_days?: number[]
          default_locale?: Database['public']['Enums']['app_locale']
```
In `app_users.Row` (after `client_id: string | null`):
```ts
          client_id: string | null
          locale: Database['public']['Enums']['app_locale'] | null
```
In `app_users.Insert` (after `client_id?: string | null`):
```ts
          client_id?: string | null
          locale?: Database['public']['Enums']['app_locale'] | null
```
In `Enums` (after `user_role: 'operator' | 'client'`):
```ts
      user_role: 'operator' | 'client'
      app_locale: 'en' | 'tr'
```

- [ ] **Step 4: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: PASS (no consumer references these fields yet, so nothing should break)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0029_locale_preferences.sql src/types/i18n.ts src/types/database.ts
git commit -m "feat(i18n): add locale columns and AppLocale type"
```

---

## Task 2: Locale Zod schema

**Files:**
- Create: `src/lib/validation/locale.ts`
- Test: `src/lib/validation/locale.test.ts`

**Interfaces:**
- Consumes: `SUPPORTED_LOCALES` from `@/types/i18n` (Task 1)
- Produces: `localeSchema: z.ZodEnum<...>` — `localeSchema.parse`/`safeParse` accepts `'en' | 'tr'`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/validation/locale.test.ts
import { describe, it, expect } from 'vitest'
import { localeSchema } from './locale'

describe('localeSchema', () => {
  it('should accept every supported locale', () => {
    expect(localeSchema.safeParse('en').success).toBe(true)
    expect(localeSchema.safeParse('tr').success).toBe(true)
  })

  it('should reject an unsupported locale string', () => {
    expect(localeSchema.safeParse('fr').success).toBe(false)
  })

  it('should reject a non-string value', () => {
    expect(localeSchema.safeParse(123).success).toBe(false)
    expect(localeSchema.safeParse(null).success).toBe(false)
  })

  it('should reject a missing value', () => {
    expect(localeSchema.safeParse(undefined).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/validation/locale.test.ts`
Expected: FAIL — `Cannot find module './locale'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/validation/locale.ts
import { z } from 'zod'
import { SUPPORTED_LOCALES } from '@/types/i18n'

export const localeSchema = z.enum(SUPPORTED_LOCALES)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/validation/locale.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/locale.ts src/lib/validation/locale.test.ts
git commit -m "feat(i18n): add locale Zod schema"
```

---

## Task 3: `resolveLocale` — server-side locale resolution

**Files:**
- Create: `src/lib/i18n/resolve-locale.ts`
- Test: `src/lib/i18n/resolve-locale.test.ts`

**Interfaces:**
- Consumes: `AppLocale`, `SUPPORTED_LOCALES` (`@/types/i18n`, Task 1); `createServerClient` (`@/lib/supabase/server`); `getAppUser` (`@/lib/db/app-users`); `getClientById` (`@/lib/db/clients`); `headers` (`next/headers`)
- Produces: `resolveLocale(): Promise<AppLocale>` — the single source of truth every later task reads the current locale from (via `next-intl`'s `getLocale()`/`useTranslations()`, which internally call this through `i18n/request.ts` in Task 4).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/i18n/resolve-locale.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUser = vi.fn()
const getAppUser = vi.fn()
const getClientById = vi.fn()
const headersGet = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({ auth: { getUser } }),
}))
vi.mock('@/lib/db/app-users', () => ({ getAppUser: (...a: unknown[]) => getAppUser(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientById(...a) }))
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve({ get: (name: string) => headersGet(name) }),
}))

const { resolveLocale } = await import('./resolve-locale')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('resolveLocale', () => {
  it('should fall back to Accept-Language when there is no session', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    headersGet.mockReturnValue('tr-TR,tr;q=0.9,en;q=0.8')

    await expect(resolveLocale()).resolves.toBe('tr')
    expect(getAppUser).not.toHaveBeenCalled()
  })

  it('should default to en when Accept-Language has no supported tag', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    headersGet.mockReturnValue('fr-FR,fr;q=0.9')

    await expect(resolveLocale()).resolves.toBe('en')
  })

  it('should default to en when there is no session and no Accept-Language header', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    headersGet.mockReturnValue(null)

    await expect(resolveLocale()).resolves.toBe('en')
  })

  it("should use the user's own override when set", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    getAppUser.mockResolvedValue({ id: 'u1', role: 'client', client_id: 'c1', locale: 'tr' })

    await expect(resolveLocale()).resolves.toBe('tr')
    expect(getClientById).not.toHaveBeenCalled()
  })

  it("should fall back to the client's default when a client user has no override", async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1' } } })
    getAppUser.mockResolvedValue({ id: 'u1', role: 'client', client_id: 'c1', locale: null })
    getClientById.mockResolvedValue({ id: 'c1', default_locale: 'tr' })

    await expect(resolveLocale()).resolves.toBe('tr')
  })

  it('should default an operator with no override to en', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'op1' } } })
    getAppUser.mockResolvedValue({ id: 'op1', role: 'operator', client_id: null, locale: null })

    await expect(resolveLocale()).resolves.toBe('en')
    expect(getClientById).not.toHaveBeenCalled()
  })

  it('should default to en when the session has no app_users row', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'ghost' } } })
    getAppUser.mockResolvedValue(null)

    await expect(resolveLocale()).resolves.toBe('en')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/i18n/resolve-locale.test.ts`
Expected: FAIL — `Cannot find module './resolve-locale'`

- [ ] **Step 3: Write the implementation**

```ts
// src/lib/i18n/resolve-locale.ts
import { cache } from 'react'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'
import { getAppUser } from '@/lib/db/app-users'
import { getClientById } from '@/lib/db/clients'
import { SUPPORTED_LOCALES, type AppLocale } from '@/types/i18n'

const DEFAULT_LOCALE: AppLocale = 'en'

function isSupportedLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

// Parses the first acceptable primary language subtag out of an
// Accept-Language header, e.g. "tr-TR,tr;q=0.9,en;q=0.8" -> "tr". Used only
// pre-login, where there is no stored preference yet — ignores quality
// weighting beyond taking the browser's preference order at face value.
function parseAcceptLanguage(header: string | null): AppLocale {
  if (!header) return DEFAULT_LOCALE
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().split('-')[0]
    if (tag && isSupportedLocale(tag)) return tag
  }
  return DEFAULT_LOCALE
}

async function resolvePreloginLocale(): Promise<AppLocale> {
  const headerList = await headers()
  return parseAcceptLanguage(headerList.get('accept-language'))
}

/**
 * Resolves the locale to render for the current request: the signed-in
 * user's own preference, falling back to their client's default (client
 * role) or 'en' (operator role with no override); falling back further to
 * the browser's Accept-Language header when there is no session at all
 * (pre-login pages).
 *
 * Wrapped in React's `cache()` so every call within one request's render
 * tree — `i18n/request.ts`, plus any Server Component that asks directly —
 * shares a single result and a single DB round trip, no matter how many
 * places call it.
 */
export const resolveLocale = cache(async (): Promise<AppLocale> => {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return resolvePreloginLocale()

  const appUser = await getAppUser(supabase, data.user.id)
  if (!appUser) return DEFAULT_LOCALE
  if (appUser.locale) return appUser.locale

  if (appUser.role === 'client' && appUser.client_id) {
    const client = await getClientById(supabase, appUser.client_id)
    if (client && isSupportedLocale(client.default_locale)) return client.default_locale
  }
  return DEFAULT_LOCALE
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/i18n/resolve-locale.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/i18n/resolve-locale.ts src/lib/i18n/resolve-locale.test.ts
git commit -m "feat(i18n): add server-side locale resolution"
```

---

## Task 4: `next-intl` wiring + message files + parity test

**Files:**
- Modify: `next.config.ts`
- Create: `src/i18n/request.ts`
- Create: `src/messages/en.json`, `src/messages/tr.json`
- Test: `src/messages/messages.test.ts`
- Modify: `package.json` (add `next-intl` dependency)

**Interfaces:**
- Consumes: `resolveLocale` (`@/lib/i18n/resolve-locale`, Task 3)
- Produces: `common.*` message keys consumed starting Task 6; `getRequestConfig` wiring that every later `useTranslations`/`getTranslations` call depends on.

- [ ] **Step 1: Install the dependency**

Run: `pnpm add next-intl`

- [ ] **Step 2: Write the message files**

```json
// src/messages/en.json
{
  "common": {
    "save": "Save",
    "saving": "Saving…",
    "cancel": "Cancel",
    "close": "Close",
    "delete": "Delete",
    "edit": "Edit",
    "loading": "Loading…",
    "retry": "Retry",
    "error": "Something went wrong",
    "language": "Language",
    "english": "English",
    "turkish": "Turkish",
    "yes": "Yes",
    "no": "No",
    "confirm": "Confirm"
  }
}
```

```json
// src/messages/tr.json
{
  "common": {
    "save": "Kaydet",
    "saving": "Kaydediliyor…",
    "cancel": "İptal",
    "close": "Kapat",
    "delete": "Sil",
    "edit": "Düzenle",
    "loading": "Yükleniyor…",
    "retry": "Tekrar dene",
    "error": "Bir şeyler ters gitti",
    "language": "Dil",
    "english": "İngilizce",
    "turkish": "Türkçe",
    "yes": "Evet",
    "no": "Hayır",
    "confirm": "Onayla"
  }
}
```

- [ ] **Step 3: Write the failing parity test**

```ts
// src/messages/messages.test.ts
import { describe, it, expect } from 'vitest'
import en from './en.json'
import tr from './tr.json'

// Recursively collects every leaf key path, e.g. "common.save", so a
// namespace or key added to one locale and forgotten in the other fails CI
// instead of silently falling back — or breaking — at runtime.
function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return [prefix]
  return Object.entries(value).flatMap(([key, child]) =>
    collectKeyPaths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('message catalogs', () => {
  it('should have identical key structure across every locale', () => {
    expect(collectKeyPaths(tr).sort()).toEqual(collectKeyPaths(en).sort())
  })

  it('should have no empty string values in either locale', () => {
    for (const catalog of [en, tr]) {
      for (const path of collectKeyPaths(catalog)) {
        const value = path.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], catalog)
        expect(typeof value === 'string' && value.trim().length > 0, `${path} must not be empty`).toBe(true)
      }
    }
  })
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS (2 tests) — both files already match since they were authored together

- [ ] **Step 5: Wire the request config**

```ts
// src/i18n/request.ts
import { getRequestConfig } from 'next-intl/server'
import { resolveLocale } from '@/lib/i18n/resolve-locale'

export default getRequestConfig(async () => {
  const locale = await resolveLocale()
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  }
})
```

- [ ] **Step 6: Wrap `next.config.ts` with the plugin**

```ts
// next.config.ts — add these two lines
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
```

And change the final export from `export default nextConfig;` to:

```ts
export default withNextIntl(nextConfig);
```

- [ ] **Step 7: Verify the project still builds and typechecks**

Run: `pnpm typecheck && pnpm vitest run src/messages/messages.test.ts src/lib/i18n/resolve-locale.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml next.config.ts src/i18n/request.ts src/messages/en.json src/messages/tr.json src/messages/messages.test.ts
git commit -m "feat(i18n): wire up next-intl with common message catalog"
```

---

## Task 5: Root layout — `NextIntlClientProvider` + dynamic `<html lang>`

**Files:**
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Consumes: `getLocale`, `getMessages` (`next-intl/server`); `NextIntlClientProvider` (`next-intl`) — reads the config Task 4 wired, no direct call to `resolveLocale`.
- Produces: every Client/Server Component under this layout can now call `useTranslations`/`getTranslations`.

- [ ] **Step 1: Make the root layout async and provide the locale**

In `src/app/layout.tsx`, change the signature and body:

```tsx
// Before
export default function RootLayout({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
```

```tsx
// After
import { getLocale, getMessages } from 'next-intl/server'
import { NextIntlClientProvider } from 'next-intl'

export default async function RootLayout({ children }: { children: ReactNode }): Promise<React.ReactElement> {
  const locale = await getLocale()
  const messages = await getMessages()

  return (
    <html
      lang={locale}
      className={`${inter.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
```

And wrap the `<body>` contents:

```tsx
// Before
      <body>
        {GTM_ID !== undefined && ( /* ... */ )}
        {children}
        {GTM_ID !== undefined && <ConsentBanner />}
        <Toaster position="bottom-right" />
      </body>
```

```tsx
// After
      <body>
        {GTM_ID !== undefined && ( /* ... */ )}
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
          {GTM_ID !== undefined && <ConsentBanner />}
          <Toaster position="bottom-right" />
        </NextIntlClientProvider>
      </body>
```

Note: an unauthenticated visitor on a `(marketing)` page (out of scope for translated content) still resolves a locale via `resolvePreloginLocale`'s `Accept-Language` parsing, so `<html lang>` may occasionally read `tr` while marketing copy stays English. Accepted — marketing i18n is explicitly out of scope (see spec §2), this is a cosmetic attribute only, and today's behavior (`lang="en"` always) was already only "correct" by coincidence.

- [ ] **Step 2: Verify the app still builds**

Run: `pnpm typecheck && pnpm build`
Expected: PASS. (`pnpm build` requires the env vars in `.env.local`/CI to be present, same as before this change — no new requirement.)

- [ ] **Step 3: Commit**

```bash
git add src/app/layout.tsx
git commit -m "feat(i18n): provide locale and messages from the root layout"
```

---

## Task 6: Settings — language switcher (`updateMyLocale`)

**Files:**
- Create: `src/lib/db/app-users.ts` → add `updateUserLocale` (modify existing file)
- Test: `src/lib/db/app-users.test.ts` → add test for `updateUserLocale`
- Create: `src/app/(app)/settings/locale-actions.ts`
- Test: `src/app/(app)/settings/locale-actions.test.ts`
- Create: `src/app/(app)/settings/language-section.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (add `settings.language*` keys)

**Interfaces:**
- Consumes: `AppLocale` (`@/types/i18n`), `localeSchema` (`@/lib/validation/locale`), `resolveLocale` (`@/lib/i18n/resolve-locale`), `requireUser`, `createAdminClient`, `logEvent`, `AppError`
- Produces: `updateUserLocale(supabase, userId, locale): Promise<AppUser>`; `updateMyLocale(locale: AppLocale): Promise<void>`; `<LanguageSection currentLocale={AppLocale} />`

- [ ] **Step 1: Write the failing DB test**

Add to `src/lib/db/app-users.test.ts`:

```ts
import { getAppUser, updateUserLocale } from './app-users'
```

```ts
describe('updateUserLocale', () => {
  it('should persist the locale and return the updated row', async () => {
    const row = { id: 'u1', role: 'client', client_id: 'c1', locale: 'tr' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateUserLocale({ from: () => ({ update }) } as never, 'u1', 'tr')
    expect(update).toHaveBeenCalledWith({ locale: 'tr' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateUserLocale({ from: () => ({ update }) } as never, 'u1', 'tr'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

(Add `vi` to the existing `import { describe, it, expect } from 'vitest'` → `import { describe, it, expect, vi } from 'vitest'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/app-users.test.ts`
Expected: FAIL — `updateUserLocale` is not exported

- [ ] **Step 3: Implement `updateUserLocale`**

Add to `src/lib/db/app-users.ts`:

```ts
import type { AppLocale } from '@/types/i18n'
```

```ts
export async function updateUserLocale(
  supabase: SupabaseClient<Database>,
  userId: string,
  locale: AppLocale,
): Promise<AppUser> {
  const { data, error } = await supabase
    .from('app_users')
    .update({ locale })
    .eq('id', userId)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update user locale', { userId, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/app-users.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing Server Action test**

```ts
// src/app/(app)/settings/locale-actions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const updateUserLocale = vi.fn()
const logEvent = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/app-users', () => ({ updateUserLocale: (...a: unknown[]) => updateUserLocale(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))

const { updateMyLocale } = await import('./locale-actions')

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  updateUserLocale.mockResolvedValue({ id: 'u1', locale: 'tr' })
})

describe('updateMyLocale', () => {
  it("should update the caller's own locale", async () => {
    await updateMyLocale('tr')
    expect(updateUserLocale).toHaveBeenCalledWith({}, 'u1', 'tr')
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'user.locale_changed', payload: { locale: 'tr' } }),
    )
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout')
  })

  it('should allow an operator (no client_id) to set their own locale', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    await updateMyLocale('en')
    expect(updateUserLocale).toHaveBeenCalledWith({}, 'op1', 'en')
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ clientId: null }))
  })

  it('should reject an unsupported locale', async () => {
    await expect(updateMyLocale('fr' as never)).rejects.toThrow()
    expect(updateUserLocale).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run src/app/\(app\)/settings/locale-actions.test.ts`
Expected: FAIL — `Cannot find module './locale-actions'`

- [ ] **Step 7: Implement the Server Action**

```ts
// src/app/(app)/settings/locale-actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateUserLocale } from '@/lib/db/app-users'
import { localeSchema } from '@/lib/validation/locale'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'
import type { AppLocale } from '@/types/i18n'

// Every signed-in user — operator or client — owns their own language
// preference; there is no role gate here (contrast updateClientDefaultLocale
// in clients/[id]/locale-actions.ts, which is operator-only). Revalidates the
// whole layout, not just /settings, since language affects every page.
export async function updateMyLocale(locale: AppLocale): Promise<void> {
  const { appUser } = await requireUser()

  const parsed = localeSchema.safeParse(locale)
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid locale', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateUserLocale(admin, appUser.id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'user.locale_changed',
    payload: { locale: parsed.data },
  })
  revalidatePath('/', 'layout')
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run src/app/\(app\)/settings/locale-actions.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 9: Add the `settings.language*` message keys**

Add to `src/messages/en.json`, as a new top-level key:

```json
  "settings": {
    "languageSectionTitle": "Language",
    "languageLabel": "Dashboard language",
    "languageSaveFailed": "Could not save that change. Please try again."
  }
```

Add to `src/messages/tr.json`:

```json
  "settings": {
    "languageSectionTitle": "Dil",
    "languageLabel": "Panel dili",
    "languageSaveFailed": "Bu değişiklik kaydedilemedi. Lütfen tekrar deneyin."
  }
```

- [ ] **Step 10: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 11: Build the language switcher component**

```tsx
// src/app/(app)/settings/language-section.tsx
'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateMyLocale } from './locale-actions'
import type { AppLocale } from '@/types/i18n'

const LOCALES: readonly AppLocale[] = ['en', 'tr']

interface LanguageSectionProps {
  currentLocale: AppLocale
}

export function LanguageSection({ currentLocale }: LanguageSectionProps): React.ReactElement {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const [locale, setLocale] = useState<AppLocale>(currentLocale)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onChange(next: AppLocale): void {
    const previous = locale
    setError(null)
    setLocale(next)
    startTransition(async () => {
      try {
        await updateMyLocale(next)
      } catch {
        setError(t('languageSaveFailed'))
        setLocale(previous)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">{t('languageLabel')}</span>
        <select
          value={locale}
          disabled={isPending}
          onChange={(event) => onChange(event.target.value as AppLocale)}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {LOCALES.map((value) => (
            <option key={value} value={value}>
              {tCommon(value === 'en' ? 'english' : 'turkish')}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 12: Wire it into the Settings page**

In `src/app/(app)/settings/page.tsx`, add the import:

```ts
import { LanguageSection } from './language-section'
import { resolveLocale } from '@/lib/i18n/resolve-locale'
import { getTranslations } from 'next-intl/server'
```

Inside `SettingsPage`, after `const { appUser } = await requireUser()`, add:

```ts
  const currentLocale = await resolveLocale()
  const t = await getTranslations('settings')
```

And render the section — insert right after the `<PageHeader ... />` block (before the `{client ? (<Section title="Reply mode">...` block):

```tsx
      <Section title={t('languageSectionTitle')}>
        <LanguageSection currentLocale={currentLocale} />
      </Section>
```

- [ ] **Step 13: Verify build and full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/lib/db/app-users.ts src/lib/db/app-users.test.ts src/app/\(app\)/settings/locale-actions.ts src/app/\(app\)/settings/locale-actions.test.ts src/app/\(app\)/settings/language-section.tsx src/app/\(app\)/settings/page.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): add per-user language switcher on Settings"
```

---

## Task 7: Clients[id] — operator default-language control (`updateClientDefaultLocale`)

**Files:**
- Modify: `src/lib/db/clients.ts` → add `updateClientDefaultLocale`
- Modify: `src/lib/db/clients.test.ts` → add test
- Create: `src/app/(app)/clients/[id]/locale-actions.ts`
- Test: `src/app/(app)/clients/[id]/locale-actions.test.ts`
- Create: `src/app/(app)/clients/[id]/default-locale-select.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (add `clients.defaultLanguage*` keys)

**Interfaces:**
- Consumes: `AppLocale`, `localeSchema`, `requireUser`, `createAdminClient`, `getClientById`, `logEvent`, `AppError`/`isAppError`/`AppErrorCode`
- Produces: `updateClientDefaultLocale(supabase, id, locale): Promise<ClientRow>` (DB layer — note the Server Action of the same name wraps this, see Step 7); `<DefaultLocaleSelect clientId value />`

- [ ] **Step 1: Write the failing DB test**

Add to `src/lib/db/clients.test.ts` (near `updateClientReplyMode`'s import and describe block):

```ts
import { updateClientDefaultLocale } from './clients'
```

```ts
describe('updateClientDefaultLocale', () => {
  it('should persist the default locale and return the updated row', async () => {
    const row = { id: 'c1', default_locale: 'tr' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientDefaultLocale({ from: () => ({ update }) } as never, 'c1', 'tr')
    expect(update).toHaveBeenCalledWith({ default_locale: 'tr' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientDefaultLocale({ from: () => ({ update }) } as never, 'c1', 'tr'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: FAIL — `updateClientDefaultLocale` is not exported

- [ ] **Step 3: Implement the DB function**

Add to `src/lib/db/clients.ts` (near `updateClientReplyMode`), importing `AppLocale` from `@/types/i18n`:

```ts
export async function updateClientDefaultLocale(
  supabase: SupabaseClient<Database>,
  id: string,
  locale: AppLocale,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ default_locale: locale })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client default locale', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing Server Action test**

```ts
// src/app/(app)/clients/[id]/locale-actions.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getClientById = vi.fn()
const updateClientDefaultLocaleRow = vi.fn()
const logEvent = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientById(...a),
  updateClientDefaultLocale: (...a: unknown[]) => updateClientDefaultLocaleRow(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))

const { updateClientDefaultLocale } = await import('./locale-actions')

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  getClientById.mockResolvedValue({ id: 'c1', name: 'Acme', default_locale: 'en' })
  updateClientDefaultLocaleRow.mockResolvedValue({ id: 'c1', name: 'Acme', default_locale: 'tr' })
})

describe('updateClientDefaultLocale', () => {
  it('should update the client default language', async () => {
    const result = await updateClientDefaultLocale('c1', 'tr')
    expect(result).toEqual({ ok: true })
    expect(updateClientDefaultLocaleRow).toHaveBeenCalledWith({}, 'c1', 'tr')
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.default_locale_changed', payload: { from: 'en', to: 'tr' } }),
    )
    expect(revalidatePath).toHaveBeenCalledWith('/clients/c1')
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    const result = await updateClientDefaultLocale('c1', 'tr')
    expect(result).toEqual({ ok: false, code: 'UNAUTHORIZED' })
    expect(updateClientDefaultLocaleRow).not.toHaveBeenCalled()
  })

  it('should reject an unknown client', async () => {
    getClientById.mockResolvedValue(null)
    const result = await updateClientDefaultLocale('missing', 'tr')
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' })
  })

  it('should reject an unsupported locale', async () => {
    const result = await updateClientDefaultLocale('c1', 'fr' as never)
    expect(result).toEqual({ ok: false, code: 'VALIDATION_ERROR' })
    expect(updateClientDefaultLocaleRow).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 6: Run test to verify it fails**

Run: `pnpm vitest run src/app/\(app\)/clients/\[id\]/locale-actions.test.ts`
Expected: FAIL — `Cannot find module './locale-actions'`

- [ ] **Step 7: Implement the Server Action**

Matches `mailreach-actions.ts`'s shape exactly (typed `{ ok: true } | { ok: false; code }` result, operator-only `UNAUTHORIZED`).

```ts
// src/app/(app)/clients/[id]/locale-actions.ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientDefaultLocale as updateClientDefaultLocaleRow } from '@/lib/db/clients'
import { localeSchema } from '@/lib/validation/locale'
import { logEvent } from '@/lib/events/log-event'
import { AppError, isAppError, type AppErrorCode } from '@/lib/errors/app-error'
import type { AppLocale } from '@/types/i18n'

export type SetClientDefaultLocaleResult = { ok: true } | { ok: false; code: AppErrorCode }

export async function updateClientDefaultLocale(
  clientId: string,
  locale: AppLocale,
): Promise<SetClientDefaultLocaleResult> {
  try {
    await updateClientDefaultLocaleUnsafe(clientId, locale)
    return { ok: true }
  } catch (error) {
    if (isAppError(error)) return { ok: false, code: error.code }
    throw error
  }
}

async function updateClientDefaultLocaleUnsafe(clientId: string, locale: AppLocale): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', "Only an operator can change a client's default language", {
      clientId,
      userId: appUser.id,
    })
  }

  const parsed = localeSchema.safeParse(locale)
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid locale', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) throw new AppError('NOT_FOUND', 'Client not found', { clientId })

  await updateClientDefaultLocaleRow(admin, clientId, parsed.data)
  await logEvent({
    clientId,
    actor: `human:${appUser.id}`,
    type: 'client.default_locale_changed',
    payload: { from: client.default_locale, to: parsed.data },
  })
  // Every (app) page is `dynamic = 'force-dynamic'`, so this isn't strictly
  // required for correctness (every request re-resolves the locale fresh) —
  // kept for consistency with the sibling actions in this file's directory.
  revalidatePath(`/clients/${clientId}`)
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm vitest run src/app/\(app\)/clients/\[id\]/locale-actions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Add the `clients.defaultLanguage*` message keys**

Add to `src/messages/en.json`, as a new top-level key:

```json
  "clients": {
    "defaultLanguageLabel": "Default language",
    "defaultLanguageHint": "New users at this client start in this language until they set their own.",
    "defaultLanguageSaveFailed": "Could not save that. Please try again."
  }
```

Add to `src/messages/tr.json`:

```json
  "clients": {
    "defaultLanguageLabel": "Varsayılan dil",
    "defaultLanguageHint": "Bu müşterideki yeni kullanıcılar, kendi dillerini seçene kadar bu dille başlar.",
    "defaultLanguageSaveFailed": "Kaydedilemedi. Lütfen tekrar deneyin."
  }
```

- [ ] **Step 10: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 11: Build the select component**

Mirrors `warmup-profile-select.tsx`'s layout, calling the Server Action directly instead of `fetch`:

```tsx
// src/app/(app)/clients/[id]/default-locale-select.tsx
'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { updateClientDefaultLocale } from './locale-actions'
import type { AppLocale } from '@/types/i18n'

const LOCALES: readonly AppLocale[] = ['en', 'tr']

interface DefaultLocaleSelectProps {
  clientId: string
  value: AppLocale
}

export function DefaultLocaleSelect({ clientId, value }: DefaultLocaleSelectProps): React.ReactElement {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const [locale, setLocale] = useState<AppLocale>(value)
  const [isPending, startTransition] = useTransition()

  function onChange(next: AppLocale): void {
    const previous = locale
    setLocale(next)
    startTransition(async () => {
      const result = await updateClientDefaultLocale(clientId, next)
      if (!result.ok) {
        setLocale(previous)
        toast.error(t('defaultLanguageSaveFailed'))
      }
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`default-locale-${clientId}`} className="text-faint text-[11px]" title={t('defaultLanguageHint')}>
        {t('defaultLanguageLabel')}
      </label>
      <select
        id={`default-locale-${clientId}`}
        value={locale}
        disabled={isPending}
        onChange={(event) => onChange(event.target.value as AppLocale)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {tCommon(option === 'en' ? 'english' : 'turkish')}
          </option>
        ))}
      </select>
    </div>
  )
}
```

- [ ] **Step 12: Wire it into the client detail page**

`src/app/(app)/clients/[id]/page.tsx` already gates the whole route to operators (verify this at the top of the file before proceeding — it fetches `client`/`campaigns`/`users` the same way `WarmupProfileSelect` and `MailreachToggle` already render unconditionally there). Add the import:

```ts
import { DefaultLocaleSelect } from './default-locale-select'
```

In the controls row that currently renders `ClientLifecycleActions`, `WarmupProfileSelect`, `MailreachToggle` (around the `<div className="flex flex-wrap items-center gap-3">` block), add:

```tsx
            <DefaultLocaleSelect clientId={client.id} value={client.default_locale} />
```

- [ ] **Step 13: Verify build and full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 14: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts src/app/\(app\)/clients/\[id\]/locale-actions.ts src/app/\(app\)/clients/\[id\]/locale-actions.test.ts src/app/\(app\)/clients/\[id\]/default-locale-select.tsx src/app/\(app\)/clients/\[id\]/page.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): add operator control for a client's default language"
```

---

## Task 8: Shell & Nav namespace

**Files:**
- Modify: `src/components/shell/nav.tsx`
- Modify: `src/components/shell/app-shell.tsx`
- Modify: `src/components/shell/theme-toggle.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (add `nav` namespace)

**Interfaces:**
- Consumes: `useTranslations` (`next-intl`) — every string in this task is in a `'use client'` component
- Produces: `nav.*` keys — establishes the extraction pattern every later content task repeats: read the file, find every literal user-facing string (including `aria-label`, `title`, `alt`), replace with `t('key')`, add both locale entries.

- [ ] **Step 1: Add the `nav` message keys**

Add to `src/messages/en.json`:

```json
  "nav": {
    "pipeline": "Pipeline",
    "inbox": "Inbox",
    "mail": "Mail",
    "knowledge": "Knowledge",
    "analytics": "Analytics",
    "clients": "Clients",
    "campaigns": "Campaigns",
    "settings": "Settings",
    "awaitingYou": "{count} awaiting you",
    "signOut": "Sign out"
  }
```

Add to `src/messages/tr.json`:

```json
  "nav": {
    "pipeline": "Fırsatlar",
    "inbox": "Gelen Kutusu",
    "mail": "E-posta",
    "knowledge": "Bilgi Bankası",
    "analytics": "Analitik",
    "clients": "Müşteriler",
    "campaigns": "Kampanyalar",
    "settings": "Ayarlar",
    "awaitingYou": "{count} işlem bekliyor",
    "signOut": "Çıkış yap"
  }
```

- [ ] **Step 2: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 3: Translate `nav.tsx`**

Replace the hardcoded `label` values with translation keys, and translate the `aria-label`. Full before/after:

```tsx
// Before
interface NavItem {
  readonly href: string
  readonly label: string
  readonly icon: ComponentType<IconProps>
  readonly operatorOnly?: boolean
}

const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/crm', label: 'Pipeline', icon: Kanban },
  { href: '/inbox', label: 'Inbox', icon: Tray },
  { href: '/mail', label: 'Mail', icon: Envelope },
  { href: '/knowledge', label: 'Knowledge', icon: Stack },
  { href: '/analytics', label: 'Analytics', icon: ChartLineUp },
]

const SECONDARY_NAV: readonly NavItem[] = [
  { href: '/clients', label: 'Clients', icon: Buildings, operatorOnly: true },
  { href: '/campaigns', label: 'Campaigns', icon: Lightning, operatorOnly: true },
  { href: '/settings', label: 'Settings', icon: Gear },
]
```

```tsx
// After
import { useTranslations } from 'next-intl'

interface NavItem {
  readonly href: string
  readonly labelKey: 'pipeline' | 'inbox' | 'mail' | 'knowledge' | 'analytics' | 'clients' | 'campaigns' | 'settings'
  readonly icon: ComponentType<IconProps>
  readonly operatorOnly?: boolean
}

const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/crm', labelKey: 'pipeline', icon: Kanban },
  { href: '/inbox', labelKey: 'inbox', icon: Tray },
  { href: '/mail', labelKey: 'mail', icon: Envelope },
  { href: '/knowledge', labelKey: 'knowledge', icon: Stack },
  { href: '/analytics', labelKey: 'analytics', icon: ChartLineUp },
]

const SECONDARY_NAV: readonly NavItem[] = [
  { href: '/clients', labelKey: 'clients', icon: Buildings, operatorOnly: true },
  { href: '/campaigns', labelKey: 'campaigns', icon: Lightning, operatorOnly: true },
  { href: '/settings', labelKey: 'settings', icon: Gear },
]
```

Inside `Nav`, add `const t = useTranslations('nav')` at the top of the function body, then in `renderItem`, replace `{item.label}` with `{t(item.labelKey)}`, and the badge's `aria-label`:

```tsx
// Before
          <span
            className="bg-primary/15 text-primary tnum ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            aria-label={`${badge} awaiting you`}
          >
```

```tsx
// After
          <span
            className="bg-primary/15 text-primary tnum ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            aria-label={t('awaitingYou', { count: badge })}
          >
```

- [ ] **Step 4: Translate the sign-out button in `app-shell.tsx`**

Find the `Sign out` button (`aria-label="Sign out"`, `title="Sign out"`) in `SidebarBody`. Add `const t = useTranslations('nav')` inside `SidebarBody`, and replace both attributes:

```tsx
// Before
            aria-label="Sign out"
            title="Sign out"
```

```tsx
// After
            aria-label={t('signOut')}
            title={t('signOut')}
```

- [ ] **Step 5: Check `theme-toggle.tsx` for hardcoded strings**

Read `src/components/shell/theme-toggle.tsx`. If it renders any user-facing label/`aria-label`/`title` (e.g. "Toggle theme", "Light", "Dark"), add a `common.themeLight`/`common.themeDark`/`common.toggleTheme`-style key to both message files (namespace `common`, since a theme toggle isn't page-specific) and wire `useTranslations('common')` the same way as Step 4. If the component is icon-only with no user-facing text at all, no change is needed — note that explicitly rather than silently skipping it.

- [ ] **Step 6: Manually verify**

Run: `pnpm dev`, sign in as a client-role user, set language to Turkish on `/settings` (Task 6), and confirm every nav item, the awaiting-count badge, and the sign-out control render in Turkish. Switch back to English and confirm parity.

- [ ] **Step 7: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/components/shell/nav.tsx src/components/shell/app-shell.tsx src/components/shell/theme-toggle.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate app shell and nav"
```

---

## Task 9: Auth namespace (`/login`, `/set-password`)

**Files:**
- Modify: `src/app/login/page.tsx`
- Modify: `src/app/set-password/page.tsx`
- Modify: `src/app/set-password/set-password-form.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (add `auth` namespace)

Not in scope: `src/app/login/layout.tsx` — it only exports `metadata` (title/description/robots), which Next.js requires to be static or generated server-side outside the component tree; translating `<meta>` tags is a separate, unrequested concern (see spec §7, "static UI chrome" — metadata isn't rendered UI).

**Interfaces:**
- Consumes: `useTranslations` (`next-intl`) — both files are `'use client'`
- Produces: `auth.*` keys

- [ ] **Step 1: Add the `auth` message keys**

Add to `src/messages/en.json`:

```json
  "auth": {
    "brand": "Shengul AI",
    "signInTitle": "Sign in",
    "signInSubtitle": "Your outreach pipeline, mail and case knowledge.",
    "emailLabel": "Email",
    "passwordLabel": "Password",
    "signInButton": "Sign in",
    "signingIn": "Signing in…",
    "signInError": "That email and password combination did not work.",
    "setPasswordTitle": "Set your password",
    "setPasswordSubtitle": "Signed in as {email}. Choose a password to finish setting up your account.",
    "newPasswordLabel": "New password",
    "confirmPasswordLabel": "Confirm password",
    "setPasswordButton": "Set password and continue",
    "settingPassword": "Saving…",
    "passwordTooShort": "Password must be at least {min} characters.",
    "passwordMismatch": "Passwords do not match.",
    "setPasswordError": "Could not set your password. Try requesting a new invite link."
  }
```

Add to `src/messages/tr.json`:

```json
  "auth": {
    "brand": "Shengul AI",
    "signInTitle": "Giriş yap",
    "signInSubtitle": "Gönderim akışınız, e-postalarınız ve vaka bilgileriniz.",
    "emailLabel": "E-posta",
    "passwordLabel": "Şifre",
    "signInButton": "Giriş yap",
    "signingIn": "Giriş yapılıyor…",
    "signInError": "Bu e-posta ve şifre birlikte çalışmadı.",
    "setPasswordTitle": "Şifrenizi belirleyin",
    "setPasswordSubtitle": "{email} olarak giriş yaptınız. Hesabınızı tamamlamak için bir şifre seçin.",
    "newPasswordLabel": "Yeni şifre",
    "confirmPasswordLabel": "Şifreyi onayla",
    "setPasswordButton": "Şifreyi belirle ve devam et",
    "settingPassword": "Kaydediliyor…",
    "passwordTooShort": "Şifre en az {min} karakter olmalıdır.",
    "passwordMismatch": "Şifreler eşleşmiyor.",
    "setPasswordError": "Şifreniz belirlenemedi. Yeni bir davet bağlantısı isteyin."
  }
```

- [ ] **Step 2: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 3: Translate `login/page.tsx`**

```tsx
// Before
export default function LoginPage(): React.ReactElement {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    const supabase = createBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setError('That email and password combination did not work.')
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Your outreach pipeline, mail and case knowledge.
        </p>
```
```tsx
        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4" noValidate={false}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-xs">
              Email
            </Label>
```
```tsx
          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-xs">
              Password
            </Label>
```
```tsx
          <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
            {isSubmitting ? 'Signing in…' : 'Sign in'}
          </Button>
```

```tsx
// After
import { useTranslations } from 'next-intl'

export default function LoginPage(): React.ReactElement {
  const t = useTranslations('auth')
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    const supabase = createBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setError(t('signInError'))
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">{t('brand')}</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">{t('signInTitle')}</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {t('signInSubtitle')}
        </p>
```
```tsx
        <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4" noValidate={false}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-xs">
              {t('emailLabel')}
            </Label>
```
```tsx
          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-xs">
              {t('passwordLabel')}
            </Label>
```
```tsx
          <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
            {isSubmitting ? t('signingIn') : t('signInButton')}
          </Button>
```

- [ ] **Step 4: Translate `set-password/page.tsx`**

```tsx
// Before
export default async function SetPasswordPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">Set your password</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Signed in as {data.user.email}. Choose a password to finish setting up your account.
        </p>
```

```tsx
// After
import { getTranslations } from 'next-intl/server'

export default async function SetPasswordPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')
  const t = await getTranslations('auth')

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center">
          <span className="text-sm font-semibold tracking-tight">{t('brand')}</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">{t('setPasswordTitle')}</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          {t('setPasswordSubtitle', { email: data.user.email ?? '' })}
        </p>
```

- [ ] **Step 5: Translate `set-password-form.tsx`**

```tsx
// Before
export function SetPasswordForm(): React.ReactElement {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setIsSubmitting(true)
    const supabase = createBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError('Could not set your password. Try requesting a new invite link.')
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }
```
```tsx
        <Label htmlFor="password" className="text-xs">
          New password
        </Label>
```
```tsx
        <Label htmlFor="confirm" className="text-xs">
          Confirm password
        </Label>
```
```tsx
      <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Saving…' : 'Set password and continue'}
      </Button>
```

```tsx
// After
import { useTranslations } from 'next-intl'

export function SetPasswordForm(): React.ReactElement {
  const t = useTranslations('auth')
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('passwordTooShort', { min: MIN_PASSWORD_LENGTH }))
      return
    }
    if (password !== confirm) {
      setError(t('passwordMismatch'))
      return
    }

    setIsSubmitting(true)
    const supabase = createBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError(t('setPasswordError'))
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }
```
```tsx
        <Label htmlFor="password" className="text-xs">
          {t('newPasswordLabel')}
        </Label>
```
```tsx
        <Label htmlFor="confirm" className="text-xs">
          {t('confirmPasswordLabel')}
        </Label>
```
```tsx
      <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? t('settingPassword') : t('setPasswordButton')}
      </Button>
```

- [ ] **Step 6: Manually verify**

Run: `pnpm dev`, visit `/login` with the browser's `Accept-Language` set to `tr` (DevTools → Network conditions, or `curl -H "Accept-Language: tr" http://localhost:3000/login`) and confirm Turkish renders; with `en` confirm English.

- [ ] **Step 7: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/app/login/page.tsx src/app/set-password/page.tsx src/app/set-password/set-password-form.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate login and set-password screens"
```

---

## Task 10: Settings namespace — remaining files

**Files (apply the Task 8/9 pattern to each):**
`connect-buttons.tsx`, `connect-crm-buttons.tsx`, `connect-smtp-dialog.tsx`, `connection-card.tsx`, `error.tsx`, `followup-cadence-section.tsx`, `loading.tsx`, `mailbox-controls.tsx`, `mailbox-delete-control.tsx`, `mailbox-row.tsx`, `mailboxes-webmcp-tools.tsx`, `mailreach-controls.tsx`, `page.tsx` (remaining strings not already covered by Task 6 — `PageHeader` title/description, every `Section` title, empty-state copy, the CRM reconnect/pipeline-picker copy), `pipeline-picker.tsx`, `reply-mode-section.tsx` — all under `src/app/(app)/settings/`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (extend the `settings` namespace)

**Interfaces:**
- Consumes: `useTranslations('settings')` (client components) / `getTranslations('settings')` (Server Components) — same pattern as Tasks 8-9.

- [ ] **Step 1: Worked example — `reply-mode-section.tsx`**

```tsx
// Before
const REPLY_MODE_LABEL: Record<ReplyMode, string> = {
  auto_send: 'Automatic',
  human_approve: 'Manual',
  hybrid: 'Hybrid',
}

const REPLY_MODE_HELP: Record<ReplyMode, string> = {
  auto_send: 'The AI sends replies to leads immediately, with no review.',
  human_approve: 'Every reply is drafted for your team to review and send from the Inbox.',
  hybrid: 'The AI sends high-confidence replies automatically and drafts the rest for review.',
}
```

```tsx
// After
import { useTranslations } from 'next-intl'

// Keys, not literal English — REPLY_MODE_LABEL/HELP become functions of `t`.
function replyModeLabel(t: ReturnType<typeof useTranslations<'settings'>>, mode: ReplyMode): string {
  return t(`replyMode.${mode}.label` as 'replyMode.auto_send.label')
}
function replyModeHelp(t: ReturnType<typeof useTranslations<'settings'>>, mode: ReplyMode): string {
  return t(`replyMode.${mode}.help` as 'replyMode.auto_send.help')
}
```

Add to `src/messages/en.json`'s existing `settings` object:

```json
    "replyMode": {
      "auto_send": { "label": "Automatic", "help": "The AI sends replies to leads immediately, with no review." },
      "human_approve": { "label": "Manual", "help": "Every reply is drafted for your team to review and send from the Inbox." },
      "hybrid": { "label": "Hybrid", "help": "The AI sends high-confidence replies automatically and drafts the rest for review." }
    },
    "replyModeSrOnly": "Reply mode",
    "replyModeSaveFailed": "Could not save that change. Please try again."
```

Add the Turkish equivalent to `src/messages/tr.json`'s `settings` object:

```json
    "replyMode": {
      "auto_send": { "label": "Otomatik", "help": "Yapay zeka, potansiyel müşterilere incelemeden hemen yanıt gönderir." },
      "human_approve": { "label": "Manuel", "help": "Her yanıt, ekibinizin Gelen Kutusu'ndan inceleyip göndermesi için taslak olarak hazırlanır." },
      "hybrid": { "label": "Karma", "help": "Yapay zeka, güvenilirliği yüksek yanıtları otomatik gönderir, geri kalanını inceleme için taslak yapar." }
    },
    "replyModeSrOnly": "Yanıt modu",
    "replyModeSaveFailed": "Bu değişiklik kaydedilemedi. Lütfen tekrar deneyin."
```

Then, inside `ReplyModeSection`, add `const t = useTranslations('settings')`, replace `REPLY_MODE_LABEL[value]` with `replyModeLabel(t, value)`, `REPLY_MODE_HELP[mode]` with `replyModeHelp(t, mode)`, `'Could not save...'` with `t('replyModeSaveFailed')`, and the `sr-only` span's `Reply mode` with `t('replyModeSrOnly')`.

- [ ] **Step 2: Apply the identical extraction process to every remaining file**

For each file in the list above: read it fully, find every user-facing string literal — JSX text nodes, `aria-label`, `title`, `placeholder`, `alt`, and template-literal copy built from a mix of static text and data (use `t('key', { param })` with ICU `{param}` placeholders for those, exactly as `nav.awaitingYou` and `auth.setPasswordSubtitle` did in Tasks 8-9) — add an entry per string to the `settings` namespace in both `en.json` and `tr.json` (grouped under a sub-key named after the component when a file owns several related strings, flat when it owns one or two), then replace the literal with `t('...')`. Empty/loading/error boundary files (`error.tsx`, `loading.tsx`) follow the exact `title`/`description` pattern shown in `settings/error.tsx` (see Task 17's fully-worked `mail` namespace for the identical boilerplate, since every route's `error.tsx` is structurally the same).

- [ ] **Step 3: Run the parity test after every file (or batch of related files)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS after each addition — catches a forgotten locale immediately rather than after the whole namespace is done.

- [ ] **Step 4: Manually verify**

Run: `pnpm dev`, visit `/settings` as both a client-role and operator-role user (operators see fewer sections — no Reply mode/Follow-up cadence, per the existing `client ? (...) : null` guards), toggle language, confirm every visible string — including every mailbox row's health/warmup copy and every dialog — renders correctly in both locales with no leftover English text once Turkish is selected.

- [ ] **Step 5: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/settings src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate remaining Settings components"
```

---

## Task 11: Clients namespace

**Files (apply the Task 10 process to each):**
`clients/page.tsx`, `clients/error.tsx`, `clients/loading.tsx`, `clients/clients-webmcp-tools.tsx`, `clients/invite-user-dialog.tsx`, `clients/new-client-form.tsx`, `clients/remove-user-dialog.tsx`, and every file under `clients/[id]/` not already fully translated by Task 7: `page.tsx` (remaining header/tab/log copy), `error.tsx`, `loading.tsx`, `not-found.tsx`, `client-lifecycle-actions.tsx`, `delete-client-dialog.tsx`, `edit-domain-dialog.tsx`, `knowledge-file-upload.tsx`, `knowledge-realtime-refresher.tsx`, `knowledge-rescrape-all-button.tsx`, `knowledge-sitemap-picker.tsx`, `knowledge-source-actions.tsx`, `knowledge-sources-list.tsx`, `logo-upload.tsx`, `logs-feed.tsx`, `mailreach-toggle.tsx`, `rename-client-dialog.tsx`, `resources-section.tsx`, `warmup-mailbox-row.tsx`, `warmup-profile-select.tsx`, `warmup-tab.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (extend the `clients` namespace already started in Task 7)

**Interfaces:**
- Consumes: `useTranslations('clients')` / `getTranslations('clients')`

- [ ] **Step 1: Worked example — `rename-client-dialog.tsx`**

```tsx
// Before
        <Button type="button" variant="ghost" size="sm" aria-label="Rename client">
          <PencilSimple size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename client</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          toolname="renameClient"
          tooldescription="Changes a client's display name across the console. Cosmetic only — campaigns, cases and mail are unaffected."
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientName" className="text-xs">
              Name
            </Label>
            <Input
              id="clientName"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              toolparamdescription="The client's new name. Cannot be blank."
            />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting' || name.trim().length === 0}>
              {state.status === 'submitting' ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
```

```tsx
// After
import { useTranslations } from 'next-intl'
// ... inside the component:
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
// ...
        <Button type="button" variant="ghost" size="sm" aria-label={t('renameDialog.trigger')}>
          <PencilSimple size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('renameDialog.title')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          toolname="renameClient"
          tooldescription={t('renameDialog.toolDescription')}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientName" className="text-xs">
              {t('renameDialog.nameLabel')}
            </Label>
            <Input
              id="clientName"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              toolparamdescription={t('renameDialog.nameToolParamDescription')}
            />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting' || name.trim().length === 0}>
              {state.status === 'submitting' ? tCommon('saving') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
```

`state.message` (the failure text from the `PATCH /api/clients/[id]` fetch, `'Could not rename the client.'`) is set in the `onSubmit` handler, not JSX — replace that literal with `t('renameDialog.genericError')` the same way, and use it as the fallback in the `res.json()` error-parsing branch.

Add to `src/messages/en.json`'s existing `clients` object:

```json
    "renameDialog": {
      "trigger": "Rename client",
      "title": "Rename client",
      "toolDescription": "Changes a client's display name across the console. Cosmetic only — campaigns, cases and mail are unaffected.",
      "nameLabel": "Name",
      "nameToolParamDescription": "The client's new name. Cannot be blank.",
      "genericError": "Could not rename the client."
    }
```

Add to `src/messages/tr.json`'s `clients` object:

```json
    "renameDialog": {
      "trigger": "Müşteriyi yeniden adlandır",
      "title": "Müşteriyi yeniden adlandır",
      "toolDescription": "Müşterinin konsoldaki görünen adını değiştirir. Sadece görsel bir değişikliktir — kampanyalar, vakalar ve e-postalar etkilenmez.",
      "nameLabel": "Ad",
      "nameToolParamDescription": "Müşterinin yeni adı. Boş bırakılamaz.",
      "genericError": "Müşteri yeniden adlandırılamadı."
    }
```

- [ ] **Step 2: Apply the identical process to every remaining file listed above**

Same procedure as Task 10 Step 2 — including WebMCP `toolname`/`tooldescription`/`toolparamdescription` attributes wherever they appear (see the worked example), which are easy to miss since they aren't rendered visually but are still user/agent-facing text that must not silently stay English.

- [ ] **Step 3: Run the parity test after every file (or batch)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 4: Manually verify**

Run: `pnpm dev`, sign in as an operator, visit `/clients` and a client detail page across every tab (`campaigns`, `warmup`, `knowledge`), toggle language, confirm no leftover English string.

- [ ] **Step 5: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/clients src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Clients pages"
```

---

## Task 12: Campaigns namespace

**Files:** `campaigns/page.tsx`, `campaigns/error.tsx`, `campaigns/loading.tsx`, `campaigns/campaign-row-actions.tsx`, `campaigns/campaigns-webmcp-tools.tsx`, `campaigns/delete-campaign-dialog.tsx`, `campaigns/new-campaign-form.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `campaigns` namespace)

**Interfaces:**
- Consumes: `useTranslations('campaigns')` / `getTranslations('campaigns')`

- [ ] **Step 1: Read every file in the list, apply the Task 10/11 extraction process to each — literal JSX text, `aria-label`/`title`/`placeholder`, WebMCP tool attributes, and any pluralized count (`{n} campaigns`) using ICU `{count, plural, one {...} other {...}}` exactly like `mail.messageCount` in Task 17.**

- [ ] **Step 2: Run the parity test after every file (or batch)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 3: Manually verify**

Run: `pnpm dev`, sign in as an operator, visit `/campaigns`, create-campaign form and delete-campaign dialog, toggle language, confirm full coverage.

- [ ] **Step 4: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/campaigns src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Campaigns pages"
```

---

## Task 13: Cases namespace

**Files:** `cases/[id]/page.tsx`, `cases/[id]/error.tsx`, `cases/[id]/loading.tsx`, `cases/[id]/not-found.tsx`, `cases/[id]/compose-form.tsx`, `cases/[id]/crm-link-badge.tsx`, `cases/[id]/lead-followup-control.tsx`, `cases/[id]/mail-tab.tsx`, `cases/[id]/notes-panel.tsx`, `cases/[id]/stop-lead-button.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `cases` namespace)

**Interfaces:**
- Consumes: `useTranslations('cases')` / `getTranslations('cases')`

- [ ] **Step 1: Worked example — `stop-lead-button.tsx`**

```tsx
// Before
      try {
        await stopLead(data)
        setIsOpen(false)
      } catch {
        setError('Could not stop this contact. Try again.')
      }
```
```tsx
        <Button type="button" variant="ghost" size="sm" aria-label={`Stop outreach to ${fullName}`}>
```
```tsx
          <DialogTitle>Stop outreach to {fullName}?</DialogTitle>
          <DialogDescription>
            Their address is added to your suppression list, any running follow-up sequence stops, and the
            contact is parked. Nothing is deleted, but no further email is ever sent to them.
          </DialogDescription>
```
```tsx
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={isPending}>
            {isPending ? 'Stopping…' : 'Yes, stop outreach'}
          </Button>
```

```tsx
// After
import { useTranslations } from 'next-intl'
// inside the component:
  const t = useTranslations('cases')
  const tCommon = useTranslations('common')
// ...
      try {
        await stopLead(data)
        setIsOpen(false)
      } catch {
        setError(t('stopLead.error'))
      }
```
```tsx
        <Button type="button" variant="ghost" size="sm" aria-label={t('stopLead.trigger', { fullName })}>
```
```tsx
          <DialogTitle>{t('stopLead.title', { fullName })}</DialogTitle>
          <DialogDescription>{t('stopLead.description')}</DialogDescription>
```
```tsx
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)} disabled={isPending}>
            {tCommon('cancel')}
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={isPending}>
            {isPending ? t('stopLead.stopping') : t('stopLead.confirm')}
          </Button>
```

Add to `src/messages/en.json`'s `cases` object:

```json
    "stopLead": {
      "trigger": "Stop outreach to {fullName}",
      "title": "Stop outreach to {fullName}?",
      "description": "Their address is added to your suppression list, any running follow-up sequence stops, and the contact is parked. Nothing is deleted, but no further email is ever sent to them.",
      "stopping": "Stopping…",
      "confirm": "Yes, stop outreach",
      "error": "Could not stop this contact. Try again."
    }
```

Add to `src/messages/tr.json`'s `cases` object:

```json
    "stopLead": {
      "trigger": "{fullName} kişisine ulaşımı durdur",
      "title": "{fullName} kişisine ulaşım durdurulsun mu?",
      "description": "Adresleri engelleme listenize eklenir, devam eden takip dizisi durur ve kişi beklemeye alınır. Hiçbir şey silinmez, ancak kendilerine bir daha e-posta gönderilmez.",
      "stopping": "Durduruluyor…",
      "confirm": "Evet, ulaşımı durdur",
      "error": "Bu kişi durdurulamadı. Tekrar deneyin."
    }
```

- [ ] **Step 2: Apply the identical process to every remaining file listed above**

`notes-panel.tsx` and `compose-form.tsx` are the largest (likely have multiple form fields and validation messages) — budget extra time; every validation/error string counts, not just the happy path.

- [ ] **Step 3: Run the parity test after every file (or batch)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 4: Manually verify**

Run: `pnpm dev`, open a case detail page, exercise compose, notes, and stop-lead flows in both languages.

- [ ] **Step 5: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/cases src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Cases pages"
```

---

## Task 14: CRM namespace

**Files:** `crm/page.tsx`, `crm/error.tsx`, `crm/loading.tsx`, plus the shared `CaseRow`/`FilterChips` components it renders (`src/components/case-row.tsx`, `src/components/filter-chips.tsx`) if they own their own literal strings rather than receiving them as props — check both before deciding whether they belong in this task or are already fully prop-driven.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `crm` namespace)

**Interfaces:**
- Consumes: `useTranslations('crm')` / `getTranslations('crm')`

- [x] **Step 1: Worked example — `crm/page.tsx`**

```tsx
// Before
export const metadata: Metadata = { title: 'Pipeline' }
```
```tsx
const STATUS_FILTERS = [ /* ... */ ] as const satisfies readonly CaseStatus[]
```
```tsx
      <PageHeader
        title="Pipeline"
        description="Every company the agent is working, newest first. Open a case to read its mail, research and audit trail."
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {status
              ? `${ordered.length.toLocaleString('en-US')} ${ordered.length === 1 ? 'case' : 'cases'}`
              : `${live.length.toLocaleString('en-US')} live${
                  closed.length > 0 ? ` · ${closed.length.toLocaleString('en-US')} closed` : ''
                }`}
          </span>
        }
      />
```
```tsx
        <EmptyState
          icon={Kanban}
          title="No cases yet"
          description="Cases appear here once discovery finds a company with at least one verified contact. Start by creating a campaign."
        />
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={Kanban}
          title={`Nothing in ${status ? CASE_STATUS[status].label.toLowerCase() : 'this view'}`}
          description="No cases have reached this stage yet. Pick another stage above, or choose All to see everything."
        />
```

```tsx
// After
import { getTranslations } from 'next-intl/server'
// ... inside CrmPage, after `const now = new Date()`:
  const t = await getTranslations('crm')
```
```tsx
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {status
              ? t('caseCount', { count: ordered.length })
              : t('liveClosedCount', { live: live.length, closed: closed.length, hasClosed: closed.length > 0 ? 1 : 0 })}
          </span>
        }
      />
```
```tsx
        <EmptyState
          icon={Kanban}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={Kanban}
          title={status ? t('emptyStageTitle', { stage: CASE_STATUS[status].label.toLowerCase() }) : t('emptyStageTitleGeneric')}
          description={t('emptyStageDescription')}
        />
```

Note `status.label.toLowerCase()`: `CASE_STATUS[status].label` is itself a hardcoded English string sourced from `@/lib/ui/status`, outside this task's file list — flag it rather than silently leaving it English; either fold `src/lib/ui/status.ts` into this task's scope (translate its `label` values the same way, threading a `t` function through) or, if it is shared by multiple already-translated namespaces (check its other call sites first), give it its own small follow-up task before calling Task 14 done.

The `PageHeader`'s `actions` count string needs an ICU plural + a nested conditional; keep it simple with two full sentences rather than fighting ICU's `select` nesting:

Add to `src/messages/en.json`'s `crm` object:

```json
  "crm": {
    "title": "Pipeline",
    "description": "Every company the agent is working, newest first. Open a case to read its mail, research and audit trail.",
    "caseCount": "{count, plural, one {# case} other {# cases}}",
    "liveClosedCount": "{live, plural, one {# live} other {# live}}{hasClosed, select, 1 { · {closed, plural, one {# closed} other {# closed}}} other {}}",
    "emptyTitle": "No cases yet",
    "emptyDescription": "Cases appear here once discovery finds a company with at least one verified contact. Start by creating a campaign.",
    "emptyStageTitle": "Nothing in {stage}",
    "emptyStageTitleGeneric": "Nothing in this view",
    "emptyStageDescription": "No cases have reached this stage yet. Pick another stage above, or choose All to see everything."
  }
```

Add the Turkish equivalent to `src/messages/tr.json`'s `crm` object — translate each value naturally (e.g. `"title": "Fırsatlar"`, `"caseCount": "{count, plural, other {# vaka}}"` — Turkish has no grammatical plural distinction here, so `one` and `other` render identically; ICU still requires both forms present per locale's plural rules, which for Turkish is just `other`).

- [x] **Step 2: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 3: Manually verify**
  <!-- skipped: no pnpm dev / browser check run this session -->

Run: `pnpm dev`, visit `/crm` with 0, 1, and several cases in both languages, confirm every count string and empty state renders correctly.

- [x] **Step 4: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**
  <!-- skipped: commits not made per explicit instruction -->

```bash
git add src/app/\(app\)/crm src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate CRM pipeline page"
```

---

## Task 15: Inbox namespace

**Files:** `inbox/page.tsx`, `inbox/error.tsx`, `inbox/loading.tsx`, `inbox/draft-row.tsx`, `inbox/knowledge-request-row.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `inbox` namespace)

**Interfaces:**
- Consumes: `useTranslations('inbox')` / `getTranslations('inbox')`

- [x] **Step 1: Read all five files, apply the same extraction process as Tasks 10-14** — `error.tsx`/`loading.tsx` follow the standard boilerplate (see Task 17's fully-worked example), `page.tsx` almost certainly has an `EmptyState` and a `PageHeader` (mirror the `crm`/`mail` treatment), `draft-row.tsx` and `knowledge-request-row.tsx` render per-item action buttons/status labels that need the same literal-by-literal treatment as `stop-lead-button.tsx` in Task 13.

- [x] **Step 2: Run the parity test after every file (or batch)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 3: Manually verify**
  <!-- skipped: no pnpm dev / browser check run this session -->

Run: `pnpm dev`, visit `/inbox` with at least one draft and one open knowledge request, toggle language.

- [x] **Step 4: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Commit**
  <!-- skipped: commits not made per explicit instruction -->

```bash
git add src/app/\(app\)/inbox src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Inbox page"
```

---

## Task 16: Knowledge namespace

**Files:** `knowledge/page.tsx`, `knowledge/error.tsx`, `knowledge/loading.tsx`, `knowledge/knowledge-tabs.tsx`, `knowledge/resources/page.tsx`, `knowledge/resources/error.tsx`, `knowledge/resources/loading.tsx`, `knowledge/sources/page.tsx`, `knowledge/sources/error.tsx`, `knowledge/sources/loading.tsx`, `knowledge/sources/sources-list.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `knowledge` namespace)

**Interfaces:**
- Consumes: `useTranslations('knowledge')` / `getTranslations('knowledge')`

- [x] **Step 1: Worked example — `knowledge/error.tsx`**

```tsx
// Before
export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Knowledge unavailable"
      description="The knowledge library could not be loaded."
      reset={reset}
    />
  )
}
```

```tsx
// After
import { useTranslations } from 'next-intl'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('knowledge')
  return (
    <ErrorPanel
      title={t('errorTitle')}
      description={t('errorDescription')}
      reset={reset}
    />
  )
}
```

Add to `src/messages/en.json`'s `knowledge` object: `"errorTitle": "Knowledge unavailable", "errorDescription": "The knowledge library could not be loaded."`. Add the Turkish equivalent to `tr.json`: `"errorTitle": "Bilgi bankasına ulaşılamıyor", "errorDescription": "Bilgi bankası yüklenemedi."`.

`loading.tsx` (here and everywhere else) renders `<PageSkeleton variant="..." />` with no literal strings — verify this by reading the file, and if confirmed, skip it explicitly (note "no strings — skipped" rather than leaving it unmentioned) rather than translating something that isn't there.

`resources/error.tsx` and `sources/error.tsx` follow the identical pattern with their own `title`/`description` pair — repeat Step 1's transformation for each, using `resourcesErrorTitle`/`sourcesErrorTitle` keys (or nest them, e.g. `"resources": { "errorTitle": ... }`, `"sources": { "errorTitle": ... }`) to avoid flat-key collisions between the three sibling routes' error boundaries.

- [x] **Step 2: Apply the same process to `page.tsx`, `resources/page.tsx`, `sources/page.tsx`, `knowledge-tabs.tsx`, `sources-list.tsx`**

`knowledge-tabs.tsx` almost certainly renders the tab labels ("Resources", "Sources", or similar) — these are prime candidates for the `knowledge` namespace's top-level keys since they're shared navigation within this section, same treatment as `nav.tsx` in Task 8.

- [x] **Step 3: Run the parity test after every file (or batch)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 4: Manually verify**
  <!-- skipped: no pnpm dev / browser check run this session -->

Run: `pnpm dev`, visit `/knowledge`, `/knowledge/resources`, `/knowledge/sources`, toggle language, confirm tab labels and both sub-pages.

- [x] **Step 5: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 6: Commit**
  <!-- skipped: commits not made per explicit instruction -->

```bash
git add src/app/\(app\)/knowledge src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Knowledge pages"
```

---

## Task 17: Mail namespace

**Files:** `mail/page.tsx`, `mail/error.tsx`, `mail/loading.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `mail` namespace)

This is the smallest namespace and is fully specified below — no partial pattern-and-list treatment needed.

**Interfaces:**
- Consumes: `useTranslations('mail')` / `getTranslations('mail')`

- [x] **Step 1: Add the `mail` message keys**

Add to `src/messages/en.json`:

```json
  "mail": {
    "title": "Mail",
    "latestCount": "Latest {count}",
    "messageCount": "{count, plural, one {# message} other {# messages}}",
    "directionLabel": "Direction",
    "directionAll": "All",
    "directionOutbound": "Outbound",
    "directionReplies": "Replies",
    "statusLabel": "Status",
    "statusAny": "Any",
    "statusDraft": "Draft",
    "statusSent": "Sent",
    "statusDelivered": "Delivered",
    "statusBounced": "Bounced",
    "statusFailed": "Failed",
    "emptyTitle": "No mail matches this view",
    "emptyDescription": "Clear the filters above, or wait for the writer agent to draft its next batch.",
    "unknownCompany": "Unknown company",
    "notLinkedToCase": "Not linked to a case",
    "errorTitle": "Mail unavailable",
    "errorDescription": "The message history could not be loaded."
  }
```

Add to `src/messages/tr.json`:

```json
  "mail": {
    "title": "E-posta",
    "latestCount": "Son {count}",
    "messageCount": "{count, plural, other {# mesaj}}",
    "directionLabel": "Yön",
    "directionAll": "Tümü",
    "directionOutbound": "Giden",
    "directionReplies": "Yanıtlar",
    "statusLabel": "Durum",
    "statusAny": "Herhangi biri",
    "statusDraft": "Taslak",
    "statusSent": "Gönderildi",
    "statusDelivered": "Ulaştı",
    "statusBounced": "Geri döndü",
    "statusFailed": "Başarısız",
    "emptyTitle": "Bu görünümle eşleşen e-posta yok",
    "emptyDescription": "Yukarıdaki filtreleri temizleyin veya yazar ajanının bir sonraki taslak grubunu hazırlamasını bekleyin.",
    "unknownCompany": "Bilinmeyen şirket",
    "notLinkedToCase": "Bir vakaya bağlı değil",
    "errorTitle": "E-posta yüklenemiyor",
    "errorDescription": "Mesaj geçmişi yüklenemedi."
  }
```

- [x] **Step 2: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [x] **Step 3: Translate `mail/page.tsx`**

```tsx
// Before
export const metadata: Metadata = { title: 'Mail' }
```
```tsx
const DIRECTION_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'All' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'inbound', label: 'Replies' },
]

const STATUS_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'Any' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'failed', label: 'Failed' },
]
```
```tsx
  const [emails, cases] = await Promise.all([ /* ... */ ])
```
```tsx
      <PageHeader
        title="Mail"
        description="Every message the agent has sent and every reply it has received, newest first."
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {emails.length === PAGE_SIZE
              ? `Latest ${PAGE_SIZE}`
              : `${emails.length} ${emails.length === 1 ? 'message' : 'messages'}`}
          </span>
        }
      />

      <div className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label="Direction"
          param="direction"
          pathname="/mail"
          options={DIRECTION_OPTIONS}
          active={direction}
          carry={carry}
        />
        <FilterChips
          label="Status"
          param="status"
          pathname="/mail"
          options={STATUS_OPTIONS}
          active={status}
          carry={carry}
        />
      </div>

      {emails.length === 0 ? (
        <EmptyState
          icon={Envelope}
          title="No mail matches this view"
          description="Clear the filters above, or wait for the writer agent to draft its next batch."
        />
```
```tsx
                {email.case_id ? (
                  <Link href={`/cases/${email.case_id}`} /* ... */>
                    {company ?? 'Unknown company'}
                  </Link>
                ) : (
                  <span className="text-faint text-[11px]">Not linked to a case</span>
                )}
```

```tsx
// After
import { getTranslations } from 'next-intl/server'
```

The `metadata` export title stays a static string (`'Mail'`) — Next.js `<head>` metadata predates the request-scoped translation context and is out of scope per Task 9's precedent (login/layout.tsx). Leave it as-is.

Inside `MailPage`, after computing `direction`/`status`, add:

```tsx
  const t = await getTranslations('mail')
  const DIRECTION_OPTIONS: readonly FilterOption[] = [
    { value: null, label: t('directionAll') },
    { value: 'outbound', label: t('directionOutbound') },
    { value: 'inbound', label: t('directionReplies') },
  ]
  const STATUS_OPTIONS: readonly FilterOption[] = [
    { value: null, label: t('statusAny') },
    { value: 'draft', label: t('statusDraft') },
    { value: 'sent', label: t('statusSent') },
    { value: 'delivered', label: t('statusDelivered') },
    { value: 'bounced', label: t('statusBounced') },
    { value: 'failed', label: t('statusFailed') },
  ]
```

(Move these two `const`s from module scope into the function body, since they now depend on `t`.)

```tsx
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {emails.length === PAGE_SIZE ? t('latestCount', { count: PAGE_SIZE }) : t('messageCount', { count: emails.length })}
          </span>
        }
      />

      <div className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label={t('directionLabel')}
          param="direction"
          pathname="/mail"
          options={DIRECTION_OPTIONS}
          active={direction}
          carry={carry}
        />
        <FilterChips
          label={t('statusLabel')}
          param="status"
          pathname="/mail"
          options={STATUS_OPTIONS}
          active={status}
          carry={carry}
        />
      </div>

      {emails.length === 0 ? (
        <EmptyState
          icon={Envelope}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
```
```tsx
                {email.case_id ? (
                  <Link href={`/cases/${email.case_id}`} /* ... */>
                    {company ?? t('unknownCompany')}
                  </Link>
                ) : (
                  <span className="text-faint text-[11px]">{t('notLinkedToCase')}</span>
                )}
```

Also add `"description": "Every message the agent has sent and every reply it has received, newest first."` (English) / `"description": "Ajanın gönderdiği ve aldığı her yanıt, en yeniden en eskiye."` (Turkish) to each locale's `mail` object — it was missing from Step 1's list.

- [x] **Step 4: Translate `mail/error.tsx`**

```tsx
// Before
export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Mail unavailable"
      description="The message history could not be loaded."
      reset={reset}
    />
  )
}
```

```tsx
// After
import { useTranslations } from 'next-intl'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('mail')
  return (
    <ErrorPanel
      title={t('errorTitle')}
      description={t('errorDescription')}
      reset={reset}
    />
  )
}
```

- [x] **Step 5: `mail/loading.tsx`**

No literal strings (`<PageSkeleton variant="list" />` only) — no change needed.

- [x] **Step 6: Run the parity test**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 7: Manually verify**
  <!-- skipped: no pnpm dev / browser check run this session -->

Run: `pnpm dev`, visit `/mail` with filters applied and cleared, in both languages.

- [x] **Step 8: Run the full suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: PASS

- [ ] **Step 9: Commit**
  <!-- skipped: commits not made per explicit instruction -->

```bash
git add src/app/\(app\)/mail src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Mail page"
```

---

## Task 18: Analytics namespace

**Files:** `analytics/page.tsx`, `analytics/error.tsx`, `analytics/loading.tsx`, `analytics/analytics-view.tsx`, `analytics/filters.tsx`, `analytics/realtime-refresher.tsx`, `analytics/sparkline-chart.tsx`, `analytics/stat-tile.tsx`.
- Modify: `src/messages/en.json`, `src/messages/tr.json` (new `analytics` namespace)

**Interfaces:**
- Consumes: `useTranslations('analytics')` / `getTranslations('analytics')`

- [x] **Step 1: Read all eight files.** `stat-tile.tsx` (already read — see Task-writing notes) takes `label`/`value`/`hint` as **props**, not literal strings — it owns no translatable text itself; its callers in `analytics-view.tsx`/`page.tsx` own the labels passed in, so extract there. `sparkline-chart.tsx` likely renders pure SVG from numeric data with no user-facing text — verify by reading it and skip explicitly if confirmed empty of strings, same as `loading.tsx` files in Task 16.

- [x] **Step 2: Apply the same extraction process as Tasks 10-17 to every file that does own literal strings** — page title/description, filter labels/options (mirror `mail`'s `directionLabel`/`statusLabel` treatment from Task 17), every stat tile's `label`/`hint` text, and the realtime-refresher's any visible status text (if it renders one — check before assuming).

- [x] **Step 3: Run the parity test after every file (or batch)**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: PASS

- [ ] **Step 4: Manually verify**
  <!-- skipped: no pnpm dev / browser check run this session -->

Run: `pnpm dev`, visit `/analytics` with filters applied, toggle language, confirm every stat tile label/hint and filter control.

- [x] **Step 5: Run the full suite, including a final end-to-end check across the whole app**

Run: `pnpm typecheck && pnpm vitest run && pnpm build`
Expected: PASS. Then manually walk every route in the spec's scope (`/crm`, `/inbox`, `/mail`, `/knowledge` + subpages, `/analytics`, `/clients` + detail, `/campaigns`, `/settings`, `/cases/[id]`, `/login`, `/set-password`) once in English and once in Turkish as a final regression pass before closing out the feature.

- [ ] **Step 6: Commit**
  <!-- skipped: commits not made per explicit instruction -->

```bash
git add src/app/\(app\)/analytics src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): translate Analytics page"
```

---

## Post-implementation

- Update `.claude/roadmap.md` to mark dashboard i18n done, per this project's CLAUDE.md instruction to update the roadmap on every piece of progress.
- No branch/PR step: this repo's convention (CLAUDE.md: "dont branch use main") is to commit directly to `main` as each task lands, which the per-task commit steps above already do.
