# Dashboard i18n (English / Turkish) — Design

**Status:** Approved design
**Date:** 2026-08-05
**Scope:** Translate the authenticated dashboard (`(app)` routes + shell) and the pre-login `login`/`set-password` screens into English and Turkish. Per-user language preference, with an operator-set per-client default. Business data and AI-generated content are unaffected.

---

## 1. Problem

The dashboard is English-only. Client organizations have users who prefer Turkish; today there's no way to serve them anything but English, and no per-user control — it's all-or-nothing for the whole app.

## 2. Scope

- **In scope**: every static UI string (nav, buttons, labels, headers, empty/error states, toasts, form copy) across the `(app)` route group (`analytics`, `campaigns`, `cases`, `clients`, `crm`, `inbox`, `knowledge`, `mail`, `settings`), the app shell/nav (`src/components/shell/`), and `/login` + `/set-password`.
- **Out of scope**: business data (case names, CRM records, client-entered content), AI-drafted email bodies, the `(marketing)` site.
- **Languages**: English (`en`, default) and Turkish (`tr`) at launch. Locale list is designed to grow later without architecture changes.
- **Audience**: both operators and client users, per-user. One employee can use English while a colleague at the same client uses Turkish. Operators additionally control a client's *default* language, which new/unset client users inherit.
- **Routing**: no URL-visible locale (no `/en/...` / `/tr/...` prefixes) — this is a login-gated dashboard, not an SEO'd public site, and a prefix would mean restructuring the entire route tree for no benefit. Language is resolved server-side from the signed-in user's stored preference.
- This is a large, one-pass translation of ~95 existing component/page files (see §7) — the implementation plan will break it into per-feature-area steps, but there is no partial/English-only route left when this ships.

## 3. Data model

Migration `supabase/migrations/0029_locale_preferences.sql`:

```sql
create type app_locale as enum ('en', 'tr');

alter table clients   add column default_locale app_locale not null default 'en';
alter table app_users add column locale         app_locale;  -- null = inherit
```

- `clients.default_locale` — the operator-set default for that client's users. Defaults to `'en'` so every existing client keeps behaving exactly as today until an operator changes it.
- `app_users.locale` — nullable per-user override. `null` means "inherit": for a `client`-role user, inherit `clients.default_locale`; for an `operator`-role user (no `client_id`), inherit `'en'`.
- Adding a third language later is `ALTER TYPE app_locale ADD VALUE '...'` plus a `messages/<locale>.json` file — no schema restructuring.

Regenerate `src/types/database.ts` after the migration so `ClientRow['default_locale']` and `AppUserRow['locale']` are typed as `'en' | 'tr'` / `'en' | 'tr' | null`.

New shared type, `src/types/i18n.ts`:

```ts
export const SUPPORTED_LOCALES = ['en', 'tr'] as const
export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
```

## 4. Locale resolution

New `src/lib/i18n/resolve-locale.ts`:

```ts
export const resolveLocale = cache(async (): Promise<AppLocale> => {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) return resolvePreloginLocale()

  const appUser = await getAppUser(supabase, data.user.id)
  if (!appUser) return 'en'
  if (appUser.locale) return appUser.locale
  if (appUser.role === 'client' && appUser.client_id) {
    const client = await getClientById(supabase, appUser.client_id)
    return client?.default_locale ?? 'en'
  }
  return 'en'
})
```

