# Landing Page Turkish i18n + Language Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the marketing home page in Turkish at `/tr` (auto-detected for visitors from Turkey, manually switchable), with legal documents staying English-only.

**Architecture:** A middleware-level redirect (`/` → `/tr`) driven by Vercel geo-IP + Accept-Language + a manual-override cookie; a second static route (`/tr/page.tsx`) mirroring `/`; landing copy extracted into a new `marketing` namespace in the existing next-intl message catalogs; every landing component resolves its own copy server-side via `getTranslations({ locale, namespace })` with `locale` threaded down as an explicit prop — no `NextIntlClientProvider` anywhere in the marketing tree.

**Tech Stack:** Next.js App Router, next-intl (already a dependency), Zod, Vitest.

**Spec:** [docs/superpowers/specs/2026-08-13-landing-turkish-i18n-design.md](../specs/2026-08-13-landing-turkish-i18n-design.md)

## Global Constraints

- Commit directly to `master` — this repo's convention is "don't branch, use main" (per `CLAUDE.md`).
- Update `.claude/roadmap.md` after meaningful progress (per `CLAUDE.md`) — the final task includes this explicitly; do it sooner too if a natural checkpoint arises.
- Legal documents (`/legal/*`) are out of scope and must render byte-identical to today throughout every task.
- No `NextIntlClientProvider` / `useTranslations` (client hook) anywhere in this feature — every component resolves copy server-side via `getTranslations({ locale, namespace })`, explicit `locale: AppLocale` prop, no ambient context. The one client component (`SiteNav`) and the one client component needing translated data (`OutcomePanel`) receive already-resolved strings/data as props from their server parent.
- Every new/changed message key must exist with a non-empty string value in both `src/messages/en.json` and `src/messages/tr.json` — `src/messages/messages.test.ts` enforces this and needs no code changes itself.
- `pnpm typecheck`, `pnpm lint`, and `pnpm test` must stay clean after every task.

---

## Task 1: Export locale-detection helpers from `resolve-locale.ts`

**Files:**
- Modify: `src/lib/i18n/resolve-locale.ts`
- Modify: `src/lib/i18n/resolve-locale.test.ts`

**Interfaces:**
- Produces: `isSupportedLocale(value: string): value is AppLocale`, `parseAcceptLanguage(header: string | null): AppLocale` — both now exported for reuse by Task 2's `resolve-marketing-locale.ts`.

- [x] **Step 1: Export the two helpers**

In `src/lib/i18n/resolve-locale.ts`, change:

```ts
function isSupportedLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
```

to:

```ts
export function isSupportedLocale(value: string): value is AppLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value)
}
```

and change:

```ts
function parseAcceptLanguage(header: string | null): AppLocale {
```

to:

```ts
export function parseAcceptLanguage(header: string | null): AppLocale {
```

No other change — the rest of the file (bodies, `resolvePreloginLocale`, `resolveLocale`) is untouched.

- [x] **Step 2: Add direct unit tests for the now-public helpers**

Append to `src/lib/i18n/resolve-locale.test.ts` (add the import at the top alongside the existing dynamic `resolveLocale` import, and add a new `describe` block at the end of the file):

```ts
const { isSupportedLocale, parseAcceptLanguage } = await import('./resolve-locale')
```

```ts
describe('isSupportedLocale', () => {
  it('should accept every supported locale', () => {
    expect(isSupportedLocale('en')).toBe(true)
    expect(isSupportedLocale('tr')).toBe(true)
  })

  it('should reject an unsupported value', () => {
    expect(isSupportedLocale('fr')).toBe(false)
    expect(isSupportedLocale('')).toBe(false)
  })
})

describe('parseAcceptLanguage', () => {
  it('should pick the first supported tag in preference order', () => {
    expect(parseAcceptLanguage('tr-TR,tr;q=0.9,en;q=0.8')).toBe('tr')
  })

  it('should default to en when no tag is supported', () => {
    expect(parseAcceptLanguage('fr-FR,fr;q=0.9')).toBe('en')
  })

  it('should default to en for a null header', () => {
    expect(parseAcceptLanguage(null)).toBe('en')
  })
})
```

- [x] **Step 3: Run the tests**

Run: `pnpm vitest run src/lib/i18n/resolve-locale.test.ts`
Expected: all tests PASS, including the 6 new ones.

- [x] **Step 4: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add src/lib/i18n/resolve-locale.ts src/lib/i18n/resolve-locale.test.ts
git commit -m "refactor(i18n): export isSupportedLocale and parseAcceptLanguage for reuse

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `resolveMarketingLocale` — anonymous-visitor locale detection

**Files:**
- Create: `src/lib/i18n/resolve-marketing-locale.ts`
- Test: `src/lib/i18n/resolve-marketing-locale.test.ts`

**Interfaces:**
- Consumes: `isSupportedLocale`, `parseAcceptLanguage` from `./resolve-locale` (Task 1); `AppLocale` from `@/types/i18n`.
- Produces: `MARKETING_LOCALE_COOKIE: string` (the cookie name, reused by Task 4's route handler), `resolveMarketingLocale(request: NextRequest): AppLocale` (consumed by Task 3's `middleware.ts`).

- [x] **Step 1: Write the failing test**

Create `src/lib/i18n/resolve-marketing-locale.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { NextRequest } from 'next/server'
import { MARKETING_LOCALE_COOKIE, resolveMarketingLocale } from './resolve-marketing-locale'

function fakeRequest({
  cookie,
  country,
  acceptLanguage,
}: {
  cookie?: string
  country?: string
  acceptLanguage?: string
}): NextRequest {
  const headerMap = new Map<string, string>()
  if (country) headerMap.set('x-vercel-ip-country', country)
  if (acceptLanguage) headerMap.set('accept-language', acceptLanguage)

  return {
    headers: { get: (name: string) => headerMap.get(name) ?? null },
    cookies: {
      get: (name: string) =>
        name === MARKETING_LOCALE_COOKIE && cookie !== undefined ? { name, value: cookie } : undefined,
    },
  } as unknown as NextRequest
}

describe('resolveMarketingLocale', () => {
  it('should honor the manual override cookie over geo and language', () => {
    const request = fakeRequest({ cookie: 'en', country: 'TR', acceptLanguage: 'tr' })
    expect(resolveMarketingLocale(request)).toBe('en')
  })

  it('should ignore an unsupported cookie value and fall through to geo', () => {
    const request = fakeRequest({ cookie: 'fr', country: 'TR' })
    expect(resolveMarketingLocale(request)).toBe('tr')
  })

  it('should resolve to tr when the geo header says Turkey', () => {
    expect(resolveMarketingLocale(fakeRequest({ country: 'TR' }))).toBe('tr')
  })

  it('should ignore a non-Turkey geo header and fall back to Accept-Language', () => {
    const request = fakeRequest({ country: 'DE', acceptLanguage: 'tr-TR,tr;q=0.9' })
    expect(resolveMarketingLocale(request)).toBe('tr')
  })

  it('should fall back to Accept-Language when there is no geo header at all', () => {
    const request = fakeRequest({ acceptLanguage: 'tr-TR,tr;q=0.9,en;q=0.8' })
    expect(resolveMarketingLocale(request)).toBe('tr')
  })

  it('should default to en when nothing matches', () => {
    const request = fakeRequest({ country: 'DE', acceptLanguage: 'fr-FR' })
    expect(resolveMarketingLocale(request)).toBe('en')
  })

  it('should default to en when no signals are present at all', () => {
    expect(resolveMarketingLocale(fakeRequest({}))).toBe('en')
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/lib/i18n/resolve-marketing-locale.test.ts`
Expected: FAIL — `Cannot find module './resolve-marketing-locale'`.

- [x] **Step 3: Implement**

Create `src/lib/i18n/resolve-marketing-locale.ts`:

```ts
import type { NextRequest } from 'next/server'
import { isSupportedLocale, parseAcceptLanguage } from './resolve-locale'
import type { AppLocale } from '@/types/i18n'

/** Set only by `/api/locale` (Task 4) when a visitor uses the footer switcher. */
export const MARKETING_LOCALE_COOKIE = 'marketing_locale'

/**
 * Locale for the anonymous marketing home page (`/`), used only by
 * `middleware.ts` to decide whether to redirect `/` to `/tr`.
 *
 * Priority: an explicit manual choice (the `marketing_locale` cookie) always
 * wins over automatic detection. Absent that, a visitor's IP-derived country
 * decides ("coming from Turkey" is the literal ask this exists to serve),
 * and only when that signal is unavailable (local dev, or any host that
 * does not set Vercel's edge geo header) does the browser's own language
 * preference decide. If neither signal points to a supported locale,
 * English.
 */
export function resolveMarketingLocale(request: NextRequest): AppLocale {
  const cookie = request.cookies.get(MARKETING_LOCALE_COOKIE)?.value
  if (cookie && isSupportedLocale(cookie)) return cookie
  if (request.headers.get('x-vercel-ip-country') === 'TR') return 'tr'
  return parseAcceptLanguage(request.headers.get('accept-language'))
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run: `pnpm vitest run src/lib/i18n/resolve-marketing-locale.test.ts`
Expected: all 7 tests PASS.

- [x] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add src/lib/i18n/resolve-marketing-locale.ts src/lib/i18n/resolve-marketing-locale.test.ts
git commit -m "feat(i18n): add resolveMarketingLocale for anonymous marketing visitors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Wire the `/` → `/tr` redirect into `middleware.ts`

**Files:**
- Modify: `middleware.ts`
- Modify: `src/lib/auth/public-paths.ts`
- Modify: `src/lib/auth/public-paths.test.ts`

**Interfaces:**
- Consumes: `resolveMarketingLocale` from `@/lib/i18n/resolve-marketing-locale` (Task 2).

- [x] **Step 1: Add `/tr` to the public paths, and a test for it**

In `src/lib/auth/public-paths.ts`, change:

```ts
const EXACT_PUBLIC_PATHS: readonly string[] = ['/', '/legal']
```

to:

```ts
/** `/tr` is the Turkish mirror of `/` — see the landing i18n design doc. */
const EXACT_PUBLIC_PATHS: readonly string[] = ['/', '/legal', '/tr']
```

In `src/lib/auth/public-paths.test.ts`, add a new test right after the existing `'should allow the marketing page'` test:

```ts
  it('should allow the Turkish marketing page', () => {
    expect(isPublicPath('/tr')).toBe(true)
  })
```

and extend the existing "should not treat a path that merely starts with a public segment as public" test by adding one more assertion inside its body:

```ts
    expect(isPublicPath('/track')).toBe(false)
```

- [x] **Step 2: Run the public-paths tests**

Run: `pnpm vitest run src/lib/auth/public-paths.test.ts`
Expected: all PASS, including the 2 new assertions.

- [x] **Step 3: Update `middleware.ts`**

Replace the full contents of `middleware.ts` with:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { resolveMarketingLocale } from '@/lib/i18n/resolve-marketing-locale'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * The marketing home page is the only route this project serves in more
 * than one language at its own URL (`/tr` — see the landing i18n design
 * doc). A visitor requesting the unprefixed `/` who resolves to Turkish is
 * redirected there before anything else runs; `/tr` itself is never
 * redirected away from, and every other path is untouched.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/' && resolveMarketingLocale(request) === 'tr') {
    const url = request.nextUrl.clone()
    url.pathname = '/tr'
    return NextResponse.redirect(url)
  }
  return updateSession(request)
}

/**
 * The crawler-facing files are excluded from the matcher, not added to the
 * `isPublic` list in `updateSession`: they are static assets with no session to
 * refresh, and leaving them matched meant an unauthenticated request for
 * `/robots.txt` was answered with a 302 to `/login`. Naive AEO crawlers score
 * that as "robots.txt present" while real ones see no rules at all.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|opengraph-image|twitter-image|icon|apple-icon|manifest.webmanifest).*)',
  ],
}
```

- [x] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [x] **Step 5: Manual smoke check**

Run: `pnpm dev`, then in another terminal:

```bash
curl -sI -H 'x-vercel-ip-country: TR' http://localhost:3000/ | head -5
curl -sI -H 'accept-language: tr-TR,tr;q=0.9' http://localhost:3000/ | head -5
curl -sI http://localhost:3000/ | head -5
curl -sI -H 'x-vercel-ip-country: TR' http://localhost:3000/tr | head -5
```

Expected: first two return `307`/`308` with `location: /tr`; third returns `200` (no `/tr/page.tsx` exists yet, so this is still served by the untouched `page.tsx`); fourth returns `404` for now (`/tr/page.tsx` doesn't exist until Task 7) — that 404 is expected at this point in the plan, not a bug.

- [x] **Step 6: Commit**

```bash
git add middleware.ts src/lib/auth/public-paths.ts src/lib/auth/public-paths.test.ts
git commit -m "feat(i18n): redirect / to /tr for visitors resolved to Turkish

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `/api/locale` route handler — the footer switcher's target

**Files:**
- Create: `src/app/api/locale/route.ts`
- Test: `src/app/api/locale/route.test.ts`

**Interfaces:**
- Consumes: `MARKETING_LOCALE_COOKIE` from `@/lib/i18n/resolve-marketing-locale` (Task 2); `localeSchema` from `@/lib/validation/locale` (existing); `env.APP_URL` from `@/lib/env` (existing).
- Produces: `GET` handler at `/api/locale?locale=en|tr`, linked to directly from `SiteFooter` (Task 7).

- [x] **Step 1: Write the failing test**

Create `src/app/api/locale/route.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { GET } from './route'
import { MARKETING_LOCALE_COOKIE } from '@/lib/i18n/resolve-marketing-locale'

function request(search: string): Request {
  return new Request(`http://localhost:3000/api/locale${search}`)
}

function locationOf(response: Response): string {
  return response.headers.get('location') ?? ''
}

describe('GET /api/locale', () => {
  it('should set the cookie and redirect to /tr for a valid tr locale', async () => {
    const response = await GET(request('?locale=tr'))
    expect(locationOf(response)).toBe('http://localhost:3000/tr')
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)?.value).toBe('tr')
  })

  it('should set the cookie and redirect to / for a valid en locale', async () => {
    const response = await GET(request('?locale=en'))
    expect(locationOf(response)).toBe('http://localhost:3000/')
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)?.value).toBe('en')
  })

  it('should reject an unsupported locale without setting a cookie', async () => {
    const response = await GET(request('?locale=fr'))
    expect(response.status).toBe(400)
    expect(response.cookies.get(MARKETING_LOCALE_COOKIE)).toBeUndefined()
  })

  it('should reject a missing locale param', async () => {
    const response = await GET(request(''))
    expect(response.status).toBe(400)
  })
})
```

- [x] **Step 2: Run it to confirm it fails**

Run: `pnpm vitest run src/app/api/locale/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [x] **Step 3: Implement**

