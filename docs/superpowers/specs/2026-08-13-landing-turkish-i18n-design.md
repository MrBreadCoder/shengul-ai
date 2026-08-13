# Landing page Turkish translation + language switcher — Design

**Status:** Approved design
**Date:** 2026-08-13
**Scope:** Translate the public marketing home page (`/`) into Turkish, auto-detected for visitors from Turkey, with a manual switcher in the footer. Legal documents and the authenticated dashboard are unaffected.

---

## 1. Problem

The marketing site (`(marketing)` route group) is English-only and entirely hardcoded — no landing component calls into the i18n system the dashboard already uses ([`2026-08-05-dashboard-i18n-design.md`](2026-08-05-dashboard-i18n-design.md)). Visitors browsing from Turkey, or who prefer Turkish, get no localized experience and have no way to ask for one.

## 2. Scope

- **In scope**: the marketing home page (`src/app/(marketing)/page.tsx`) — hero through footer, nav, and every landing component under `src/components/landing/`. A new `/tr` route serves the Turkish version.
- **Out of scope**: the 7 legal documents under `/legal/*` (16k words of GDPR/CCPA-grade text — mistranslating a clause like "processor" vs "controller" carries real legal risk and needs a qualified Turkish-speaking legal reviewer, not a coding-agent translation pass). They stay English-only, linked exactly as today, from both the English and Turkish landing pages. The authenticated `(app)` dashboard, `/login`, `/set-password` — unaffected, already covered by the existing per-user locale system.
- **Languages**: English (default, unprefixed) and Turkish (`/tr`), reusing the existing `SUPPORTED_LOCALES`/`AppLocale` type from `src/types/i18n.ts` — no new locale enum.
- **Detection**: Vercel edge geo-IP country header first (`x-vercel-ip-country === 'TR'`), falling back to the visitor's `Accept-Language` header, falling back to English. A manual footer switcher always overrides both via a persisted cookie.
- This does **not** reuse the dashboard's `resolveLocale()` (DB/session-based — meaningless for anonymous marketing visitors) or next-intl's built-in routing plugin (`defineRouting`, `[locale]` segments — built for N-page multi-locale apps; overkill for one page mirrored once). It reuses next-intl's message-catalog and `useTranslations`/`getTranslations` machinery, which is locale-source-agnostic.

## 3. Routing & detection

No schema/migration needed — this is anonymous, unauthenticated traffic; nothing is persisted server-side.

**New route:** `src/app/(marketing)/tr/page.tsx`, sibling to the existing `page.tsx`. Same "redirect signed-in users to `/crm`" guard, Turkish `metadata`, renders the shared landing composition with `locale="tr"`.

**`middleware.ts`** — one new check runs *before* the existing `updateSession(request)` call:

```ts
const MARKETING_LOCALE_COOKIE = 'marketing_locale'

function resolveMarketingLocale(request: NextRequest): AppLocale {
  const cookie = request.cookies.get(MARKETING_LOCALE_COOKIE)?.value
  if (cookie && isSupportedLocale(cookie)) return cookie
  if (request.headers.get('x-vercel-ip-country') === 'TR') return 'tr'
  return parseAcceptLanguage(request.headers.get('accept-language'))
}
```

`isSupportedLocale` and `parseAcceptLanguage` already exist as unexported helpers inside `src/lib/i18n/resolve-locale.ts` (§4 of the dashboard i18n design). This change exports both from that file instead of duplicating them, so the dashboard's pre-login detection and the marketing site's detection read `Accept-Language` identically by construction, not by two implementations happening to agree.