- Wrapped in React's `cache()` so it computes once per request even though both `src/i18n/request.ts` (message loading) and any Server Component that needs the current locale call it — Next.js dedupes calls to the same `cache()`-wrapped function within one request's render tree, so this adds no duplicate DB round trips beyond what `requireUser()`/`getClientById()` already do in `AuthedLayout`.
- `resolvePreloginLocale()` (same file): parses the `Accept-Language` header (via `next/headers`), matches against `SUPPORTED_LOCALES`, falls back to `'en'`. No cookie involved — nothing to persist pre-login, and there's no manual switcher on `/login` per scope (§2).
- No cookie-sync mechanism anywhere: because resolution is entirely server-side from the DB (or header, pre-login) on every request, a language change just needs `revalidatePath` — the very next render re-resolves and picks it up. This avoids the whole class of stale-cookie-vs-DB-value bugs.
- An invalid/unsupported stored value (shouldn't happen, enum-constrained) is defensively treated as `'en'`.

## 5. next-intl wiring

- Add `next-intl` as a dependency.
- `src/i18n/request.ts`:
  ```ts
  export default getRequestConfig(async () => {
    const locale = await resolveLocale()
    const messages = (await import(`../../messages/${locale}.json`)).default
    return { locale, messages }
  })
  ```
- `next.config.ts`: wrap the existing config with `createNextIntlPlugin()`.
- `src/app/layout.tsx` (root layout): read `getLocale()` for `<html lang={locale}>`, wrap `children` in `<NextIntlClientProvider>`. This is the one place both the authed `(app)` tree and `/login`/`/set-password` share, so no per-tree duplication.
- Server Components use `getTranslations({ namespace })`; Client Components use `useTranslations(namespace)`.

## 6. Server Actions & UI

### `updateMyLocale` — `src/app/(app)/settings/locale-actions.ts`

```ts
export async function updateMyLocale(locale: AppLocale): Promise<Result<void>>
```

- Validates session via `requireUser()`, Zod-validates `locale` against `SUPPORTED_LOCALES`, updates the caller's own `app_users.locale`, `revalidatePath('/', 'layout')`.
- No role gate — every signed-in user (operator or client) may set their own language.
- Logs `{ action: 'updateMyLocale', userId, locale }` on entry; maps any Supabase error to `AppError('DB_ERROR', ...)`.

### `updateClientDefaultLocale` — `src/app/(app)/clients/[id]/locale-actions.ts`

```ts
export async function updateClientDefaultLocale(clientId: string, locale: AppLocale): Promise<Result<void>>
```

- `requireUser()` + `appUser.role === 'operator'` check → `AppError('FORBIDDEN', ...)` otherwise, same shape as other operator-only client actions in this directory.
- Zod-validates `locale`, updates `clients.default_locale`, `revalidatePath('/', 'layout')`.

### UI — `/settings`

New `language-section.tsx`, placed next to `reply-mode-section.tsx`, following its exact shape: a `<select>` of "English" / "Türkçe", `useTransition` for pending state, save-on-change, toast on result. Visible to every role.

### UI — `/clients/[id]` (operator only)

A small inline "Default language" select next to the client's other settings on `page.tsx` (same treatment as `rename-client-dialog.tsx`'s trigger, but inline rather than a dialog — a single select doesn't need confirmation). Copy: *"New users at this client start in this language until they set their own."*

## 7. Translation content

`messages/en.json` / `messages/tr.json`, namespaced to mirror the route/feature structure:

`common`, `nav`, `auth` (login + set-password), `settings`, `clients`, `campaigns`, `cases`, `crm`, `inbox`, `knowledge`, `mail`, `analytics`.

Every static string in the ~95 `.tsx` files under `src/app/(app)/*/`, `src/components/shell/`, `src/app/login/`, `src/app/set-password/` gets extracted to the matching namespace and replaced with `t(...)`. Turkish translations are written for real (not machine-placeholder) as each namespace is extracted — no namespace ships with English fallback text sitting in the `tr.json` file.

Given the size, the implementation plan processes this one feature-area (namespace) at a time — shell/nav first (since every page depends on it), then `settings` (needed for the language switcher itself to be translated), then the remaining areas in any order, then `auth`.

## 8. Testing

- `src/lib/validation/locale.test.ts` — Zod schema: valid locales, invalid string, wrong type, missing.
- `locale-actions.test.ts` (both actions) — auth rejection, validation rejection, success path, DB failure — matching `followup-cadence-actions.test.ts`'s structure.
- `messages/messages.test.ts` — deep-compares the key structure of `en.json` and `tr.json` and fails if they diverge, so a namespace added to one and forgotten in the other breaks CI instead of silently falling back at runtime.
- `resolve-locale.test.ts` — no session → header-based fallback; session + no override → client default; session + override → override wins; operator → `'en'` when unset.

## 9. Edge cases

- **User at a client whose default just changed by the operator, but the user already has their own override**: unaffected — override always wins, per §3.
- **Client's `default_locale` changed after users already inherited it**: no bulk-sync needed or attempted — inheritance is resolved live on every request (§4), so it just takes effect immediately for every user still on `null`.
- **Unsupported `Accept-Language` on `/login`** (e.g. `fr`): falls back to `'en'` — no partial/guessed match.
- **Operator with `client_id = null` editing their own language**: `updateMyLocale` doesn't care about `client_id`; unaffected by §3's operator-default-is-`'en'` rule, which only applies when `locale` is unset.

---

## Files touched

- `supabase/migrations/0029_locale_preferences.sql` (new)
- `src/types/database.ts` (regenerated)
- `src/types/i18n.ts` (new)
- `src/lib/validation/locale.ts` (new)
- `src/lib/i18n/resolve-locale.ts` (new)
- `src/i18n/request.ts` (new)
- `next.config.ts` (wrap with `createNextIntlPlugin`)
- `src/app/layout.tsx` (`NextIntlClientProvider`, `<html lang>`)
- `src/app/(app)/settings/language-section.tsx`, `locale-actions.ts` (new)
- `src/app/(app)/settings/page.tsx` (wire in the new section)
- `src/app/(app)/clients/[id]/locale-actions.ts` (new)
- `src/app/(app)/clients/[id]/page.tsx` (wire in the default-language control)
- `messages/en.json`, `messages/tr.json` (new)
- Every `.tsx` under `src/app/(app)/*/`, `src/components/shell/`, `src/app/login/`, `src/app/set-password/` (string extraction to `t(...)`)
- Corresponding `.test.ts` files for every new function above