Create `src/app/api/locale/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { MARKETING_LOCALE_COOKIE } from '@/lib/i18n/resolve-marketing-locale'
import { localeSchema } from '@/lib/validation/locale'

/** A manual language choice should stick for a long time. */
const MARKETING_LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

const REDIRECT_PATH_BY_LOCALE: Record<'en' | 'tr', string> = { en: '/', tr: '/tr' }

/**
 * Sets the visitor's manual language override for the marketing home page
 * and sends them to the matching URL. Linked to directly from the footer's
 * language switcher — plain `<a href>`, no client JS required.
 *
 * The cookie is what stops `middleware.ts`'s geo/Accept-Language detection
 * from immediately bouncing the visitor back to their detected locale on
 * the very next request to `/` (see the landing i18n design doc, §8).
 *
 * No auth check — this is public, anonymous-visitor infrastructure, the
 * same trust level as the page itself.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get('locale')
  const parsed = localeSchema.safeParse(requested)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_locale' }, { status: 400 })
  }

  const locale = parsed.data
  const response = NextResponse.redirect(new URL(REDIRECT_PATH_BY_LOCALE[locale], env.APP_URL))
  response.cookies.set(MARKETING_LOCALE_COOKIE, locale, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MARKETING_LOCALE_COOKIE_MAX_AGE_SECONDS,
  })
  return response
}
```

- [x] **Step 4: Run the test to confirm it passes**

Run: `pnpm vitest run src/app/api/locale/route.test.ts`
Expected: all 4 tests PASS. (`env.APP_URL` resolves to `http://localhost:3000` from `vitest.config.ts`'s global test-env stub — no additional mocking needed.)

- [x] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add src/app/api/locale/route.ts src/app/api/locale/route.test.ts
git commit -m "feat(i18n): add /api/locale route for the marketing language switcher

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `marketing` message namespace — full content, both locales

**Files:**
- Modify: `src/messages/en.json`
- Modify: `src/messages/tr.json`

**Interfaces:**
- Produces: the `marketing.*` key tree every later task's `getTranslations({ locale, namespace: 'marketing.x' })` call reads from. No code consumes these keys until Task 7 onward — this task only adds data, so nothing can regress.

Real Turkish translations are written now, in full — no placeholder/English-fallback text ships in `tr.json` at any point.

- [x] **Step 1: Append the `marketing` namespace to `en.json`**

In `src/messages/en.json`, the file currently ends with:

```json
    "setPasswordError": "Could not set your password. Try requesting a new invite link."
  }
}
```

Change the closing to add a new top-level `marketing` key:

```json
    "setPasswordError": "Could not set your password. Try requesting a new invite link."
  },
  "marketing": {
    "nav": {
      "ariaLabel": "Primary",
      "linkOutcomes": "Outcomes",
      "linkHow": "How it works",
      "linkSafeguards": "Email reputation",
      "signIn": "Sign in",
      "openMenu": "Open menu",
      "closeMenu": "Close menu"
    },
    "bookMeetingButton": {
      "label": "Book a meeting"
    },
    "footer": {
      "ariaLabelFooter": "Footer",
      "ariaLabelLegal": "Legal",
      "linkHow": "How it works",
      "linkPrivacy": "Privacy and security",
      "signIn": "Sign in",
      "bookMeeting": "Book a meeting",
      "copyright": "{year} Shengul AI. Outbound, handled."
    },
    "hero": {
      "eyebrow": "Outbound, handled",
      "headlinePrefix": "More ",
      "headlineHighlight": "qualified meetings",
      "headlineSuffix": ". Less manual prospecting.",
      "subtext": "Shengul AI finds your ideal prospects, researches them, creates personalized outreach, follows up automatically, and turns outbound into a predictable sales channel.",
      "secondaryCta": "See how it works"
    },
    "outcomePanel": {
      "thisMonth": "This month",
      "live": "Live",
      "exampleFigures": "Example figures",
      "meetingsBookedLine1": "meetings booked",
      "meetingsBookedLine2": "from your own mailbox",
      "new": "New",
      "footerNote": "Each one asked for the time themselves.",
      "meetingPool": [
        { "company": "Halvorsen Logistik", "kind": "Intro call", "when": "Tue 09:30" },
        { "company": "Nordkap Fertigung", "kind": "Second call", "when": "Wed 14:00" },
        { "company": "Vantera Diagnostics", "kind": "Intro call", "when": "Thu 11:15" },
        { "company": "Beckmann & Sohn", "kind": "Intro call", "when": "Fri 09:10" },
        { "company": "Lindqvist Interiors", "kind": "Second call", "when": "Mon 13:45" },
        { "company": "Alderney Robotics", "kind": "Intro call", "when": "Tue 10:20" },
        { "company": "Solheim Maritime", "kind": "Intro call", "when": "Wed 15:30" },
        { "company": "Kastrup & Weiss", "kind": "Second call", "when": "Thu 08:50" }
      ]
    },
    "outcomes": {
      "headlinePrefix": "Four numbers we track. ",
      "headlineHighlight": "One you close.",
      "description": "Everything here is meant to grow that fourth number. These are example figures for one month, just to show how the numbers connect — not a promise of your results.",
      "items": [
        { "value": "1,284", "label": "Leads found", "detail": "People who match the buyer you described." },
        { "value": "3,146", "label": "Emails sent", "detail": "Sent from your own mailbox, in small batches, at normal hours." },
        { "value": "184", "label": "Replies", "detail": "Answered in your voice. Follow-ups stop the moment someone replies." },
        { "value": "68", "label": "Meetings booked", "detail": "Booked straight into your calendar, with notes on the company attached." }
      ],
      "revenueFifthPrefix": "The fifth number is ",
      "revenueFifthHighlight": "yours",
      "revenueFifthSuffix": ".",
      "revenueBody": "{meetings} meetings, a {averageDeal} average deal, and a {closeRate} close rate adds up to {newBusiness} in new business from one month. Use your own numbers to see what a month could be worth to you.",
      "revenueMeetings": "68",
      "revenueAverageDeal": "$10,000",
      "revenueCloseRate": "30%",
      "revenueNewBusiness": "$204,000"
    },
    "theGrind": {
      "headlinePrefix": "Doing this yourself takes hours and ",
      "headlineHighlight": "rarely pays off",
      "headlineSuffix": ".",
      "costs": [
        "Hours every morning spent building lead lists.",
        "Late nights rewriting emails that still sound like a template.",
        "Follow-ups that never get sent, even to your best leads.",
        "Days of work for just a few meetings booked."
      ],
      "closingLine": "We take all of that off your plate."
    },
    "howItWorks": {
      "headlinePrefix": "Four steps. You only do ",
      "headlineHighlight": "two of them",
      "headlineSuffix": ".",
      "description": "Nothing to learn, nothing to check every morning. You start it and show up to the meetings — we handle everything in between, and report back as <link>four numbers</link>.",
      "movements": [
        { "title": "Talk with us.", "detail": "One call. Tell us what you sell and who you want to reach. That’s the whole setup." },
        { "title": "We find your leads.", "detail": "Every day, we find people who match the buyer you described, and check they’re a real fit for what you sell." },
        { "title": "We write a real email.", "detail": "Not a template with a name dropped in. Each email mentions something real about that company, written in your voice, sent from your own inbox." },
        { "title": "You take the meetings.", "detail": "We follow up until someone replies, then stop right away. The meeting lands on your calendar, waiting for you in the morning." }
      ]
    },
    "capabilities": {
      "heading": "What a normal week looks like.",
      "tile1Prefix": "Get ",
      "tile1Highlight": "two hours back every day",
      "tile1Suffix": ", and meetings on your calendar.",
      "tile1Body": "The time you used to spend on lists and rewritten emails now goes to people who already replied and picked a time.",
      "reliefs": ["No list building", "No first drafts", "No chasing"],
      "tile2Number": "3",
      "tile2Title": "Up to 3 follow-ups, then we stop.",
      "tile2Body": "Nobody is forgotten, and nobody is spammed. The moment someone replies, the follow-ups stop.",
      "tile3Title": "Every email is personal.",
      "tile3Body": "Each one opens with something real about that company — not a guess, not a generic line.",
      "tile3Callout": "Rather than: I hope this email finds you well.",
      "tile4Title": "It sounds like a person.",
      "tile4Body": "No tracking pixel, no unsubscribe footer, no bulk markers. An email from your own address, sent at an hour a human would send it.",
      "tile5Title": "You can read every email.",
      "tile5Body": "Every email we send is there for you to check. If a reply asks something we can’t answer honestly, we check with you instead of guessing."
    },
    "safeguards": {
      "headlinePrefix": "Protect and grow your ",
      "headlineHighlight": "email reputation",
      "headlineSuffix": ".",
      "description": "Your emails shouldn’t end up in spam. Sending too many at once is what causes that, so we do the opposite — small numbers, human hours, your own mailbox. The reputation you’ve built stays protected, and gets stronger over time. Here’s <link>how your data is stored and deleted</link>.",
      "promises": [
        { "title": "We start small.", "detail": "A few emails on day one, building up gradually. Nothing about it looks automated." },
        { "title": "We back off automatically.", "detail": "If something looks off, we pull that mailbox out of rotation right away, and tell you." },
        { "title": "One switch stops it.", "detail": "Stop one email, one mailbox, or everything at once — instantly." }
      ]
    },
    "privacy": {
      "heading": "How your data is handled.",
      "description": "Running outbound means sharing your mailbox and your lead list with us. Here’s exactly what happens to both — and separately, how we protect <link>the reputation of the domain you send from</link>.",
      "commitments": [
        { "title": "Everything is encrypted.", "detail": "Every connection uses TLS, and your mailbox login gets extra encryption before it’s ever saved." },
        { "title": "You can disconnect anytime.", "detail": "Your mailbox connects through Google or Microsoft’s own sign-in screen. Disconnect it and sending stops immediately." },
        { "title": "Your data stays yours.", "detail": "Kept separate at the database level — no query can ever return someone else’s information." },
        { "title": "Nothing is kept forever.", "detail": "Regular activity is deleted after 30 days, flagged records after 90, automatically." }
      ]
    },
    "faq": {
      "heading": "The things people ask before saying yes.",
      "items": [
        { "question": "Will it sound like me?", "answer": "Yes. Every email goes out from your own address, in your voice, and mentions something real about that company. If there’s nothing worth saying, we don’t send anything." },
        { "question": "Do I have to approve every email?", "answer": "Only if you want to. Some people read everything for the first fortnight and then let it run. Others never look. You can change your mind either way at any point." },
        { "question": "What happens when somebody actually replies?", "answer": "Follow-ups stop right away, and we reply the way you would. Anything serious comes straight to you, with your booking link already included." },
        { "question": "Will it make things up?", "answer": "No. We only write what we can verify. If a question comes up that we can’t answer honestly, we check with you first." },
        { "question": "What do you need from me?", "answer": "A mailbox, a clear picture of who you want to meet, what you sell, and a link to your calendar. Everything after that is set up and run for you." }
      ]
    },
    "closingCta": {
      "headlinePrefix": "Tell us ",
      "headlineHighlight": "who you want to meet",
      "headlineSuffix": ".",
      "description": "Half an hour is enough. You describe the buyer, we show you what the first month would look like, and you decide from there.",
      "footerNote": "Already working with us? <link>Sign in to your console</link> to see today’s replies."
    }
  }
}
```

- [x] **Step 2: Append the matching `marketing` namespace to `tr.json`**

In `src/messages/tr.json`, the file currently ends with:

```json
    "setPasswordError": "Şifreniz belirlenemedi. Yeni bir davet bağlantısı isteyin."
  }
}
```

Change the closing to add the Turkish `marketing` key, with the exact same shape as `en.json` above:

```json
    "setPasswordError": "Şifreniz belirlenemedi. Yeni bir davet bağlantısı isteyin."
  },
  "marketing": {
    "nav": {
      "ariaLabel": "Ana menü",
      "linkOutcomes": "Sonuçlar",
      "linkHow": "Nasıl çalışır",
      "linkSafeguards": "E-posta itibarı",
      "signIn": "Giriş yap",
      "openMenu": "Menüyü aç",
      "closeMenu": "Menüyü kapat"
    },
    "bookMeetingButton": {
      "label": "Görüşme planlayın"
    },
    "footer": {
      "ariaLabelFooter": "Alt bilgi",
      "ariaLabelLegal": "Yasal",
      "linkHow": "Nasıl çalışır",
      "linkPrivacy": "Gizlilik ve güvenlik",
      "signIn": "Giriş yap",
      "bookMeeting": "Görüşme planlayın",
      "copyright": "{year} Shengul AI. Dış satış, bizde."
    },
    "hero": {
      "eyebrow": "Dış satış, bizde",
      "headlinePrefix": "Daha fazla ",
      "headlineHighlight": "nitelikli görüşme",
      "headlineSuffix": ". Daha az manuel müşteri arama.",
      "subtext": "Shengul AI, ideal potansiyel müşterilerinizi bulur, onları araştırır, kişiselleştirilmiş e-postalar oluşturur, otomatik olarak takip eder ve dış satışı öngörülebilir bir satış kanalına dönüştürür.",
      "secondaryCta": "Nasıl çalıştığını gör"
    },
    "outcomePanel": {
      "thisMonth": "Bu ay",
      "live": "Canlı",
      "exampleFigures": "Örnek rakamlar",
      "meetingsBookedLine1": "planlanan görüşme",
      "meetingsBookedLine2": "kendi e-posta kutunuzdan",
      "new": "Yeni",
      "footerNote": "Her biri randevu saatini kendisi seçti.",
      "meetingPool": [
        { "company": "Halvorsen Logistik", "kind": "Tanışma görüşmesi", "when": "Sal 09:30" },
        { "company": "Nordkap Fertigung", "kind": "İkinci görüşme", "when": "Çar 14:00" },
        { "company": "Vantera Diagnostics", "kind": "Tanışma görüşmesi", "when": "Per 11:15" },
        { "company": "Beckmann & Sohn", "kind": "Tanışma görüşmesi", "when": "Cum 09:10" },
        { "company": "Lindqvist Interiors", "kind": "İkinci görüşme", "when": "Pzt 13:45" },
        { "company": "Alderney Robotics", "kind": "Tanışma görüşmesi", "when": "Sal 10:20" },
        { "company": "Solheim Maritime", "kind": "Tanışma görüşmesi", "when": "Çar 15:30" },
        { "company": "Kastrup & Weiss", "kind": "İkinci görüşme", "when": "Per 08:50" }
      ]
    },
    "outcomes": {
      "headlinePrefix": "Takip ettiğimiz dört rakam. ",
      "headlineHighlight": "Kapattığınız bir tanesi.",
      "description": "Buradaki her şey o dördüncü rakamı büyütmek için var. Bunlar rakamların nasıl bağlandığını göstermek için tek bir aya ait örnek rakamlardır — sonuçlarınızın bir garantisi değildir.",
      "items": [
        { "value": "1.284", "label": "Bulunan potansiyel müşteri", "detail": "Tarif ettiğiniz alıcı profiline uyan kişiler." },
        { "value": "3.146", "label": "Gönderilen e-posta", "detail": "Kendi e-posta adresinizden, küçük gruplar hâlinde, normal saatlerde gönderilir." },
        { "value": "184", "label": "Yanıt", "detail": "Sizin üslubunuzla yanıtlanır. Biri yanıt verdiği an takip e-postaları durur." },
        { "value": "68", "label": "Planlanan görüşme", "detail": "Şirket hakkında notlarla birlikte doğrudan takviminize eklenir." }
      ],
      "revenueFifthPrefix": "Beşinci rakam ",
      "revenueFifthHighlight": "sizinki",
      "revenueFifthSuffix": ".",
      "revenueBody": "{meetings} görüşme, {averageDeal} ortalama anlaşma değeri ve {closeRate} kapanış oranıyla bir ayda {newBusiness} yeni iş demek. Bir ayın sizin için ne değer taşıyacağını görmek için kendi rakamlarınızı kullanın.",
      "revenueMeetings": "68",
      "revenueAverageDeal": "10.000 $",
      "revenueCloseRate": "%30",
      "revenueNewBusiness": "204.000 $"
    },
    "theGrind": {
      "headlinePrefix": "Bunu kendiniz yapmak saatler alır ve ",
      "headlineHighlight": "nadiren karşılığını verir",
      "headlineSuffix": ".",
      "costs": [
        "Her sabah liste oluşturmakla geçen saatler.",
        "Hâlâ şablon gibi duran e-postaları yeniden yazmakla geçen geç saatler.",
        "En iyi adaylarınıza bile gönderilmeyen takip e-postaları.",
        "Sadece birkaç görüşme için günlerce süren emek."
      ],
      "closingLine": "Bunların hepsini sizin yerinize biz üstleniyoruz."
    },
    "howItWorks": {
      "headlinePrefix": "Dört adım. Bunlardan sadece ",
      "headlineHighlight": "ikisini siz yapıyorsunuz",
      "headlineSuffix": ".",
      "description": "Öğrenecek bir şey yok, her sabah kontrol edecek bir şey yok. Siz başlatın ve görüşmelere gelin — arada kalan her şeyi biz hallederiz ve size <link>dört rakam</link> olarak raporlarız.",
      "movements": [
        { "title": "Bizimle konuşun.", "detail": "Tek bir görüşme. Ne sattığınızı ve kime ulaşmak istediğinizi anlatın. Kurulum bundan ibaret." },
        { "title": "Potansiyel müşterilerinizi buluruz.", "detail": "Her gün, tarif ettiğiniz alıcı profiline uyan kişileri buluruz ve sattığınız şey için gerçekten uygun olduklarını kontrol ederiz." },
        { "title": "Gerçek bir e-posta yazarız.", "detail": "İçine isim sıkıştırılmış bir şablon değil. Her e-posta o şirketle ilgili gerçek bir şeyden bahseder, sizin üslubunuzla yazılır ve kendi e-posta adresinizden gönderilir." },
        { "title": "Görüşmelere siz katılırsınız.", "detail": "Biri yanıt verene kadar takip ederiz, sonra hemen dururuz. Görüşme takviminize düşer ve sabah sizi bekler." }
      ]
    },
    "capabilities": {
      "heading": "Normal bir hafta neye benzer?",
      "tile1Prefix": "Her gün ",
      "tile1Highlight": "iki saatinizi geri kazanın",
      "tile1Suffix": " ve takviminizde görüşmeler olsun.",
      "tile1Body": "Eskiden listelere ve yeniden yazılan e-postalara harcadığınız zaman, artık yanıt verip bir saat seçmiş kişilere ayrılıyor.",
      "reliefs": ["Liste oluşturma yok", "İlk taslak yazma yok", "Peşinden koşma yok"],
      "tile2Number": "3",
      "tile2Title": "En fazla 3 takip e-postası, sonra dururuz.",
      "tile2Body": "Kimse unutulmaz, kimseye spam gönderilmez. Biri yanıt verdiği an takip e-postaları durur.",
      "tile3Title": "Her e-posta kişiseldir.",
      "tile3Body": "Her biri o şirketle ilgili gerçek bir şeyle başlar — tahmin değil, kalıp bir cümle değil.",
      "tile3Callout": "Şöyle değil: Umarım bu e-posta sizi iyi bulur.",
      "tile4Title": "Bir insan gibi duyulur.",
      "tile4Body": "Takip pikseli yok, abonelikten çıkma metni yok, toplu gönderim işareti yok. Kendi adresinizden, bir insanın göndereceği saatte gönderilen bir e-posta.",
      "tile5Title": "Her e-postayı okuyabilirsiniz.",
      "tile5Body": "Gönderdiğimiz her e-posta kontrol etmeniz için orada durur. Bir yanıt dürüstçe cevaplayamayacağımız bir şey sorarsa, tahmin etmek yerine size danışırız."
    },
    "safeguards": {
      "headlinePrefix": "E-posta itibarınızı ",
      "headlineHighlight": "koruyun ve büyütün",
      "headlineSuffix": ".",
      "description": "E-postalarınız spam’e düşmemeli. Bunun genelde sebebi bir kerede çok fazla e-posta göndermektir; biz tam tersini yapıyoruz — küçük sayılar, insan saatleri, kendi e-posta adresiniz. Oluşturduğunuz itibar korunur ve zamanla güçlenir. <link>Verilerinizin nasıl saklandığını ve silindiğini</link> buradan öğrenebilirsiniz.",
      "promises": [
        { "title": "Küçük başlarız.", "detail": "İlk gün birkaç e-posta, kademeli olarak artar. Hiçbir şey otomatik görünmez." },
        { "title": "Otomatik olarak geri çekiliriz.", "detail": "Bir şey ters görünürse, o e-posta kutusunu hemen devre dışı bırakır ve size haber veririz." },
        { "title": "Tek bir düğmeyle durdurulur.", "detail": "Tek bir e-postayı, tek bir kutuyu ya da her şeyi anında durdurun." }
      ]
    },
    "privacy": {
      "heading": "Verileriniz nasıl işlenir?",
      "description": "Dış satış yapmak, e-posta kutunuzu ve potansiyel müşteri listenizi bizimle paylaşmak demektir. İkisine de tam olarak ne olduğunu — ve ayrıca <link>gönderim yaptığınız alan adının itibarını nasıl koruduğumuzu</link> — burada bulabilirsiniz.",
      "commitments": [
        { "title": "Her şey şifrelenir.", "detail": "Her bağlantı TLS kullanır ve e-posta kutunuzun giriş bilgileri kaydedilmeden önce ekstra şifrelemeden geçer." },
        { "title": "İstediğiniz zaman bağlantıyı kesebilirsiniz.", "detail": "E-posta kutunuz Google veya Microsoft’un kendi giriş ekranı üzerinden bağlanır. Bağlantıyı kesin, gönderim anında durur." },
        { "title": "Verileriniz size ait kalır.", "detail": "Veritabanı seviyesinde ayrı tutulur — hiçbir sorgu başka birinin bilgisini döndüremez." },
        { "title": "Hiçbir şey sonsuza kadar saklanmaz.", "detail": "Rutin etkinlik kayıtları 30 gün, işaretlenmiş kayıtlar 90 gün sonra otomatik olarak silinir." }
      ]
    },
    "faq": {
      "heading": "İnsanların evet demeden önce sorduğu şeyler.",
      "items": [
        { "question": "Bana benziyor mu?", "answer": "Evet. Her e-posta kendi adresinizden, sizin üslubunuzla gönderilir ve o şirketle ilgili gerçek bir şeyden bahseder. Söylenecek bir şey yoksa, hiçbir şey göndermeyiz." },
        { "question": "Her e-postayı onaylamam gerekir mi?", "answer": "Sadece isterseniz. Bazı kullanıcılar ilk iki hafta her şeyi okur, sonra kendi hâline bırakır. Bazıları hiç bakmaz. İstediğiniz zaman fikrinizi değiştirebilirsiniz." },
        { "question": "Biri gerçekten yanıt verirse ne olur?", "answer": "Takip e-postaları hemen durur ve sizin yanıtlayacağınız gibi yanıtlarız. Ciddi olan her şey, randevu linkiniz eklenmiş şekilde doğrudan size gelir." },
        { "question": "Bir şeyler uydurur mu?", "answer": "Hayır. Yalnızca doğrulayabildiğimiz şeyleri yazarız. Dürüstçe cevaplayamayacağımız bir soru çıkarsa, önce size danışırız." },
        { "question": "Benden ne istiyorsunuz?", "answer": "Bir e-posta kutusu, kiminle görüşmek istediğinize dair net bir fikir, ne sattığınız ve takvim linkiniz. Bundan sonraki her şeyi biz kurar ve yürütürüz." }
      ]
    },
    "closingCta": {
      "headlinePrefix": "Bize ",
      "headlineHighlight": "kiminle görüşmek istediğinizi söyleyin",
      "headlineSuffix": ".",
      "description": "Yarım saat yeterli. Alıcı profilinizi anlatın, ilk ayın neye benzeyeceğini gösterelim, gerisine siz karar verin.",
      "footerNote": "Zaten bizimle çalışıyor musunuz? Bugünkü yanıtları görmek için <link>kontrol panelinize giriş yapın</link>."
    }
  }
}
```

- [x] **Step 3: Verify parity and non-empty values**

Run: `pnpm vitest run src/messages/messages.test.ts`
Expected: both existing tests PASS — the `marketing` key tree is now identical in shape between `en.json` and `tr.json`, and every leaf is a non-empty string.

- [x] **Step 4: Validate both files are well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('src/messages/en.json','utf8')); JSON.parse(require('fs').readFileSync('src/messages/tr.json','utf8')); console.log('both valid')"`
Expected: prints `both valid` with no error.

