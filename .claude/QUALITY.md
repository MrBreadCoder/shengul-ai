# Code Quality

Derived from engineering practices at Google, Stripe, Meta, Netflix, and Amazon.
These are not aspirational — they are the minimum bar for shipping code.

---

## TypeScript Standards

- `strict: true` in tsconfig — no exceptions
- No `any` — use `unknown` and narrow, or define a proper type
- No `!` non-null assertions without a comment proving it is safe
- Use Zod for all runtime validation (API inputs, env vars, webhook payloads, AI outputs)
- Export types from `/types` — never define shared types inline in components
- Prefer `interface` for object shapes, `type` for unions/intersections/aliases
- Use `satisfies` to validate object literals against types without widening
- Use branded types for domain IDs to make the type system enforce correct usage:
  ```ts
  type UserId = string & { __brand: 'UserId' }
  // Now TypeScript rejects passing a ChatId where a UserId is expected
  ```
- Use discriminated unions to model all states explicitly — no boolean soup:
  ```ts
  type SubscriptionState =
    | { status: 'trialing'; trialEndsAt: Date }
    | { status: 'active'; plan: Plan; renewsAt: Date }
    | { status: 'past_due'; since: Date }
    | { status: 'canceled'; canceledAt: Date }
  ```
- Every discriminated union must have an exhaustive `switch` with an `assertNever` default branch

---

## Functions & Logic

- Pure functions wherever possible — side effects isolated, explicit, and documented
- Single responsibility — if a function does two things, split it at the seam
- Early returns over nested conditionals — flatten the happy path at the top
- No magic numbers or strings — use named constants with a `// why` comment if non-obvious
- Async/await always — no `.then()` chains unless chaining is genuinely cleaner
- No function longer than ~40 lines — if it's growing, extract a well-named helper
- No deeply nested callbacks — maximum 2 levels of nesting before refactoring
- Validate all inputs at function entry if the function is called from an external boundary
- Side effects (logging, analytics, DB writes) go at the end — after the core logic succeeds
- Prefer returning data over mutating shared state — mutation is an explicit choice, not a default

---

## Naming Conventions

- Files: `kebab-case.ts` / `kebab-case.tsx`
- Components: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- DB table and column names: `snake_case` (PostgreSQL) — map to `camelCase` in TypeScript
- Types/interfaces: `PascalCase`
- Zod schemas: `camelCaseSchema` (e.g., `userProfileSchema`)
- Boolean variables and props: prefix with `is`, `has`, `can`, `should` — never bare noun (`error` vs `hasError`)
- Event handler props: prefix with `on` (`onSubmit`, `onDelete`) — never bare verb (`submit`, `delete`)
- Server Actions: imperative verb phrase (`createChat`, `deleteMessage`) — reads are queries, not actions
- Avoid abbreviations unless universally understood (`url`, `id`, `api`) — write `subscription` not `sub`

---

## Error Handling

- Every thrown or returned error must carry: `code` (machine-readable string), `message` (human-readable), and `context` (structured object with relevant IDs)
- Distinguish **operational errors** (expected, user-recoverable) from **programming errors** (unexpected, engineer-recoverable):
  - Operational: `CREDITS_EXHAUSTED`, `NOT_FOUND`, `UNAUTHORIZED`, `RATE_LIMITED`, `VALIDATION_ERROR`
  - Programming: null dereference, assertion failure, unexpected DB shape — these get thrown and caught by Sentry
- Never use bare `Error` — always use `AppError` with a typed `code`:
  ```ts
  throw new AppError('CREDITS_EXHAUSTED', 'You have used all your credits this month', { userId, creditsUsed })
  ```
- Client-facing errors must never expose stack traces, DB column names, or internal service names
- Catch external SDK errors (Supabase, Stripe, Mem0, Composio, AI) immediately and rethrow as `AppError`
- Every catch block must either: handle the error, rethrow it, or escalate it to Sentry — never swallow
- Log errors with structured context: `{ code, userId, action, timestamp, details }` — never interpolated strings

---

## Defensive Programming

- Validate configuration and env vars at startup — fail fast if anything required is missing
- Timeout every external call — no unbounded network waits:
  ```ts
  await Promise.race([apiCall(), rejectAfterMs(5000, 'EXTERNAL_TIMEOUT')])
  ```
- Always set explicit token limits on AI calls — never let the model run without a ceiling
- Never assume an external API response has the expected shape — validate with Zod
- Handle the case where an async operation returns `null` or `undefined` — even if the DB schema says it can't
- Write code that fails loudly and explicitly — silent failures are worse than crashes
- Use assertions for invariants that must always be true — `if (!condition) throw new AppError('INVARIANT_VIOLATION', ...)`

---

## Performance