- Only `pathname === '/'` is checked. If it resolves to `'tr'`, `NextResponse.redirect` to `/tr`. Otherwise fall through to `updateSession` unchanged — English renders at `/` exactly as today, no redirect, no new response shape.
- `/tr` is **never** redirected away from, regardless of geo/cookie/language — a direct link, a bookmark, or Googlebot crawling from Turkey always gets the Turkish page. This also means there is no redirect loop: the only redirect direction is `/` → `/tr`.
- The cookie is only ever *set* by the manual switcher (§5), never by auto-detection — so geo detection is recomputed fresh on every `/` request rather than "sticking" after one visit. This keeps the mechanism simple and avoids stale-detection edge cases (e.g., a VPN or travel changing the visitor's apparent country mid-session); the one time staleness matters — a manual override — is exactly the case the cookie exists to serve.
- `src/lib/auth/public-paths.ts`: add `/tr` to `EXACT_PUBLIC_PATHS` (exact match, matching the existing `/` entry — not a prefix, so no accidental exposure of some future `/track...` route).

## 4. Translation content

Extends the existing `src/messages/en.json` / `tr.json` catalogs (already used by the dashboard) with one new top-level namespace: `marketing`. Sub-namespaced per component — `marketing.hero`, `marketing.nav`, `marketing.footer`, `marketing.outcomes`, `marketing.theGrind`, `marketing.howItWorks`, `marketing.capabilities`, `marketing.safeguards`, `marketing.privacy`, `marketing.faq` (including FAQ items as a `t.raw()` array of `{question, answer}`, still passing `messages.test.ts`'s "every leaf is a non-empty string" check since it recurses through arrays the same as objects), `marketing.closingCta`, `marketing.bookMeetingButton`, `marketing.outcomePanel`, `marketing.seo` (title/description for `<title>`/OG tags).

**New shared component** `src/components/landing/landing-page.tsx` — a server component taking `locale: AppLocale`, moving the existing `<main>` composition out of `page.tsx` into one place shared by both routes:

```tsx
export function LandingPage({ locale }: { locale: AppLocale }): React.ReactElement {
  const messages = { marketing: MESSAGES_BY_LOCALE[locale].marketing }
  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      {/* existing <JsonLd>, <SiteNav>, <main>...</main>, <SiteFooter> tree */}
    </NextIntlClientProvider>
  )
}
```

`MESSAGES_BY_LOCALE` is a plain `{ en: enMessages, tr: trMessages }` map built from the two JSON imports — scoping to just the `marketing` key keeps the client bundle for this page from carrying unrelated dashboard message namespaces (`crm`, `campaigns`, etc.), respecting the < 200KB gzipped JS budget.

`page.tsx` and `tr/page.tsx` become thin: metadata + the signed-in-user redirect + `<LandingPage locale="en" />` / `<LandingPage locale="tr" />`.

Every landing section component (`Hero`, `Outcomes`, `TheGrind`, `HowItWorks`, `Capabilities`, `Safeguards`, `Privacy`, `Faq`, `ClosingCta`, `SiteNav`, `BookMeetingButton`, `OutcomePanel`) switches its hardcoded JSX strings to `useTranslations('marketing.x')` calls — next-intl's universal hook works in both the server components (most of these) and the existing client components (`SiteNav`, `Reveal`-wrapped bits using `motion/react`) without prop-drilling, since all of them render inside the `NextIntlClientProvider` set up above. `faq-items.ts`'s `FAQ_ITEMS` constant is replaced by reading `t.raw('items')` from `marketing.faq` inside `Faq`, still exported as the single source both the accordion and the `FAQPage` JSON-LD read (§6) — just sourced from messages instead of a hardcoded array.

`constants.ts`'s `NAV_LINKS` keeps `href` as-is (anchors aren't language-dependent) but drops the hardcoded `label` in favor of a translation key looked up by `href` in the nav component.

## 5. Footer switcher

**New Route Handler** `src/app/api/locale/route.ts`:

```ts
export async function GET(request: NextRequest): Promise<NextResponse>
```

- Reads `?locale=`, validates with the existing `localeSchema` (`src/lib/validation/locale.ts`) — invalid/missing value → `AppError('VALIDATION_ERROR', ...)` rendered as a 400, no cookie set, no redirect.
- On success: sets `marketing_locale` cookie (1 year, `httpOnly`, `sameSite: 'lax'` — only middleware/server ever needs to read it, no client JS involved), then `NextResponse.redirect` to `/` (`en`) or `/tr` (`tr`).
- No auth check — this is public, anonymous-visitor infrastructure, same trust level as the page itself.

`SiteFooter` gets a required `locale: AppLocale` prop (no default — explicit at every call site, per the project's "no magic behavior" rule) and an optional `showLanguageSwitcher?: boolean`. Its own copy (nav links, legal doc links label, copyright line) moves to `useTranslations('marketing.footer')`. When `showLanguageSwitcher` is true, it renders two plain `<a href="/api/locale?locale=en">` / `<a href="/api/locale?locale=tr">` links (the current locale styled as active/non-interactive) — no client JS, works with JS disabled, and the `httpOnly` cookie set by the redirect is what stops `/` from immediately bouncing a Turkey-geo visitor back to `/tr` after they've explicitly picked English.

Call sites:
- `landing-page.tsx` → `<SiteFooter locale={locale} showLanguageSwitcher />`
- `legal/page.tsx`, `legal/[slug]/page.tsx` → wrap in their own `<NextIntlClientProvider locale="en" messages={{ marketing: enMessages.marketing }}>` and render `<SiteFooter locale="en" />` (no switcher) — this is an explicit, self-contained 2-line addition to each file that renders byte-identical output to today, regardless of a visitor's browser language or geo. It exists only so `SiteFooter`'s new `useTranslations` call has a provider to read from on these two pages; nothing else about them changes.

## 6. SEO

- `/tr`'s `metadata`: Turkish `title`/`description` (from `marketing.seo` messages) and `alternates: { canonical: '/tr', languages: { en: '/', tr: '/tr' } }`. `/`'s existing `metadata` gains the reciprocal `languages` block. Next.js's Metadata API turns this into `<link rel="alternate" hreflang="...">` tags automatically.
- `src/app/sitemap.ts`: add a `/tr` entry alongside `/`.
- `src/lib/seo/json-ld.ts`'s `buildLandingJsonLd()` takes an explicit `locale` and the locale's own FAQ items/description, instead of implicitly always building English structured data — so `/tr`'s `FAQPage`/`Organization` JSON-LD actually matches what's rendered on that page.
- `llms.txt` / `llm.txt` and `robots.ts` are untouched — out of scope (machine-readable infra files, not the visitor-facing surface this task targets).

## 7. Testing

- `resolve-marketing-locale.test.ts` (new, mirrors `resolve-locale.test.ts`'s structure): cookie present + valid → cookie wins; no cookie + `x-vercel-ip-country: TR` → `'tr'`; no cookie/geo + `Accept-Language: tr-TR,tr;q=0.9` → `'tr'`; none of the above → `'en'`; invalid cookie value defensively ignored.
- `src/app/api/locale/route.test.ts` (new): valid `?locale=tr` → cookie set + 307 to `/tr`; valid `?locale=en` → cookie set + 307 to `/`; missing/invalid `locale` → 400, no cookie set.
- `src/messages/messages.test.ts` — no code change needed; its existing key-parity and non-empty-string checks automatically cover the new `marketing` namespace once populated in both `en.json` and `tr.json`.
- `public-paths.test.ts` (existing file, if present — otherwise inline in the path list's own test) — add a case asserting `/tr` is public.

## 8. Edge cases

- **Visitor from Turkey with an English-language browser**: geo header wins (`x-vercel-ip-country: TR`) — gets `/tr` even though `Accept-Language` says otherwise. Matches the literal ask ("visitors coming from Turkey").
- **Turkish-speaking visitor outside Turkey** (diaspora, VPN mismatch): geo says non-TR, but `Accept-Language: tr` still routes them to `/tr` — the fallback exists precisely for this case.
- **Local dev / any non-Vercel environment**: `x-vercel-ip-country` header is simply absent, so detection falls straight through to `Accept-Language`, then `en` — no crash, no special-casing needed.
- **Visitor manually switches to English while geo says Turkey, then clicks the logo to go back to `/`**: `marketing_locale=en` cookie (set by `/api/locale`) is present on that next request, so middleware honors it and does **not** redirect back to `/tr`. Without this cookie the switcher would appear broken (see §3).
- **Visitor manually switches to Turkish**: no redirect-loop risk to design around — `/tr` is never redirected away from regardless of cookie state (§3).
- **Signed-in user hits `/tr` directly** (e.g., an old bookmark): same "redirect to `/crm`" guard as `/` today — parity, no new gap.
- **Crawler/bot with no cookies and no `Accept-Language` header**: falls through to `en` — same default as an unrecognized `Accept-Language` value.

---

## Files touched

- `middleware.ts` (geo/cookie/language detection + redirect for `/`)
- `src/lib/auth/public-paths.ts` (`/tr` added)
- `src/app/api/locale/route.ts` (new)
- `src/app/api/locale/route.test.ts` (new)
- `src/app/(marketing)/tr/page.tsx` (new)
- `src/app/(marketing)/page.tsx` (trimmed to metadata + guard + `<LandingPage locale="en" />`)
- `src/app/(marketing)/legal/page.tsx`, `src/app/(marketing)/legal/[slug]/page.tsx` (explicit English-scoped provider around `<SiteFooter>`)
- `src/components/landing/landing-page.tsx` (new — shared composition + provider)
- Every component under `src/components/landing/*.tsx` (copy extracted to `useTranslations`)
- `src/components/landing/faq-items.ts` (removed — content moves into messages, `t.raw()` read from `Faq`)
- `src/components/landing/constants.ts` (`NAV_LINKS` drops hardcoded `label`)
- `src/lib/seo/json-ld.ts` (`buildLandingJsonLd()` takes `locale` + translated inputs)
- `src/app/sitemap.ts` (`/tr` entry)
- `src/messages/en.json`, `src/messages/tr.json` (new `marketing` namespace)
- A new `resolve-marketing-locale.ts` + `.test.ts` under `src/lib/i18n/` (the detection function itself, kept separate from the dashboard's `resolveLocale()` since the two have no shared logic beyond the `AppLocale` type and the `Accept-Language` parser, which this file imports/reuses from `resolve-locale.ts` rather than duplicating)