- [x] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add src/messages/en.json src/messages/tr.json
git commit -m "feat(i18n): add marketing namespace content for landing page (en + tr)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Turkish SEO constants + locale-aware `buildLandingJsonLd` + sitemap

**Files:**
- Modify: `src/lib/seo/site.ts`
- Modify: `src/lib/seo/json-ld.ts`
- Modify: `src/lib/seo/json-ld.test.ts`
- Modify: `src/app/sitemap.ts`

**Interfaces:**
- Produces: `LANDING_TITLE_TR`, `LANDING_DESCRIPTION_TR`, `SITE_SUMMARY_TR` (consumed by Task 7's `tr/page.tsx` and `landing-page.tsx`); `buildLandingJsonLd(input: LandingJsonLdInput)` with new required fields `pagePath: string`, `locale: AppLocale`, `summary: string` (replacing the old implicit-English behavior) — consumed by Task 7's `landing-page.tsx`.

- [x] **Step 1: Add the Turkish SEO constants to `site.ts`**

In `src/lib/seo/site.ts`, change:

```ts
/** One-line summary used at the top of llms.txt and as the OG subtitle. */
export const SITE_SUMMARY =
  'Managed B2B outbound: buyer research, cold email, reply handling and meeting booking, run from your own mailbox.'

export const SITE_LANGUAGE = 'en'
export const SITE_LOCALE = 'en_US'
```

to:

```ts
/** One-line summary used at the top of llms.txt and as the OG subtitle. */
export const SITE_SUMMARY =
  'Managed B2B outbound: buyer research, cold email, reply handling and meeting booking, run from your own mailbox.'

/**
 * Turkish counterparts of `SITE_TITLE`/`LANDING_DESCRIPTION`/`SITE_SUMMARY`,
 * used only by `/tr` (`src/app/(marketing)/tr/page.tsx`) and its JSON-LD.
 * Kept here rather than in the `marketing` message namespace so every
 * machine-readable surface still has exactly one source of copy, per this
 * file's own header comment above.
 */
export const LANDING_TITLE_TR = 'Daha fazla görüşme, dış satışın zahmeti yok'

export const LANDING_DESCRIPTION_TR =
  'Alıcı profilinizi siz tarif edin. Shengul AI onları bulur, e-postaları yazar, yanıtları cevaplar ve planlanan görüşmeleri size teslim eder. Dış satış ekibine gerek yok.'

export const SITE_SUMMARY_TR =
  'Yönetilen B2B dış satış: alıcı araştırması, soğuk e-posta, yanıt yönetimi ve görüşme planlama — hepsi kendi e-posta adresinizden yürütülür.'

export const SITE_LANGUAGE = 'en'
export const SITE_LOCALE = 'en_US'
```

- [x] **Step 2: Update `json-ld.test.ts` for the new required fields (TDD — this runs red until Step 3)**

Replace the full contents of `src/lib/seo/json-ld.test.ts` with:

```ts
import { describe, expect, it } from 'vitest'
import { buildLandingJsonLd, serializeJsonLd, type FaqEntry } from '@/lib/seo/json-ld'

const FAQ_ITEMS: readonly FaqEntry[] = [
  { question: 'Will it sound like me?', answer: 'Yes — it writes from your own address.' },
  { question: 'What do you need from me?', answer: 'A mailbox and a booking link.' },
]

const INPUT = {
  siteUrl: 'https://example.com',
  pagePath: '/',
  locale: 'en',
  summary: 'Managed B2B outbound, run from your own mailbox.',
  faqItems: FAQ_ITEMS,
  publishedAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-25T00:00:00.000Z',
} as const

function nodesByType(graph: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const nodes = graph['@graph'] as Record<string, unknown>[]
  return new Map(nodes.map((node) => [node['@type'] as string, node]))
}

describe('buildLandingJsonLd', () => {
  it('should declare the schema.org context', () => {
    expect(buildLandingJsonLd(INPUT)['@context']).toBe('https://schema.org')
  })

  it('should emit every node type an AEO crawler checks for', () => {
    const types = [...nodesByType(buildLandingJsonLd(INPUT)).keys()]
    expect(types).toEqual(
      expect.arrayContaining(['Organization', 'WebSite', 'WebPage', 'FAQPage', 'ImageObject']),
    )
  })

  it('should carry both freshness dates on the WebPage node', () => {
    const webPage = nodesByType(buildLandingJsonLd(INPUT)).get('WebPage')
    expect(webPage?.datePublished).toBe(INPUT.publishedAt)
    expect(webPage?.dateModified).toBe(INPUT.updatedAt)
  })

  it('should turn every FAQ item into a Question with an accepted answer', () => {
    const faqPage = nodesByType(buildLandingJsonLd(INPUT)).get('FAQPage')
    expect(faqPage?.mainEntity).toEqual([
      {
        '@type': 'Question',
        name: 'Will it sound like me?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes — it writes from your own address.' },
      },
      {
        '@type': 'Question',
        name: 'What do you need from me?',
        acceptedAnswer: { '@type': 'Answer', text: 'A mailbox and a booking link.' },
      },
    ])
  })

  it('should produce an empty mainEntity when there are no FAQ items', () => {
    const faqPage = nodesByType(buildLandingJsonLd({ ...INPUT, faqItems: [] })).get('FAQPage')
    expect(faqPage?.mainEntity).toEqual([])
  })

  it('should cross-reference nodes by resolvable @id', () => {
    const nodes = nodesByType(buildLandingJsonLd(INPUT))
    const ids = new Set([...nodes.values()].map((node) => node['@id']))
    const webPage = nodes.get('WebPage')
    expect(ids.has((webPage?.isPartOf as { '@id': string })['@id'])).toBe(true)
    expect(ids.has((webPage?.about as { '@id': string })['@id'])).toBe(true)
  })

  it('should build absolute URLs even when the origin has a trailing slash', () => {
    const webPage = nodesByType(buildLandingJsonLd({ ...INPUT, siteUrl: 'https://example.com' })).get(
      'WebPage',
    )
    expect(webPage?.url).toBe('https://example.com/')
  })

  it('should anchor the WebPage/FAQPage ids to the given pagePath, not always /', () => {
    const built = buildLandingJsonLd({ ...INPUT, pagePath: '/tr' })
    const webPage = nodesByType(built).get('WebPage')
    const faqPage = nodesByType(built).get('FAQPage')
    expect(webPage?.url).toBe('https://example.com/tr')
    expect(webPage?.['@id']).toBe('https://example.com/tr#webpage')
    expect(faqPage?.['@id']).toBe('https://example.com/tr#faq')
  })

  it('should keep Organization/WebSite anchored to the site root regardless of pagePath', () => {
    const built = buildLandingJsonLd({ ...INPUT, pagePath: '/tr' })
    const nodes = nodesByType(built)
    expect(nodes.get('Organization')?.['@id']).toBe('https://example.com/#organization')
    expect(nodes.get('WebSite')?.['@id']).toBe('https://example.com/#website')
  })

  it('should reflect the given locale and summary on every node', () => {
    const built = buildLandingJsonLd({ ...INPUT, locale: 'tr', summary: 'Türkçe özet.' })
    const nodes = nodesByType(built)
    expect(nodes.get('WebPage')?.inLanguage).toBe('tr')
    expect(nodes.get('FAQPage')?.inLanguage).toBe('tr')
    expect(nodes.get('Organization')?.description).toBe('Türkçe özet.')
  })
})

describe('serializeJsonLd', () => {
  it('should escape a script-closing sequence hidden in content', () => {
    const output = serializeJsonLd({ name: '</script><img onerror=alert(1)>' })
    expect(output).not.toContain('</script>')
    expect(output).not.toContain('<')
    expect(output).not.toContain('>')
  })

  it('should escape ampersands', () => {
    expect(serializeJsonLd({ name: 'a&b' })).toBe('{"name":"a\\u0026b"}')
  })

  it('should round-trip back to the original value', () => {
    const value = { name: 'Shengul AI', tags: ['a<b', 'c&d'] }
    expect(JSON.parse(serializeJsonLd(value))).toEqual(value)
  })
})
```

- [x] **Step 3: Confirm it fails**

Run: `pnpm vitest run src/lib/seo/json-ld.test.ts`
Expected: FAIL — `buildLandingJsonLd` doesn't accept `pagePath`/`locale`/`summary` yet (type error at build, and the id/language assertions fail at runtime against the current implementation).

- [x] **Step 4: Rewrite `json-ld.ts`**

Replace the full contents of `src/lib/seo/json-ld.ts` with:

```ts
import { absoluteUrl, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH, SITE_NAME } from '@/lib/seo/site'
import type { AppLocale } from '@/types/i18n'

/**
 * Structured data for the public marketing page.
 *
 * Emitted as a single `@graph` rather than several disconnected scripts so the
 * nodes can reference each other by `@id` — an AI crawler that reads the
 * `FAQPage` then knows which organisation is answering.
 */

export interface FaqEntry {
  readonly question: string
  readonly answer: string
}

export interface LandingJsonLdInput {
  /** Site origin, no trailing slash. */
  readonly siteUrl: string
  /** `/` or `/tr` — which marketing page this graph describes. */
  readonly pagePath: string
  readonly locale: AppLocale
  /** Locale-appropriate one-line summary — `SITE_SUMMARY` or `SITE_SUMMARY_TR`. */
  readonly summary: string
  readonly faqItems: readonly FaqEntry[]
  /** ISO 8601 timestamps. Surfaced as the page's freshness signal. */
  readonly publishedAt: string
  readonly updatedAt: string
}

type JsonLdNode = Record<string, unknown>

export function buildLandingJsonLd({
  siteUrl,
  pagePath,
  locale,
  summary,
  faqItems,
  publishedAt,
  updatedAt,
}: LandingJsonLdInput): JsonLdNode {
  // Organization/Website identity is anchored to the canonical root
  // regardless of which page renders it — it is the same organisation on
  // every page. WebPage/FAQPage are anchored to the page actually rendering,
  // so each locale's crawl gets its own resolvable node.
  const homeUrl = absoluteUrl(siteUrl, '/')
  const pageUrl = absoluteUrl(siteUrl, pagePath)
  const organizationId = `${homeUrl}#organization`
  const websiteId = `${homeUrl}#website`
  const webPageId = `${pageUrl}#webpage`
  const imageId = `${homeUrl}#primaryimage`

  const organization: JsonLdNode = {
    '@type': 'Organization',
    '@id': organizationId,
    name: SITE_NAME,
    url: homeUrl,
    description: summary,
    logo: { '@id': imageId },
    image: { '@id': imageId },
  }

  const image: JsonLdNode = {
    '@type': 'ImageObject',
    '@id': imageId,
    url: absoluteUrl(siteUrl, OG_IMAGE_PATH),
    contentUrl: absoluteUrl(siteUrl, OG_IMAGE_PATH),
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    caption: `${SITE_NAME} — ${summary}`,
  }

  const website: JsonLdNode = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: homeUrl,
    name: SITE_NAME,
    description: summary,
    publisher: { '@id': organizationId },
    inLanguage: locale,
  }

  const webPage: JsonLdNode = {
    '@type': 'WebPage',
    '@id': webPageId,
    url: pageUrl,
    name: `${SITE_NAME} — ${summary}`,
    description: summary,
    isPartOf: { '@id': websiteId },
    about: { '@id': organizationId },
    primaryImageOfPage: { '@id': imageId },
    datePublished: publishedAt,
    dateModified: updatedAt,
    inLanguage: locale,
  }

  const faqPage: JsonLdNode = {
    '@type': 'FAQPage',
    '@id': `${pageUrl}#faq`,
    isPartOf: { '@id': webPageId },
    inLanguage: locale,
    dateModified: updatedAt,
    mainEntity: faqItems.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  }

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, image, website, webPage, faqPage],
  }
}