- Use `React.Suspense` + loading states for async Server Components — wrap at the granularity of the slow part
- Memoize with `useMemo` / `useCallback` only when a profiler shows it is necessary — never as a default
- Avoid unnecessary re-renders — always verify dependency arrays, use React DevTools Profiler
- Always use `next/image` with explicit `width`, `height`, and `sizes` props
- Use `next/dynamic` with `ssr: false` for Client Components that are heavy and below the fold
- Never trigger N+1 queries — use joins, batch fetches, or Supabase `select` with relations
- Add database indexes for every column used in a `WHERE` clause that appears in a hot path
- Use cursor-based pagination for chat messages and memory lists — offset pagination breaks under concurrent inserts
- Cache static lookups (plan limits, blocklists) in module scope — re-reading them on every request is wasteful
- Set query timeouts on DB calls that could block under load — a slow query should fail fast, not hang

### Performance Budgets (enforced in CI)
| Metric | Limit |
|---|---|
| Initial JS bundle | < 200KB gzipped |
| LCP (Largest Contentful Paint) | < 2.5s |
| FID / INP (Interaction to Next Paint) | < 200ms |
| CLS (Cumulative Layout Shift) | < 0.1 |
| AI response time to first token | < 800ms |
| Server Action round-trip | < 500ms |
| DB query (hot path) | < 100ms |

---

## Testing

### Structure
- Test file colocated: `feature.test.ts` next to `feature.ts`
- Use Vitest for unit and integration tests
- Use the **Arrange-Act-Assert** pattern — every test block has three clear sections
- Test naming: `it('should [expected behavior] when [condition]')` — not `it('works')`

### What to test
- All utility functions and business logic (100% of pure functions)
- All Zod schemas — happy path, missing fields, extra fields, wrong types
- All Server Actions — auth rejection, validation rejection, success path, external service failure
- All Route Handlers — missing signature, malformed body, success, error
- All error paths — not just the happy path

### Principles
- Each test is independent — no shared mutable state between tests
- Mock at the boundary — mock Supabase, Stripe, Mem0, AI SDK clients; never mock your own business logic
- Never hit real external services in unit tests — integration tests can, but they run in CI with test credentials
- Test the behavior (what the function does), not the implementation (how it does it)
- A test that never fails is not a test — always verify the assertion actually catches a regression
- Zero tolerance for flaky tests — a non-deterministic test must be fixed or deleted immediately

### Test Coverage Targets
| Layer | Minimum |
|---|---|
| Utility functions (`lib/utils/`) | 100% |
| Zod schemas | 100% |
| Server Actions | 90% |
| DB query functions (`lib/db/`) | 80% |
| React components | Critical paths only |
| Auth, billing, memory paths | Integration test required |

---

## Observability

- Every Server Action must log its entry with structured fields: `{ action, userId, timestamp }`
- Every error must be logged with: `{ code, message, userId, action, durationMs, details }`
- Slow operations (> 200ms) must be timed and logged — use a wrapper, not ad-hoc `Date.now()` calls
- AI calls must log token usage after completion: `{ model, promptTokens, completionTokens, durationMs }`
- Never log raw AI request/response bodies — they may contain user message content (PII)
- Use a correlation/request ID on every request that passes through multiple systems — log it at every layer

---

## Code Architecture

- Keep business logic framework-agnostic — Server Actions and Route Handlers are thin adapters, not logic containers
- Data access (Supabase queries) lives exclusively in `src/lib/db/` — never inline queries in components or actions
- One function per DB operation in `lib/db/` — no multi-purpose query functions
- Server Actions validate input → check auth → check limits → call lib functions → return result — that order, no exceptions
- Never pass raw Supabase errors to callers — always map to `AppError` at the DB layer
- Feature-specific logic that grows beyond one file gets its own subdirectory in `lib/` (e.g., `lib/billing/`, `lib/memory/`)

---

## Code Style

- No commented-out code — delete it; git has history
- No `console.log` in any production code path — use a structured logger or nothing
- Imports ordered: external libs → internal absolute (`@/lib/...`) → relative (`./...`)
- Use named exports from all utility and library files — default exports only for Next.js pages/layouts/components
- No barrel files (`index.ts` that re-exports everything) — they slow down TypeScript and obscure origins
- Object spread for overrides rather than mutation: `{ ...defaults, ...overrides }` — never `Object.assign`

---

## Code Review Mindset

When writing code, review it as if a senior engineer at Stripe would reject it for:
1. **Silent failures** — errors swallowed or not surfaced
2. **Missing auth checks** — any path that mutates data without validating the session
3. **Untested error paths** — the catch block was never tested
4. **Implicit assumptions** — code that works only because of an undocumented invariant
5. **Over-abstraction** — more indirection than the problem requires
6. **Under-abstraction** — the same logic copy-pasted in three places
7. **Missing timeout** — an external call with no failure deadline
8. **Type unsafety** — a cast, assertion, or `any` that could hide a bug at runtime