/**
 * Serialises a JSON-LD node for injection into a `<script>` tag.
 *
 * `<`, `>` and `&` are escaped to their JSON unicode forms: without it, copy
 * containing `</script>` would close the tag early and turn page content into
 * executable markup.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}
```

- [x] **Step 5: Run the test to confirm it passes**

Run: `pnpm vitest run src/lib/seo/json-ld.test.ts`
Expected: all tests PASS, including the 3 new ones.

- [x] **Step 6: Add `/tr` to the sitemap**

Replace the full contents of `src/app/sitemap.ts` with:

```ts
import type { MetadataRoute } from 'next'
import { LEGAL_DOCUMENTS, LEGAL_PATH_PREFIX, legalDocumentPath } from '@/lib/legal/registry'
import { absoluteUrl, CONTENT_UPDATED_AT } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'

/**
 * `/` and `/tr` plus the published legal documents: every other route is
 * either behind auth or a sign-in form carrying `noindex`, and a sitemap
 * that advertises unindexable URLs is a negative quality signal rather than
 * a neutral one.
 *
 * The legal pages belong here despite being unglamorous — somebody who wants to
 * know where we got their details should be able to reach that page from a
 * search engine, not only from a link inside the email that prompted the
 * question.
 *
 * `lastModified` is the freshness signal AI crawlers read, so it tracks
 * hand-maintained dates rather than the deploy time.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteUrl(SITE_URL, '/'),
      lastModified: new Date(CONTENT_UPDATED_AT),
      changeFrequency: 'monthly',
      priority: 1,
    },
    {
      url: absoluteUrl(SITE_URL, '/tr'),
      lastModified: new Date(CONTENT_UPDATED_AT),
      changeFrequency: 'monthly',
      priority: 1,
    },
    {
      url: absoluteUrl(SITE_URL, LEGAL_PATH_PREFIX),
      lastModified: new Date(CONTENT_UPDATED_AT),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    ...LEGAL_DOCUMENTS.map((document) => ({
      url: absoluteUrl(SITE_URL, legalDocumentPath(document.slug)),
      lastModified: new Date(document.updatedAt),
      changeFrequency: 'yearly' as const,
      priority: 0.3,
    })),
  ]
}
```

- [x] **Step 7: Typecheck, lint, and full test run**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run src/lib/seo`
Expected: all clean.

- [x] **Step 8: Commit**

```bash
git add src/lib/seo/site.ts src/lib/seo/json-ld.ts src/lib/seo/json-ld.test.ts src/app/sitemap.ts
git commit -m "feat(seo): locale-aware JSON-LD, Turkish SEO copy, /tr in sitemap

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: Routing + chrome skeleton — `/tr` exists and renders, nav/footer/CTA translated

This is the one coordinated task that changes the shared component interfaces (`BookMeetingButton`, `SiteNav`, `SiteFooter`) that nearly every other landing file calls — every call site is updated in this same task so the app keeps compiling and rendering correctly the whole way through. The 9 body-section components (`Hero` through `ClosingCta`) get only a *mechanical* change here (accept a `locale` prop, thread it to their own `BookMeetingButton` call) — their own copy stays hardcoded English for now and gets converted in Tasks 8–13.

No new tests in this task — there is no existing precedent for testing landing components in this codebase (`QUALITY.md`'s testing targets list "React components: Critical paths only", and none of `src/components/landing/*.tsx` has a test file today). Verification is `pnpm typecheck` + `pnpm lint` + `pnpm build` + manual browser checks, consistent with how this directory has always been verified.

**Files:**
- Modify: `src/components/landing/constants.ts`
- Modify: `src/components/landing/book-meeting-button.tsx`
- Modify: `src/components/landing/site-nav.tsx`
- Modify: `src/components/landing/site-footer.tsx`
- Create: `src/components/landing/landing-page.tsx`
- Modify: `src/app/(marketing)/page.tsx`
- Create: `src/app/(marketing)/tr/page.tsx`
- Modify: `src/app/(marketing)/legal/page.tsx`
- Modify: `src/app/(marketing)/legal/[slug]/page.tsx`
- Modify: `src/components/landing/hero.tsx` (mechanical only — full conversion in Task 8)
- Modify: `src/components/landing/outcomes.tsx` (mechanical only — full conversion in Task 9)
- Modify: `src/components/landing/the-grind.tsx` (mechanical only — full conversion in Task 9)
- Modify: `src/components/landing/how-it-works.tsx` (mechanical only — full conversion in Task 10)
- Modify: `src/components/landing/capabilities.tsx` (mechanical only — full conversion in Task 10)
- Modify: `src/components/landing/safeguards.tsx` (mechanical only — full conversion in Task 11)
- Modify: `src/components/landing/privacy.tsx` (mechanical only — full conversion in Task 11)
- Modify: `src/components/landing/faq.tsx` (mechanical only — full conversion in Task 12)
- Modify: `src/components/landing/closing-cta.tsx` (mechanical only — full conversion in Task 13)

**Interfaces:**
- Consumes: `marketing.nav`/`marketing.footer`/`marketing.bookMeetingButton` messages (Task 5); `buildLandingJsonLd`, `LANDING_TITLE_TR`, `LANDING_DESCRIPTION_TR`, `SITE_SUMMARY_TR` (Task 6).
- Produces: `LandingPage({ locale: AppLocale })` (the shared composition, no other task consumes it further); `BookMeetingButton({ locale: AppLocale, size?, className? })`; `SiteNav({ copy: SiteNavCopy, locale: AppLocale })`; `SiteFooter({ locale: AppLocale, showLanguageSwitcher?: boolean })` — these three signatures are now final and every later task's component calls them as `<BookMeetingButton locale={locale} size="lg" />` with no further signature changes.

- [x] **Step 1: `constants.ts` — `NAV_LINKS` carries a translation key instead of English text**

Replace the full contents of `src/components/landing/constants.ts` with:

```ts
/**
 * Shared constants for the public marketing page (`/`, `/tr`).
 *
 * The booking link is the page's single conversion target: every "Book a
 * meeting" control on the page points here, so it lives in exactly one place.
 */
export const BOOKING_URL = 'https://cal.com/shengul-yavuz'

export interface NavLink {
  readonly href: string
  readonly labelKey: 'linkOutcomes' | 'linkHow' | 'linkSafeguards'
}

/** In-page anchors. Kept short so the desktop nav never wraps to a second
 *  line. `labelKey` looks up the translated label in `marketing.nav`. */
export const NAV_LINKS: readonly NavLink[] = [
  { href: '#outcomes', labelKey: 'linkOutcomes' },
  { href: '#how', labelKey: 'linkHow' },
  { href: '#safeguards', labelKey: 'linkSafeguards' },
]

/** Single motion curve for the whole page. No linear, no ease-in-out. */
export const LANDING_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]

/**
 * Duration of the `Reveal` entrance transition, in ms. Exported so anything
 * that draws over already-revealed content (e.g. `Highlighter`) can wait for
 * the transform to settle before taking its position snapshot.
 */
export const REVEAL_DURATION_MS = 750

/** Marker stroke color for `Highlighter` on the landing page — the page is
 *  deliberately monochrome (see hero), so annotations use translucent white
 *  rather than a new hue. */
export const LANDING_HIGHLIGHT_COLOR = 'rgba(255, 255, 255, 0.45)'
```

- [x] **Step 2: `book-meeting-button.tsx` — full conversion**

Replace the full contents of `src/components/landing/book-meeting-button.tsx` with:

```tsx
import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { cn } from '@/lib/utils'
import type { AppLocale } from '@/types/i18n'
import { BOOKING_URL } from './constants'

interface BookMeetingButtonProps {
  readonly locale: AppLocale
  size?: 'md' | 'lg'
  className?: string
}

const SIZE_CLASSES: Record<'md' | 'lg', string> = {
  md: 'py-1.5 pr-1.5 pl-5 text-sm',
  lg: 'py-2 pr-2 pl-7 text-[15px]',
}

const NESTED_SIZE_CLASSES: Record<'md' | 'lg', string> = {
  md: 'size-8',
  lg: 'size-10',
}

/**
 * The page's one conversion control. The label is fixed on purpose: the same
 * words appear in the nav, the hero and the closing band, so a visitor never
 * has to work out that three differently-named buttons do the same thing.
 *
 * Opens the scheduler in a new tab, so a half-read page is never lost.
 */
export async function BookMeetingButton({
  locale,
  size = 'md',
  className,
}: BookMeetingButtonProps): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.bookMeetingButton' })

  return (
    <a
      href={BOOKING_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group inline-flex items-center gap-3 rounded-full font-medium whitespace-nowrap',
        'bg-[var(--l-accent)] text-[var(--l-accent-ink)]',
        'transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
        'hover:-translate-y-px active:scale-[0.98]',
        SIZE_CLASSES[size],
        className,
      )}
    >
      {t('label')}
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-full',
          'bg-[color-mix(in_oklch,var(--l-accent-ink)_16%,transparent)]',
          'transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
          'group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105',
          NESTED_SIZE_CLASSES[size],
        )}
      >
        <ArrowUpRight weight="light" className="size-4" />
      </span>
    </a>
  )
}
```

- [x] **Step 3: `site-nav.tsx` — full conversion, receives resolved `copy`**

Replace the full contents of `src/components/landing/site-nav.tsx` with:

```tsx
'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_EASE } from './constants'

export interface SiteNavLink {
  readonly href: string
  readonly label: string
}

export interface SiteNavCopy {
  readonly ariaLabel: string
  readonly links: readonly SiteNavLink[]
  readonly signIn: string
  readonly openMenu: string
  readonly closeMenu: string
}

interface SiteNavProps {
  readonly copy: SiteNavCopy
  readonly locale: AppLocale
}

/**
 * Floating navigation for the marketing page. Detached glass pill on desktop,
 * full-screen overlay on mobile. Fixed position, so the backdrop blur is
 * composited once instead of repainting a scrolling subtree.
 *
 * Translated strings arrive pre-resolved via `copy` rather than this
 * component calling into next-intl itself: it is the only client component
 * on the marketing page, and resolving server-side keeps next-intl's message
 * catalog (and its client runtime) out of the browser bundle entirely.
 */
export function SiteNav({ copy, locale }: SiteNavProps): React.ReactElement {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const prefersReducedMotion = useReducedMotion()

  const closeMenu = useCallback(() => setIsMenuOpen(false), [])

  // Escape closes the overlay, and the page behind it must not scroll while a
  // full-screen menu is covering it.
  useEffect(() => {
    if (!isMenuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMenuOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isMenuOpen])

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-5">
      <nav
        aria-label={copy.ariaLabel}
        className={cn(
          'flex h-14 w-full max-w-[980px] items-center justify-between gap-6 rounded-full',
          'border border-[var(--l-hairline-strong)] bg-[color-mix(in_oklch,var(--l-bg)_72%,transparent)]',
          'pr-1.5 pl-5 backdrop-blur-2xl',
          'shadow-[inset_0_1px_0_color-mix(in_oklch,white_10%,transparent)]',
        )}
      >
        <Link href="/" className="flex items-center" onClick={closeMenu}>
          <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {copy.links.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="text-[13px] text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden rounded-full px-3 py-2 text-[13px] text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] md:inline-flex"
          >
            {copy.signIn}
          </Link>
          <BookMeetingButton locale={locale} className="hidden md:inline-flex" />

          <button
            type="button"
            aria-expanded={isMenuOpen}
            aria-controls="landing-menu"
            aria-label={isMenuOpen ? copy.closeMenu : copy.openMenu}
            onClick={() => setIsMenuOpen((open) => !open)}
            className="relative grid size-11 place-items-center rounded-full md:hidden"
          >
            <span
              aria-hidden
              className={cn(
                'absolute h-px w-5 bg-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
                isMenuOpen ? 'translate-y-0 rotate-45' : '-translate-y-1',
              )}
            />
            <span
              aria-hidden
              className={cn(
                'absolute h-px w-5 bg-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
                isMenuOpen ? 'translate-y-0 -rotate-45' : 'translate-y-1',
              )}
            />
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {isMenuOpen ? (
          <motion.div
            id="landing-menu"
            key="landing-menu"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.35, ease: LANDING_EASE }}
            className="fixed inset-0 -z-10 flex flex-col justify-end bg-[color-mix(in_oklch,var(--l-bg-deep)_88%,transparent)] px-6 pt-28 pb-14 backdrop-blur-3xl md:hidden"
          >
            <div className="flex flex-col gap-6">
              {copy.links.map(({ href, label }, index) => (
                <motion.a
                  key={href}
                  href={href}
                  onClick={closeMenu}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 26 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.55, delay: 0.06 * index, ease: LANDING_EASE }}
                  className="text-3xl tracking-tight"
                >
                  {label}
                </motion.a>
              ))}
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 26 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.18, ease: LANDING_EASE }}
                className="mt-4 flex flex-col items-start gap-5"
              >
                <BookMeetingButton locale={locale} size="lg" />
                <Link href="/login" onClick={closeMenu} className="text-sm text-[var(--l-muted)]">
                  {copy.signIn}
                </Link>
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  )
}
```

- [x] **Step 4: `site-footer.tsx` — full conversion, adds the language switcher**

Replace the full contents of `src/components/landing/site-footer.tsx` with:

```tsx
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { CookiePreferencesButton } from '@/components/cookie-preferences-button'
import { publicEnv } from '@/lib/env-public'
import { LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'
import type { AppLocale } from '@/types/i18n'
import { BOOKING_URL } from './constants'

const LINK_CLASS =
  'text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]'

/** Language autonyms are never translated — "English" and "Türkçe" read the
 *  same regardless of which language the page is currently showing. */
const LANGUAGE_LABEL: Record<AppLocale, string> = { en: 'English', tr: 'Türkçe' }

interface SiteFooterProps {
  readonly locale: AppLocale
  /** Only the marketing home page (`/`, `/tr`) has a translated counterpart
   *  to switch to — the legal pages (out of scope) never pass this. */
  readonly showLanguageSwitcher?: boolean
}

export async function SiteFooter({
  locale,
  showLanguageSwitcher = false,
}: SiteFooterProps): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.footer' })
  // Read per render, not at module scope: a long-lived server process would
  // otherwise keep printing the year it booted in.
  const year = new Date().getFullYear()

  return (
    <footer className="px-4 pb-12">
      <div className="mx-auto max-w-[1180px] border-t border-[var(--l-hairline)] pt-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center">
            <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
          </div>

          {/* Root-relative anchors, not bare fragments: this footer renders on
              the legal pages too, where `#how` would scroll to nothing. */}
          <nav
            aria-label={t('ariaLabelFooter')}
            className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[13px]"
          >
            <Link href="/#how" className={LINK_CLASS}>
              {t('linkHow')}
            </Link>
            <Link href="/#privacy" className={LINK_CLASS}>
              {t('linkPrivacy')}
            </Link>
            <Link href="/login" className={LINK_CLASS}>
              {t('signIn')}
            </Link>
            <a href={BOOKING_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t('bookMeeting')}
            </a>
            {showLanguageSwitcher && (
              <span className="flex items-center gap-3">
                <a
                  href="/api/locale?locale=en"
                  aria-current={locale === 'en' ? 'true' : undefined}
                  className={locale === 'en' ? 'text-[var(--l-text)]' : LINK_CLASS}
                >
                  {LANGUAGE_LABEL.en}
                </a>
                <a
                  href="/api/locale?locale=tr"
                  aria-current={locale === 'tr' ? 'true' : undefined}
                  className={locale === 'tr' ? 'text-[var(--l-text)]' : LINK_CLASS}
                >
                  {LANGUAGE_LABEL.tr}
                </a>
              </span>
            )}
          </nav>
        </div>

        <nav
          aria-label={t('ariaLabelLegal')}
          className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[var(--l-hairline)] pt-8 text-[12px]"
        >
          {LEGAL_DOCUMENTS.map((document) => (
            <Link key={document.slug} href={legalDocumentPath(document.slug)} className={LINK_CLASS}>
              {document.title}
            </Link>
          ))}
          {publicEnv.NEXT_PUBLIC_GTM_ID !== undefined && (
            <CookiePreferencesButton className={LINK_CLASS} />
          )}
        </nav>

        <p className="mt-8 text-[12px] text-[var(--l-faint)]">{t('copyright', { year })}</p>
      </div>
    </footer>
  )
}
```

Note: `getTranslations({ locale, namespace })` resolves independently of any ambient request context, so this needs no `NextIntlClientProvider` — the two legal-page call sites (Step 8) just pass `locale="en"` and nothing else changes there.

- [x] **Step 5: `landing-page.tsx` — the shared composition (new file)**

Create `src/components/landing/landing-page.tsx`:

```tsx
import { getTranslations } from 'next-intl/server'
import { JsonLd } from '@/components/seo/json-ld'
import { buildLandingJsonLd, type FaqEntry } from '@/lib/seo/json-ld'
import { CONTENT_PUBLISHED_AT, CONTENT_UPDATED_AT, SITE_SUMMARY, SITE_SUMMARY_TR } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'
import type { AppLocale } from '@/types/i18n'
import { Capabilities } from './capabilities'
import { ClosingCta } from './closing-cta'
import { NAV_LINKS } from './constants'
import { Faq } from './faq'
import { Hero } from './hero'
import { HowItWorks } from './how-it-works'
import { Outcomes } from './outcomes'
import { Privacy } from './privacy'
import { Safeguards } from './safeguards'
import { SiteFooter } from './site-footer'
import { SiteNav, type SiteNavCopy } from './site-nav'
import { TheGrind } from './the-grind'
import { MarketingWebMcpTools } from './webmcp-tools'

const PAGE_PATH_BY_LOCALE: Record<AppLocale, string> = { en: '/', tr: '/tr' }
const SUMMARY_BY_LOCALE: Record<AppLocale, string> = { en: SITE_SUMMARY, tr: SITE_SUMMARY_TR }

async function buildSiteNavCopy(locale: AppLocale): Promise<SiteNavCopy> {
  const t = await getTranslations({ locale, namespace: 'marketing.nav' })
  return {
    ariaLabel: t('ariaLabel'),
    signIn: t('signIn'),
    openMenu: t('openMenu'),
    closeMenu: t('closeMenu'),
    links: NAV_LINKS.map(({ href, labelKey }) => ({ href, label: t(labelKey) })),
  }
}

/**
 * The full marketing page composition, shared by `/` and `/tr`
 * (`src/app/(marketing)/page.tsx` and `.../tr/page.tsx`). Every section
 * resolves its own copy server-side from `locale` — see the landing i18n
 * design doc for why there is no `NextIntlClientProvider` anywhere here.
 */
export async function LandingPage({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const [navCopy, faqT] = await Promise.all([
    buildSiteNavCopy(locale),
    getTranslations({ locale, namespace: 'marketing.faq' }),
  ])

  const jsonLd = buildLandingJsonLd({
    siteUrl: SITE_URL,
    pagePath: PAGE_PATH_BY_LOCALE[locale],
    locale,
    summary: SUMMARY_BY_LOCALE[locale],
    faqItems: faqT.raw('items') as readonly FaqEntry[],
    publishedAt: CONTENT_PUBLISHED_AT,
    updatedAt: CONTENT_UPDATED_AT,
  })

  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)] text-[var(--l-text)] antialiased">
      <JsonLd data={jsonLd} />
      <MarketingWebMcpTools />
      <SiteNav copy={navCopy} locale={locale} />
      <main>
        <Hero locale={locale} />
        <Outcomes locale={locale} />
        <TheGrind locale={locale} />
        <HowItWorks locale={locale} />
        <Capabilities locale={locale} />
        <Safeguards locale={locale} />
        <Privacy locale={locale} />
        <Faq locale={locale} />
        <ClosingCta locale={locale} />
      </main>
      <SiteFooter locale={locale} showLanguageSwitcher />
    </div>
  )
}
```

- [x] **Step 6: Trim `page.tsx` down to metadata + the guard + `<LandingPage>`**

Replace the full contents of `src/app/(marketing)/page.tsx` with:

```tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LandingPage } from '@/components/landing/landing-page'
import { createServerClient } from '@/lib/supabase/server'
import {
  LANDING_DESCRIPTION,
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_NAME,
  SITE_TITLE,
} from '@/lib/seo/site'

/** Resolved against `metadataBase` in the root layout. */
const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: OG_IMAGE_ALT,
} as const

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: { canonical: '/', languages: { en: '/', tr: '/tr' } },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    title: `${SITE_NAME} · ${SITE_TITLE}`,
    description: LANDING_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} · ${SITE_TITLE}`,
    description: LANDING_DESCRIPTION,
    images: [OG_IMAGE],
  },
}

/**
 * Public marketing page. A signed-in operator has no use for it, so they are
 * sent straight to the board they actually work in — the same reasoning that
 * made `/` redirect to `/crm` before this page existed.
 */
export default async function MarketingPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (data.user) redirect('/crm')

  return <LandingPage locale="en" />
}
```

- [x] **Step 7: Create the Turkish route**

Create `src/app/(marketing)/tr/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LandingPage } from '@/components/landing/landing-page'
import { createServerClient } from '@/lib/supabase/server'
import {
  LANDING_DESCRIPTION_TR,
  LANDING_TITLE_TR,
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_NAME,
} from '@/lib/seo/site'

const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: OG_IMAGE_ALT,
} as const

export const metadata: Metadata = {
  title: LANDING_TITLE_TR,
  description: LANDING_DESCRIPTION_TR,
  alternates: { canonical: '/tr', languages: { en: '/', tr: '/tr' } },
  openGraph: {
    type: 'website',
    url: '/tr',
    siteName: SITE_NAME,
    title: `${SITE_NAME} · ${LANDING_TITLE_TR}`,
    description: LANDING_DESCRIPTION_TR,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} · ${LANDING_TITLE_TR}`,
    description: LANDING_DESCRIPTION_TR,
    images: [OG_IMAGE],
  },
}

/**
 * Turkish mirror of `/` — see `src/app/(marketing)/page.tsx` for the shared
 * composition and the landing i18n design doc for why this is a second
 * static route rather than a `[locale]` dynamic segment.
 */
export default async function MarketingPageTurkish(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (data.user) redirect('/crm')

  return <LandingPage locale="tr" />
}
```

- [x] **Step 8: Legal pages pass `locale="en"` to the footer — everything else unchanged**

In `src/app/(marketing)/legal/page.tsx`, change:

```tsx
      <SiteFooter />
```

to:

```tsx
      <SiteFooter locale="en" />
```

In `src/app/(marketing)/legal/[slug]/page.tsx`, change:

```tsx
      <SiteFooter />
```

to:

```tsx
      <SiteFooter locale="en" />
```

No other change to either file — no switcher, no other props, byte-identical rendered output to today (per the Global Constraints).

- [x] **Step 9: Mechanical `locale` plumbing in the 9 body-section components**

For each of the following 9 files, make exactly three changes: (a) add `import type { AppLocale } from '@/types/i18n'` to the imports, in the correct alphabetical position among the other `@/...` absolute imports; (b) change the exported function's signature to accept `{ locale }: { locale: AppLocale }`; (c) add `locale={locale}` to the file's own `<BookMeetingButton>` call. Nothing else in these files changes yet — their JSX body text stays hardcoded English until Tasks 8–13.

`src/components/landing/hero.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function Hero(): React.ReactElement {` to `export function Hero({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` (inside the `Reveal delay={0.18}` block) to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/outcomes.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function Outcomes(): React.ReactElement {` to `export function Outcomes({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` (inside the revenue-example panel) to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/the-grind.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function TheGrind(): React.ReactElement {` to `export function TheGrind({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/how-it-works.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function HowItWorks(): React.ReactElement {` to `export function HowItWorks({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/capabilities.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function Capabilities(): React.ReactElement {` to `export function Capabilities({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/safeguards.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function Safeguards(): React.ReactElement {` to `export function Safeguards({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/privacy.tsx`:
- Import block: after `import { BookMeetingButton } from './book-meeting-button'`, add (on its own line, before it, since this file has no other `@/...` import to sort against besides the relative ones) `import type { AppLocale } from '@/types/i18n'` right after the `phosphor-icons` import.
- Change `export function Privacy(): React.ReactElement {` to `export function Privacy({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/faq.tsx`:
- Import block: after `import { Plus } from '@phosphor-icons/react/dist/ssr'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function Faq(): React.ReactElement {` to `export function Faq({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

`src/components/landing/closing-cta.tsx`:
- Import block: after `import { Highlighter } from '@/components/ui/highlighter'`, add `import type { AppLocale } from '@/types/i18n'`.
- Change `export function ClosingCta(): React.ReactElement {` to `export function ClosingCta({ locale }: { locale: AppLocale }): React.ReactElement {`.
- Change `<BookMeetingButton size="lg" />` to `<BookMeetingButton locale={locale} size="lg" />`.

- [x] **Step 10: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: all clean. The build step matters here specifically — it is the only step in this task that renders `generateStaticParams`-free dynamic routes like `/tr` and would catch a missed prop or a bad import that `typecheck`/`lint` alone might not.

- [x] **Step 11: Manual browser check**

Run: `pnpm dev`, then in a browser:
- Visit `/` — page renders exactly as before (English, unchanged), footer now shows an "English · Türkçe" switcher.
- Visit `/tr` — page renders, nav/footer/every "Book a meeting" button now read Turkish ("Görüşme planlayın", "Giriş yap", etc.), but the body sections (headline, outcomes, FAQ, …) are still in English — expected at this point, Tasks 8–13 convert them.
- Click "Türkçe" in the footer on `/` — redirects to `/tr`. Click "English" on `/tr` — redirects to `/`, and reloading `/` again stays English (the cookie override is sticking, not bouncing back via geo detection in local dev anyway since there is no `x-vercel-ip-country` header locally).
- Visit `/legal` and `/legal/privacy-policy` — footer renders exactly as before, English, no switcher.

- [x] **Step 12: Commit**

```bash
git add src/components/landing src/app/\(marketing\)
git commit -m "feat(i18n): stand up /tr route with translated nav, footer, and CTA button

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: Hero + OutcomePanel — full content conversion

**Files:**
- Modify: `src/components/landing/hero.tsx`
- Modify: `src/components/landing/outcome-panel.tsx`

**Interfaces:**
- Consumes: `marketing.hero`, `marketing.outcomePanel` messages (Task 5).
- Produces: `OutcomePanelCopy`, `BookedMeeting` types (exported from `outcome-panel.tsx`), consumed by `hero.tsx`'s `buildOutcomePanelCopy`.

- [x] **Step 1: Rewrite `outcome-panel.tsx` to take resolved `copy` instead of hardcoded English + a module constant**

Replace the full contents of `src/components/landing/outcome-panel.tsx` with:

```tsx
'use client'

import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { initialsFor } from '@/lib/format'
import { LANDING_EASE } from './constants'

export interface BookedMeeting {
  readonly company: string
  readonly kind: string
  readonly when: string
}

export interface OutcomePanelCopy {
  readonly thisMonth: string
  readonly live: string
  readonly exampleFigures: string
  readonly meetingsBookedLine1: string
  readonly meetingsBookedLine2: string
  readonly new: string
  readonly footerNote: string
  readonly meetingPool: readonly BookedMeeting[]
}

const VISIBLE_ROWS = 3
const MEETINGS_BOOKED_BASE = 68
const ROLL_INTERVAL_MS = 4500
/** How long a freshly-arrived row stays highlighted before it settles in. */
const HIGHLIGHT_DURATION_S = 1.4

/**
 * Reads `pool` at a wrapped index. `index` here is always produced by a
 * modulo against `pool.length`, so it is always in range — the throw only
 * fires if that invariant is ever broken by a future edit.
 */
function poolAt(pool: readonly BookedMeeting[], index: number): BookedMeeting {
  const wrapped = ((index % pool.length) + pool.length) % pool.length
  const meeting = pool[wrapped]
  if (!meeting) throw new Error(`meetingPool invariant violated: no entry at index ${wrapped}`)
  return meeting
}

interface RollingMeetingsState {
  readonly visible: readonly BookedMeeting[]
  readonly newestCompany: string
  readonly meetingsBooked: number
  readonly isLive: boolean
}

/**
 * Advances a cursor through `pool` on an interval, exposing the three most
 * recently "arrived" meetings and a monthly count that climbs through
 * `pool.length - VISIBLE_ROWS` ticks and then holds — the visual roll keeps
 * looping so the panel stays alive, but the headline number never runs away.
 *
 * Under `prefers-reduced-motion` the interval never starts: the panel renders
 * the same static first three rows and base count it always has, matching
 * `Reveal`'s reduced-motion contract elsewhere on this page.
 */
function useRollingMeetings(pool: readonly BookedMeeting[]): RollingMeetingsState {
  const prefersReducedMotion = useReducedMotion()
  const [cursor, setCursor] = useState(VISIBLE_ROWS - 1)
  const [tick, setTick] = useState(0)
  const rollIncrements = pool.length - VISIBLE_ROWS

  useEffect(() => {
    if (prefersReducedMotion) return

    const id = setInterval(() => {
      setCursor((current) => (current + 1) % pool.length)
      setTick((current) => current + 1)
    }, ROLL_INTERVAL_MS)

    return () => clearInterval(id)
  }, [prefersReducedMotion, pool.length])

  const visible = Array.from({ length: VISIBLE_ROWS }, (_, offset) =>
    poolAt(pool, cursor - (VISIBLE_ROWS - 1 - offset)),
  )

  return {
    visible,
    newestCompany: poolAt(pool, cursor).company,
    meetingsBooked: MEETINGS_BOOKED_BASE + Math.min(tick, rollIncrements),
    isLive: !prefersReducedMotion,
  }
}

/** Pulsing dot + label. Monochrome, matching this page's zero-chroma palette. */
function LiveBadge({ label, isLive }: { label: string; isLive: boolean }): React.ReactElement {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklch,white_7%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--l-muted)]">
      <span className="relative flex size-1.5">
        {isLive && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--l-accent)] opacity-75" />
        )}
        <span className="relative inline-flex size-1.5 rounded-full bg-[var(--l-accent)]" />
      </span>
      {label}
    </span>
  )
}

/**
 * The hero's visual. It shows the one number the product is bought for, and
 * the three nearest meetings behind it, rather than a pipeline of statuses:
 * a visitor should be able to tell what they get without reading a legend.
 * The list rolls new illustrative meetings in on a timer so the panel reads
 * as an active pipeline, not a screenshot.
 */
export function OutcomePanel({ copy }: { copy: OutcomePanelCopy }): React.ReactElement {
  const { visible, newestCompany, meetingsBooked, isLive } = useRollingMeetings(copy.meetingPool)

  return (
    <div className="rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] p-1.5">
      <div className="overflow-hidden rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] shadow-[inset_0_1px_0_color-mix(in_oklch,white_8%,transparent)]">
        <div className="flex items-center justify-between border-b border-[var(--l-hairline)] px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">{copy.thisMonth}</span>
            <LiveBadge label={copy.live} isLive={isLive} />
          </div>
          <span className="rounded-full bg-[color-mix(in_oklch,white_7%,transparent)] px-2.5 py-1 font-mono text-[10px] text-[var(--l-faint)]">
            {copy.exampleFigures}
          </span>
        </div>

        <div className="flex items-end gap-4 px-5 pt-6 pb-6">
          <p className="relative h-[3rem] overflow-hidden font-mono text-[3.5rem] leading-[0.85] tracking-tighter tabular-nums">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span
                key={meetingsBooked}
                className="block"
                initial={{ y: 14, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -14, opacity: 0 }}
                transition={{ duration: 0.4, ease: LANDING_EASE }}
              >
                {meetingsBooked}
              </motion.span>
            </AnimatePresence>
          </p>
          <p className="pb-1 text-[15px] leading-snug text-[var(--l-muted)]">
            {copy.meetingsBookedLine1}
            <br />
            {copy.meetingsBookedLine2}
          </p>
        </div>

        <ul className="divide-y divide-[var(--l-hairline)] border-t border-[var(--l-hairline)]">
          <AnimatePresence mode="popLayout" initial={false}>
            {visible.map(({ company, kind, when }) => {
              const isNewest = company === newestCompany && isLive

              return (
                <motion.li
                  key={company}
                  layout
                  initial={{ opacity: 0, y: -18 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 18 }}
                  transition={{ duration: 0.55, ease: LANDING_EASE }}
                  className="relative flex items-center gap-3 px-5 py-3.5"
                >
                  {isNewest && (
                    <motion.span
                      aria-hidden
                      className="pointer-events-none absolute inset-0 bg-[var(--l-accent-soft)]"
                      initial={{ opacity: 1 }}
                      animate={{ opacity: 0 }}
                      transition={{ duration: HIGHLIGHT_DURATION_S, ease: 'easeOut' }}
                    />
                  )}
                  <span
                    aria-hidden
                    className="grid size-7 shrink-0 place-items-center rounded-md bg-[color-mix(in_oklch,white_8%,transparent)] text-[10px] font-semibold tracking-tight text-[var(--l-muted)]"
                  >
                    {initialsFor(company)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                      <span className="truncate">{company}</span>
                      {isNewest && (
                        <motion.span
                          initial={{ opacity: 1 }}
                          animate={{ opacity: 0 }}
                          transition={{ duration: HIGHLIGHT_DURATION_S, ease: 'easeOut' }}
                          className="shrink-0 rounded-full bg-[var(--l-accent)] px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wide text-[var(--l-accent-ink)] uppercase"
                        >
                          {copy.new}
                        </motion.span>
                      )}
                    </p>
                    <p className="text-[11px] text-[var(--l-faint)]">{kind}</p>
                  </div>
                  <span className="font-mono text-[11px] text-[var(--l-muted)] tabular-nums">
                    {when}
                  </span>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>

        <div className="border-t border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] px-5 py-3">
          <span className="text-[11px] text-[var(--l-muted)]">{copy.footerNote}</span>
        </div>
      </div>
    </div>
  )
}
```

- [x] **Step 2: Rewrite `hero.tsx` to resolve both `marketing.hero` and `marketing.outcomePanel`**

Replace the full contents of `src/components/landing/hero.tsx` with:

```tsx
import { ArrowDown } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { OutcomePanel, type BookedMeeting, type OutcomePanelCopy } from './outcome-panel'
import { Reveal } from './reveal'

/** Reveal on this block has a 0.06s stagger delay — wait for that plus the
 *  reveal transition itself before the highlighter snapshots its position. */
const HEADLINE_HIGHLIGHT_DELAY_MS = REVEAL_DURATION_MS + 60

async function buildOutcomePanelCopy(locale: AppLocale): Promise<OutcomePanelCopy> {
  const t = await getTranslations({ locale, namespace: 'marketing.outcomePanel' })
  return {
    thisMonth: t('thisMonth'),
    live: t('live'),
    exampleFigures: t('exampleFigures'),
    meetingsBookedLine1: t('meetingsBookedLine1'),
    meetingsBookedLine2: t('meetingsBookedLine2'),
    new: t('new'),
    footerNote: t('footerNote'),
    // `t.raw()` returns the JSON message value with no static typing — safe
    // here because `messages.test.ts` enforces every leaf under
    // `marketing.outcomePanel.meetingPool` is a non-empty string, and this
    // shape is fixed by us, not external input.
    meetingPool: t.raw('meetingPool') as readonly BookedMeeting[],
  }
}

/**
 * Asymmetric split hero: the promise on the left, the morning it produces on
 * the right. Four text elements only (eyebrow, headline, subtext, actions) so
 * the whole thing clears the fold on a laptop.
 */
export async function Hero({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const [t, outcomePanelCopy] = await Promise.all([
    getTranslations({ locale, namespace: 'marketing.hero' }),
    buildOutcomePanelCopy(locale),
  ])

  return (
    <section className="relative isolate overflow-hidden px-4 pt-24 pb-20 md:flex md:min-h-[100dvh] md:items-center md:pb-28">
      {/* Ambient wash. One static gradient, no blur filter, so it costs one
          paint. Monochrome, so it lifts the panel off the page without
          introducing a hue the rest of the composition does not use. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(65%_55%_at_74%_14%,color-mix(in_oklch,white_9%,transparent),transparent_68%)]"
      />

      <div className="mx-auto grid w-full max-w-[1180px] items-center gap-14 lg:grid-cols-12 lg:gap-10">
        <div className="lg:col-span-6 xl:col-span-6">
          <Reveal>
            <span className="inline-flex rounded-full border border-[var(--l-hairline-strong)] px-3 py-1 text-[10px] font-medium tracking-[0.2em] text-[var(--l-muted)] uppercase">
              {t('eyebrow')}
            </span>
          </Reveal>

          <Reveal delay={0.06}>
            <h1 className="mt-7 text-[2.75rem] leading-[1.02] font-medium tracking-tighter text-balance sm:text-6xl lg:text-[4.25rem]">
              {t('headlinePrefix')}
              <Highlighter
                action="underline"
                color={LANDING_HIGHLIGHT_COLOR}
                strokeWidth={3}
                padding={4}
                startDelay={HEADLINE_HIGHLIGHT_DELAY_MS}
              >
                {t('headlineHighlight')}
              </Highlighter>
              {t('headlineSuffix')}
            </h1>
          </Reveal>

          <Reveal delay={0.12}>
            <p className="mt-6 max-w-[50ch] text-[15px] leading-relaxed text-[var(--l-muted)] sm:text-base">
              {t('subtext')}
            </p>
          </Reveal>

          <Reveal delay={0.18}>
            <div className="mt-9 flex flex-wrap items-center gap-4">
              <BookMeetingButton locale={locale} size="lg" />
              <a
                href="#how"
                className="group inline-flex items-center gap-2 rounded-full border border-[var(--l-hairline-strong)] py-2.5 pr-5 pl-5 text-[15px] text-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
              >
                {t('secondaryCta')}
                <ArrowDown
                  weight="light"
                  aria-hidden
                  className="size-4 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover:translate-y-0.5"
                />
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={0.24} className="lg:col-span-6 xl:col-start-7">
          <OutcomePanel copy={outcomePanelCopy} />
        </Reveal>
      </div>
    </section>
  )
}
```

- [x] **Step 3: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [x] **Step 4: Manual check**

`pnpm dev`, visit `/tr` — hero eyebrow, headline, subtext, secondary CTA, and the outcome panel (badges, "Bu ay"/"Canlı"/"Örnek rakamlar", meeting kinds, day abbreviations) are now all Turkish; the roll timer still advances every 4.5s. Visit `/` — identical to before this task started.

- [x] **Step 5: Commit**

```bash
git add src/components/landing/hero.tsx src/components/landing/outcome-panel.tsx
git commit -m "feat(i18n): translate hero and outcome panel

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: Outcomes + TheGrind — full content conversion

**Files:**
- Modify: `src/components/landing/outcomes.tsx`
- Modify: `src/components/landing/the-grind.tsx`

**Interfaces:**
- Consumes: `marketing.outcomes`, `marketing.theGrind` messages (Task 5).

- [x] **Step 1: Rewrite `outcomes.tsx`**

Replace the full contents of `src/components/landing/outcomes.tsx` with:

```tsx
import type { Icon } from '@phosphor-icons/react'
import {
  CalendarCheck,
  ChatCircle,
  MagnifyingGlass,
  PaperPlaneTilt,
} from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

/** These headlines sit in `Reveal` blocks with no extra stagger delay — wait
 *  out the reveal transition before the highlighter snapshots its position. */
const HEADLINE_HIGHLIGHT_DELAY_MS = REVEAL_DURATION_MS

/** Fixed render order matching `marketing.outcomes.items` in the messages. */
const OUTCOME_GLYPHS: readonly Icon[] = [MagnifyingGlass, PaperPlaneTilt, ChatCircle, CalendarCheck]

interface OutcomeItem {
  readonly value: string
  readonly label: string
  readonly detail: string
}

/**
 * The four things that get counted, in the order they happen. Figures are one
 * illustrative month and are labelled as such in the section body: nothing here
 * is a result we are promising, and no client's real numbers appear in public.
 */
export async function Outcomes({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.outcomes' })
  // Safe per the same reasoning as `hero.tsx`'s `t.raw()` call — see there.
  const items = t.raw('items') as readonly OutcomeItem[]

  return (
    <section id="outcomes" className="scroll-mt-28 px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[20ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('headlinePrefix')}
            <Highlighter
              action="circle"
              color={LANDING_HIGHLIGHT_COLOR}
              strokeWidth={2}
              padding={6}
              startDelay={HEADLINE_HIGHLIGHT_DELAY_MS}
            >
              {t('headlineHighlight')}
            </Highlighter>
          </h2>
          <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
            {t('description')}
          </p>
        </Reveal>

        <div className="mt-14 grid gap-x-8 gap-y-12 border-t border-[var(--l-hairline-strong)] pt-12 sm:grid-cols-2 lg:grid-cols-4">
          {items.map(({ value, label, detail }, index) => {
            const Glyph = OUTCOME_GLYPHS[index]
            if (!Glyph) {
              throw new Error(`marketing.outcomes.items invariant violated: no glyph at index ${index}`)
            }
            return (
              <Reveal key={label} delay={index * 0.05}>
                <Glyph weight="light" aria-hidden className="size-6 text-[var(--l-faint)]" />
                <p className="mt-6 font-mono text-[2.75rem] leading-none tracking-tighter tabular-nums sm:text-[3.25rem]">
                  {value}
                </p>
                <p className="mt-4 text-lg font-medium tracking-tight">{label}</p>
                <p className="mt-2 max-w-[30ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                  {detail}
                </p>
              </Reveal>
            )
          })}
        </div>

        <Reveal delay={0.2}>
          <div className="mt-16 rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] p-1.5">
            <div className="rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] px-6 py-8 sm:px-10 sm:py-10">
              <p className="text-lg font-medium tracking-tight">
                {t('revenueFifthPrefix')}
                <Highlighter
                  action="highlight"
                  color={LANDING_HIGHLIGHT_COLOR}
                  padding={2}
                  startDelay={REVEAL_DURATION_MS + 200}
                >
                  {t('revenueFifthHighlight')}
                </Highlighter>
                {t('revenueFifthSuffix')}
              </p>
              <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('revenueBody', {
                  meetings: t('revenueMeetings'),
                  averageDeal: t('revenueAverageDeal'),
                  closeRate: t('revenueCloseRate'),
                  newBusiness: t('revenueNewBusiness'),
                })}
              </p>
              <div className="mt-8">
                <BookMeetingButton locale={locale} size="lg" />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
```

- [x] **Step 2: Rewrite `the-grind.tsx`**

Replace the full contents of `src/components/landing/the-grind.tsx` with:

```tsx
import { X } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

export async function TheGrind({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.theGrind' })
  const costs = t.raw('costs') as readonly string[]

  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto max-w-[1180px]">
        <Reveal>
          <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('headlinePrefix')}
            <Highlighter
              action="underline"
              color={LANDING_HIGHLIGHT_COLOR}
              strokeWidth={3}
              padding={4}
              startDelay={REVEAL_DURATION_MS}
            >
              {t('headlineHighlight')}
            </Highlighter>
            {t('headlineSuffix')}
          </h2>
        </Reveal>

        <ul className="mt-14 grid gap-x-10 gap-y-8 md:grid-cols-2">
          {costs.map((cost, index) => (
            <li key={cost}>
              <Reveal delay={index * 0.05}>
                <div className="flex gap-4 border-t border-[var(--l-hairline)] pt-6">
                  {/* Marks the item as a cost, not decoration: every line in this
                      list is something the product removes. */}
                  <X
                    weight="light"
                    aria-hidden
                    className="mt-1 size-[18px] shrink-0 text-[var(--l-faint)]"
                  />
                  <p className="text-lg leading-snug text-[var(--l-muted)]">{cost}</p>
                </div>
              </Reveal>
            </li>
          ))}
        </ul>

        <Reveal delay={0.24}>
          <p className="mt-14 text-lg leading-snug text-[var(--l-text)] sm:text-xl">
            {t('closingLine')}
          </p>
          <div className="mt-8">
            <BookMeetingButton locale={locale} size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
```

- [x] **Step 3: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [x] **Step 4: Manual check**

`pnpm dev`, visit `/tr` — the four-number grid, the revenue worked example, and "the grind" cost list are now Turkish. `/` unchanged.

- [x] **Step 5: Commit**

```bash
git add src/components/landing/outcomes.tsx src/components/landing/the-grind.tsx
git commit -m "feat(i18n): translate outcomes and the-grind sections

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: HowItWorks + Capabilities — full content conversion

**Files:**
- Modify: `src/components/landing/how-it-works.tsx`
- Modify: `src/components/landing/capabilities.tsx`

**Interfaces:**
- Consumes: `marketing.howItWorks`, `marketing.capabilities` messages (Task 5); `InlineLink` (existing, unchanged).

- [x] **Step 1: Rewrite `how-it-works.tsx`**

Replace the full contents of `src/components/landing/how-it-works.tsx` with:

```tsx
import type { Icon } from '@phosphor-icons/react'
import { CalendarCheck, ChatsCircle, Crosshair, PenNib } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

/** Fixed render order matching `marketing.howItWorks.movements` in the messages. */
const MOVEMENT_GLYPHS: readonly Icon[] = [ChatsCircle, Crosshair, PenNib, CalendarCheck]

interface Movement {
  readonly title: string
  readonly detail: string
}

export async function HowItWorks({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.howItWorks' })
  const movements = t.raw('movements') as readonly Movement[]

  return (
    <section id="how" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto grid max-w-[1180px] gap-14 lg:grid-cols-12 lg:gap-16">
        <div className="lg:col-span-4">
          <div className="lg:sticky lg:top-32">
            <Reveal>
              <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
                {t('headlinePrefix')}
                <Highlighter
                  action="circle"
                  color={LANDING_HIGHLIGHT_COLOR}
                  strokeWidth={2}
                  padding={5}
                  startDelay={REVEAL_DURATION_MS}
                >
                  {t('headlineHighlight')}
                </Highlighter>
                {t('headlineSuffix')}
              </h2>
              <p className="mt-5 max-w-[38ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t.rich('description', {
                  link: (chunks) => <InlineLink href="#outcomes">{chunks}</InlineLink>,
                })}
              </p>
            </Reveal>
          </div>
        </div>

        <div className="lg:col-span-7 lg:col-start-6">
          <ol className="border-l border-[var(--l-hairline)] pl-8 lg:pl-12">
            {movements.map(({ title, detail }, index) => {
              const Glyph = MOVEMENT_GLYPHS[index]
              if (!Glyph) {
                throw new Error(`marketing.howItWorks.movements invariant violated: no glyph at index ${index}`)
              }
              return (
                <li key={title} className="relative pb-14 last:pb-0">
                  <Reveal delay={index * 0.05}>
                    {/* From `lg` the tile straddles the rule: half its width plus
                        the 1px rule itself, pulled back out of the list's padding.
                        Below that the container is too narrow to hang anything
                        outside it, so the tile sits in flow above the heading
                        instead of being clipped by the page gutter. */}
                    <span
                      aria-hidden
                      className="mb-5 grid size-10 place-items-center rounded-full border border-[var(--l-hairline-strong)] bg-[var(--l-bg)] text-[var(--l-muted)] lg:absolute lg:-left-[calc(3rem+1.25rem+0.5px)] lg:mb-0"
                    >
                      <Glyph weight="light" className="size-5" />
                    </span>
                    <h3 className="max-w-[20ch] text-2xl font-medium tracking-tight sm:text-3xl">
                      {title}
                    </h3>
                    <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                      {detail}
                    </p>
                  </Reveal>
                </li>
              )
            })}
          </ol>

          <Reveal delay={0.2}>
            <div className="mt-14 pl-8 lg:pl-12">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
```

- [x] **Step 2: Rewrite `capabilities.tsx`**

Replace the full contents of `src/components/landing/capabilities.tsx` with:

```tsx
import { Clock, Eye, Newspaper, User } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import { cn } from '@/lib/utils'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { Reveal } from './reveal'

interface TileProps {
  className?: string
  children: React.ReactNode
  /** Adds the accent wash. Reserved for the one tile that leads the grid. */
  isFeature?: boolean
}

/**
 * Nested enclosure shared by every tile: an outer tray with a hairline, and an
 * inner core with its own top highlight. Radii are concentric by calculation,
 * not by eye.
 */
function Tile({ className, children, isFeature = false }: TileProps): React.ReactElement {
  return (
    <div
      className={cn(
        'rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_3%,transparent)] p-1.5',
        className,
      )}
    >
      <div
        className={cn(
          'h-full rounded-[22px] border border-[var(--l-hairline)] p-7 sm:p-8',
          'shadow-[inset_0_1px_0_color-mix(in_oklch,white_7%,transparent)]',
          isFeature
            ? 'bg-[var(--l-surface)] bg-[radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklch,var(--l-accent)_18%,transparent),transparent_62%)]'
            : 'bg-[var(--l-surface)]',
        )}
      >
        {children}
      </div>
    </div>
  )
}

export async function Capabilities({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.capabilities' })
  const reliefs = t.raw('reliefs') as readonly string[]

  return (
    <section id="capabilities" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px]">
        <Reveal className="max-w-[36ch]">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('heading')}
          </h2>
        </Reveal>

        <div className="mt-14 grid gap-4 lg:grid-cols-12">
          <Reveal className="h-full lg:col-span-7 lg:row-span-2">
            <Tile isFeature className="h-full">
              <Clock weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="max-w-[16ch] text-xl font-medium tracking-tight sm:text-2xl">
                {t('tile1Prefix')}
                <Highlighter
                  action="underline"
                  color={LANDING_HIGHLIGHT_COLOR}
                  strokeWidth={2.5}
                  padding={3}
                  startDelay={REVEAL_DURATION_MS}
                >
                  {t('tile1Highlight')}
                </Highlighter>
                {t('tile1Suffix')}
              </h3>
              <p className="mt-4 max-w-[44ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile1Body')}
              </p>
              <ul className="mt-9 flex flex-wrap gap-2">
                {reliefs.map((relief) => (
                  <li
                    key={relief}
                    className="rounded-full border border-[var(--l-hairline-strong)] px-3.5 py-1.5 text-[12px] text-[var(--l-muted)]"
                  >
                    {relief}
                  </li>
                ))}
              </ul>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-5" delay={0.05}>
            <Tile className="h-full">
              <p className="font-mono text-[3.25rem] leading-none tracking-tighter tabular-nums">
                {t('tile2Number')}
              </p>
              <h3 className="mt-6 text-lg font-medium tracking-tight">{t('tile2Title')}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile2Body')}
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-5" delay={0.1}>
            <Tile className="h-full">
              <Newspaper weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">{t('tile3Title')}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile3Body')}
              </p>
              <p className="mt-6 rounded-[14px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] px-4 py-3.5 text-[13px] leading-relaxed text-[var(--l-muted)]">
                {t('tile3Callout')}
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-4" delay={0.15}>
            <Tile className="h-full">
              <User weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">{t('tile4Title')}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile4Body')}
              </p>
            </Tile>
          </Reveal>

          <Reveal className="h-full lg:col-span-8" delay={0.2}>
            <Tile className="h-full">
              <Eye weight="light" aria-hidden className="mb-6 size-6 text-[var(--l-muted)]" />
              <h3 className="text-lg font-medium tracking-tight">{t('tile5Title')}</h3>
              <p className="mt-3 max-w-[56ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                {t('tile5Body')}
              </p>
            </Tile>
          </Reveal>
        </div>

        <Reveal delay={0.25}>
          <div className="mt-14">
            <BookMeetingButton locale={locale} size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
```

- [x] **Step 3: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [x] **Step 4: Manual check**

`pnpm dev`, visit `/tr` — the four-step "how it works" list (with its inline link to the outcomes section) and the six capability tiles are now Turkish. `/` unchanged.

- [x] **Step 5: Commit**

```bash
git add src/components/landing/how-it-works.tsx src/components/landing/capabilities.tsx
git commit -m "feat(i18n): translate how-it-works and capabilities sections

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 11: Safeguards + Privacy — full content conversion

**Files:**
- Modify: `src/components/landing/safeguards.tsx`
- Modify: `src/components/landing/privacy.tsx`

**Interfaces:**
- Consumes: `marketing.safeguards`, `marketing.privacy` messages (Task 5); `InlineLink` (existing, unchanged).

- [x] **Step 1: Rewrite `safeguards.tsx`**

Replace the full contents of `src/components/landing/safeguards.tsx` with:

```tsx
import type { Icon } from '@phosphor-icons/react'
import { ChartLineUp, Power, ShieldCheck } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

/** Fixed render order matching `marketing.safeguards.promises` in the messages. */
const PROMISE_GLYPHS: readonly Icon[] = [ChartLineUp, ShieldCheck, Power]

interface Reassurance {
  readonly title: string
  readonly detail: string
}

export async function Safeguards({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.safeguards' })
  const promises = t.raw('promises') as readonly Reassurance[]

  return (
    <section id="safeguards" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px] rounded-[28px] border border-[var(--l-hairline)] bg-[var(--l-bg-deep)] p-1.5">
        <div className="rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-bg)] px-6 py-14 sm:px-12 sm:py-16">
          <Reveal>
            <h2 className="max-w-[24ch] text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
              {t('headlinePrefix')}
              <Highlighter
                action="box"
                color={LANDING_HIGHLIGHT_COLOR}
                strokeWidth={2}
                padding={6}
                startDelay={REVEAL_DURATION_MS}
              >
                {t('headlineHighlight')}
              </Highlighter>
              {t('headlineSuffix')}
            </h2>
            <p className="mt-5 max-w-[58ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
              {t.rich('description', {
                link: (chunks) => <InlineLink href="#privacy">{chunks}</InlineLink>,
              })}
            </p>
          </Reveal>

          <ul className="mt-14 grid gap-y-10 sm:grid-cols-3 sm:gap-x-0">
            {promises.map(({ title, detail }, index) => {
              const Glyph = PROMISE_GLYPHS[index]
              if (!Glyph) {
                throw new Error(`marketing.safeguards.promises invariant violated: no glyph at index ${index}`)
              }
              return (
                <li
                  key={title}
                  className="sm:border-l sm:border-[var(--l-hairline)] sm:px-8 sm:first:border-l-0 sm:first:pl-0 sm:last:pr-0"
                >
                  <Reveal delay={index * 0.05}>
                    <Glyph weight="light" aria-hidden className="mb-5 size-6 text-[var(--l-muted)]" />
                    <p className="text-lg font-medium tracking-tight">{title}</p>
                    <p className="mt-3 max-w-[34ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                      {detail}
                    </p>
                  </Reveal>
                </li>
              )
            })}
          </ul>

          <Reveal delay={0.2}>
            <div className="mt-14">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
```

- [x] **Step 2: Rewrite `privacy.tsx`**

Replace the full contents of `src/components/landing/privacy.tsx` with:

```tsx
import type { Icon } from '@phosphor-icons/react'
import { ClockCounterClockwise, LockKey, Plugs, Vault } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

/** Fixed render order matching `marketing.privacy.commitments` in the messages. */
const COMMITMENT_GLYPHS: readonly Icon[] = [LockKey, Plugs, Vault, ClockCounterClockwise]

interface Commitment {
  readonly title: string
  readonly detail: string
}

/**
 * Every claim here is one the product can actually stand behind: AES-256-GCM on
 * mailbox credentials before they are written, row-level security on every
 * table carrying a client id, and the 30/90 day event retention the log sweep
 * enforces. Nothing on this list is a certification we do not hold.
 */
export async function Privacy({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.privacy' })
  const commitments = t.raw('commitments') as readonly Commitment[]

  return (
    <section id="privacy" className="scroll-mt-28 px-4 py-28 md:py-36">
      <div className="mx-auto max-w-[1180px]">
        <Reveal className="max-w-[40ch]">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.6rem]">
            {t('heading')}
          </h2>
          <p className="mt-5 text-[15px] leading-relaxed text-[var(--l-muted)]">
            {t.rich('description', {
              link: (chunks) => <InlineLink href="#safeguards">{chunks}</InlineLink>,
            })}
          </p>
        </Reveal>

        <ul className="mt-14 grid border-t border-[var(--l-hairline)] sm:grid-cols-2">
          {commitments.map(({ title, detail }, index) => {
            const Glyph = COMMITMENT_GLYPHS[index]
            if (!Glyph) {
              throw new Error(`marketing.privacy.commitments invariant violated: no glyph at index ${index}`)
            }
            return (
              <li
                key={title}
                className="border-b border-[var(--l-hairline)] py-9 sm:odd:pr-9 sm:even:border-l sm:even:pl-9"
              >
                <Reveal delay={index * 0.05}>
                  <div className="flex gap-5">
                    <Glyph
                      weight="light"
                      aria-hidden
                      className="mt-0.5 size-6 shrink-0 text-[var(--l-muted)]"
                    />
                    <div>
                      <p className="text-lg font-medium tracking-tight">{title}</p>
                      <p className="mt-3 max-w-[46ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                        {detail}
                      </p>
                    </div>
                  </div>
                </Reveal>
              </li>
            )
          })}
        </ul>

        <Reveal delay={0.2}>
          <div className="mt-14">
            <BookMeetingButton locale={locale} size="lg" />
          </div>
        </Reveal>
      </div>
    </section>
  )
}
```

- [x] **Step 3: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [x] **Step 4: Manual check**

`pnpm dev`, visit `/tr` — the email-reputation safeguards band and the data-handling commitments grid (with their cross-links to each other) are now Turkish. `/` unchanged.

- [x] **Step 5: Commit**

```bash
git add src/components/landing/safeguards.tsx src/components/landing/privacy.tsx
git commit -m "feat(i18n): translate safeguards and privacy sections

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 12: Faq — full content conversion, remove `faq-items.ts`

**Files:**
- Modify: `src/components/landing/faq.tsx`
- Delete: `src/components/landing/faq-items.ts`

**Interfaces:**
- Consumes: `marketing.faq` messages (Task 5). `landing-page.tsx` (Task 7) already reads `marketing.faq.items` independently for JSON-LD — this task only changes the visual accordion, no other file depends on `faq-items.ts`.

- [x] **Step 1: Confirm nothing else imports `faq-items.ts`**

Run: `grep -rn "faq-items" src --include=*.ts --include=*.tsx`
Expected: only `src/components/landing/faq.tsx` (about to be rewritten) and `src/components/landing/faq-items.ts` itself. If anything else appears, stop and re-check — it should not, since `landing-page.tsx` was written in Task 7 to read FAQ items from `getTranslations` directly, not from this file.

- [x] **Step 2: Rewrite `faq.tsx`**

Replace the full contents of `src/components/landing/faq.tsx` with:

```tsx
import { Plus } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

interface FaqItem {
  readonly question: string
  readonly answer: string
}

export async function Faq({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.faq' })
  // Safe per the same reasoning as `hero.tsx`'s `t.raw()` call — see there.
  const items = t.raw('items') as readonly FaqItem[]

  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto grid max-w-[1180px] gap-12 lg:grid-cols-12">
        <Reveal className="lg:col-span-4">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.4rem]">
            {t('heading')}
          </h2>
        </Reveal>

        <div className="lg:col-span-7 lg:col-start-6">
          {items.map(({ question, answer }, index) => (
            <Reveal key={question} delay={index * 0.04}>
              <details className="group border-b border-[var(--l-hairline)] py-6 last:border-b-0">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[17px] font-medium tracking-tight [&::-webkit-details-marker]:hidden">
                  {question}
                  <Plus
                    weight="light"
                    aria-hidden
                    className="mt-1 size-4 shrink-0 text-[var(--l-muted)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-open:rotate-45"
                  />
                </summary>
                <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                  {answer}
                </p>
              </details>
            </Reveal>
          ))}

          <Reveal delay={0.2}>
            <div className="mt-12">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
```

- [x] **Step 3: Delete `faq-items.ts`**

```bash
git rm src/components/landing/faq-items.ts
```

- [x] **Step 4: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean — no dangling import errors for the deleted file.

- [x] **Step 5: Manual check**

`pnpm dev`, visit `/tr` — the FAQ accordion (5 questions) is now Turkish, and the page's `<script type="application/ld+json">` (view source or DevTools) shows the same Turkish text in its `FAQPage.mainEntity` — they were already reading the same message keys since Task 7, so this just confirms the visible accordion now matches. `/` unchanged.

- [x] **Step 6: Commit**

```bash
git add src/components/landing/faq.tsx
git commit -m "feat(i18n): translate FAQ section, remove faq-items.ts

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 13: ClosingCta — full content conversion + final verification

**Files:**
- Modify: `src/components/landing/closing-cta.tsx`
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: `marketing.closingCta` messages (Task 5); `InlineLink` (existing, unchanged).

- [x] **Step 1: Rewrite `closing-cta.tsx`**

Replace the full contents of `src/components/landing/closing-cta.tsx` with:

```tsx
import { getTranslations } from 'next-intl/server'
import { Highlighter } from '@/components/ui/highlighter'
import type { AppLocale } from '@/types/i18n'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_HIGHLIGHT_COLOR, REVEAL_DURATION_MS } from './constants'
import { InlineLink } from './inline-link'
import { Reveal } from './reveal'

export async function ClosingCta({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.closingCta' })

  return (
    <section className="px-4 pt-8 pb-28 md:pb-36">
      <div className="mx-auto max-w-[1180px] rounded-[28px] border border-[var(--l-hairline)] bg-[color-mix(in_oklch,white_4%,transparent)] p-1.5">
        <div className="relative isolate overflow-hidden rounded-[22px] border border-[var(--l-hairline)] bg-[var(--l-surface)] px-6 py-20 text-center sm:px-12 sm:py-24">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(80%_120%_at_50%_100%,color-mix(in_oklch,var(--l-accent)_20%,transparent),transparent_65%)]"
          />
          <Reveal>
            <h2 className="mx-auto max-w-[18ch] text-[2.25rem] leading-[1.05] font-medium tracking-tight text-balance sm:text-[3rem]">
              {t('headlinePrefix')}
              <Highlighter
                action="underline"
                color={LANDING_HIGHLIGHT_COLOR}
                strokeWidth={3}
                padding={4}
                startDelay={REVEAL_DURATION_MS}
              >
                {t('headlineHighlight')}
              </Highlighter>
              {t('headlineSuffix')}
            </h2>
            <p className="mx-auto mt-6 max-w-[46ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
              {t('description')}
            </p>
            <div className="mt-10 flex justify-center">
              <BookMeetingButton locale={locale} size="lg" />
            </div>
            <p className="mt-7 text-[13px] text-[var(--l-faint)]">
              {t.rich('footerNote', {
                link: (chunks) => <InlineLink href="/login">{chunks}</InlineLink>,
              })}
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
```

- [x] **Step 2: Typecheck, lint, build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean.

- [x] **Step 3: Full test suite**

Run: `pnpm test`
Expected: every test file passes, including all the new ones from Tasks 1, 2, 4, and 6, and the untouched pre-existing suite.

- [x] **Step 4: Full manual verification pass**

`pnpm dev`, then in a browser:
- `/` — fully unchanged from before this plan started: English throughout, footer shows the language switcher with "English" active.
- `/tr` — every section (nav, hero, outcome panel, outcomes, the grind, how it works, capabilities, safeguards, privacy, FAQ, closing CTA, footer) is fully in Turkish; footer shows "Türkçe" active.
- Footer switcher round-trip: from `/`, click "Türkçe" → lands on `/tr`. From `/tr`, click "English" → lands on `/`, and refreshing `/` again stays on `/` (no bounce).
- `curl -sI -H 'x-vercel-ip-country: TR' http://localhost:3000/` → redirects to `/tr`.
- `/legal` and any `/legal/[slug]` page — unchanged, English, no switcher in the footer.
- View source on `/tr` — `<title>` and `<meta name="description">` are Turkish, `<link rel="alternate" hreflang="tr" href=".../tr">` and `hreflang="en" href=".../">` are both present, and the JSON-LD `<script>` block's `FAQPage`/`WebPage` text is Turkish.
- `/sitemap.xml` — lists both `/` and `/tr`.

- [x] **Step 5: Update the roadmap**

Append an entry to `.claude/roadmap.md` (following the file's existing entry format — numbered summary of what shipped, files touched, and verification performed) describing: the `/tr` route and geo/Accept-Language/cookie detection in `middleware.ts`; the `marketing` message namespace; the footer language switcher via `/api/locale`; locale-aware JSON-LD, sitemap, and hreflang metadata; and that legal documents were explicitly kept out of scope per the design doc's phasing decision.

- [x] **Step 6: Final commit**

```bash
git add src/components/landing/closing-cta.tsx .claude/roadmap.md
git commit -m "feat(i18n): translate closing CTA, complete landing page Turkish rollout

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---
