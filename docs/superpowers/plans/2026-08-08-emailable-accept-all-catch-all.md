# Emailable Accept-All Catch-All Carve-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop permanently discarding leads whose only problem is sitting on a catch-all mail server, without loosening the deliverability guard for genuinely bad addresses.

**Architecture:** One narrow carve-out inside the existing pure decision function `mapEmailableVerdict` (`src/lib/emailable/map-verification.ts`): a `risky` verdict activates instead of parking when, and only when, Emailable's own response says `reason: 'low_deliverability'` **and** `accept_all: true`. Every other `risky` result (in particular `low_quality`), and every `undeliverable`/`unknown`/unrecognized state, keeps parking exactly as today. No other file in the pipeline needs to change — `verifyBatch` in `discover.ts` already classifies a verdict as "deliverable" or "rejected" purely by reading `verdict.leadStatus`, so the new carve-out flows through automatically.

**Tech Stack:** TypeScript, Vitest, Zod (existing `EmailableResult` schema — no schema change needed, `accept_all` and `reason` are already parsed fields).

## Global Constraints

- Do not touch `git branch` — commit directly, per repo convention ("dont branch use main").
- `leads.email_status` for an activated catch-all lead must stay `'risky'`, never get silently upgraded to `'verified'` — the UI, CRM sync, and analytics must still be able to tell this lead apart from a clean Emailable pass.
- The existing fail-open behavior (Emailable call failure → activate on Apollo's word) is untouched by this plan.
- `undeliverable`, `unknown`, and unrecognized states keep parking unconditionally — this plan only touches the `risky` branch.
- Every task must leave `pnpm vitest run`, `pnpm tsc --noEmit`, and `pnpm eslint .` green before commit (this repo's own documented practice, see `.claude/roadmap.md`).

---

## File Structure

| File | Change |
|---|---|
| `src/lib/emailable/map-verification.ts` | Modify — add the catch-all carve-out inside `mapEmailableVerdict`, update its doc comment |
| `src/lib/emailable/map-verification.test.ts` | Modify — add unit tests for the carve-out and its boundaries |
| `src/lib/pipeline/discover.test.ts` | Modify — add end-to-end regression tests proving the carve-out reaches the inserted row |
| `docs/superpowers/specs/2026-07-21-emailable-verification-design.md` | Modify — append an amendment note recording this change to the original "strict, deliverable-only" decision |
| `.claude/roadmap.md` | Modify — close the open "review after first week" bullet, add a shipped entry |

No new files. This is a change to one pure function's decision table plus its test coverage and its documentation trail.

---

## Task 1: Add the catch-all carve-out to `mapEmailableVerdict`

**Files:**
- Modify: `src/lib/emailable/map-verification.ts:31-72`
- Test: `src/lib/emailable/map-verification.test.ts`

**Interfaces:**
- Consumes: `VerificationOutcome` (from `./types`), unchanged — specifically `outcome.result.state`, `outcome.result.reason` (`string | undefined`), `outcome.result.accept_all` (`boolean | null | undefined`), all already parsed by `emailableResultSchema`.
- Produces: `LeadVerificationVerdict` (unchanged shape) — the only change is which inputs map to `leadStatus: 'active'` vs `'parked'`.

- [ ] **Step 1: Write the failing tests**

Open `src/lib/emailable/map-verification.test.ts`. Add a helper right after the existing `ok` function (after line 13):

```ts
function okWithAcceptAll(state: string, reason: string, acceptAll: boolean | null | undefined) {
  return mapEmailableVerdict(
    { ok: true, result: { ...result(state, reason), accept_all: acceptAll } },
    CHECKED_AT,
  )
}
```

Then add these tests immediately after the existing `it.each(['low_quality', 'low_deliverability'])('should park the lead as risky...')` block (after line 41), still inside the top-level `describe('mapEmailableVerdict', ...)`:

```ts
  it('should activate a risky/low_deliverability lead when the domain is accept_all', () => {
    const verdict = okWithAcceptAll('risky', 'low_deliverability', true)

    expect(verdict.emailStatus).toBe('risky')
    expect(verdict.leadStatus).toBe('active')
  })

  it.each([false, null, undefined])(
    'should still park a risky/low_deliverability lead when accept_all is %s',
    (acceptAll) => {
      const verdict = okWithAcceptAll('risky', 'low_deliverability', acceptAll)

      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it('should still park a risky/low_quality lead even when the domain is accept_all', () => {
    const verdict = okWithAcceptAll('risky', 'low_quality', true)

    expect(verdict.emailStatus).toBe('risky')
    expect(verdict.leadStatus).toBe('parked')
  })

  it('should be case and whitespace insensitive about the reason in the catch-all carve-out', () => {
    const verdict = okWithAcceptAll('risky', ' Low_Deliverability ', true)

    expect(verdict.leadStatus).toBe('active')
  })

  it('should preserve accept_all in the audit record for an activated catch-all lead', () => {
    const verdict = okWithAcceptAll('risky', 'low_deliverability', true)

    expect(verdict.verification).toMatchObject({
      provider: 'emailable',
      outcome: 'checked',
      state: 'risky',
      reason: 'low_deliverability',
      accept_all: true,
    })
  })
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm vitest run src/lib/emailable/map-verification.test.ts`
Expected: the 5 new tests FAIL (`leadStatus` is `'parked'` when the test expects `'active'`); all pre-existing tests still PASS.

- [ ] **Step 3: Implement the carve-out**

Replace the body of `mapEmailableVerdict` in `src/lib/emailable/map-verification.ts` (lines 31-72) with:

```ts
/**
 * The whole send policy. Input is always a lead Apollo already marked
 * `verified` with a non-empty email — the caller guarantees that, because
 * Emailable is never called for any other lead.
 *
 * Emailable only ever narrows: it can demote a lead Apollo verified, never
 * promote one Apollo did not. `deliverable` activates, and so does the one
 * carve-out below (`risky` + `low_deliverability` + `accept_all`) — every
 * other verdict parks.
 *
 * A state we do not recognise parks the lead. That is deliberate and is NOT
 * the same as the fail-open branch below: an unrecognised state is a definite
 * answer we cannot interpret, so the safe reading is "not proven deliverable".
 * Fail-open applies only to the absence of an answer.
 */
export function mapEmailableVerdict(
  outcome: VerificationOutcome,
  checkedAt: string,
): LeadVerificationVerdict {
  // Blanket fail open, by explicit operator decision: any failure — including a
  // persistent 402 (out of credits) or 403 (bad key) — falls back to Apollo's
  // verdict rather than stalling discovery. `verification` is the only durable
  // record that this lead was never actually guarded.
  if (!outcome.ok) {
    return {
      emailStatus: 'verified',
      leadStatus: 'active',
      verification: { provider: 'emailable', outcome: 'failed', error: outcome.error, checkedAt },
    }
  }

  const state = outcome.result.state.toLowerCase().trim()
  const emailStatus = STATE_MAP[state] ?? 'unverified'
  const reason = outcome.result.reason?.toLowerCase().trim()

  // Carve-out: a `risky`/`low_deliverability` verdict on a domain Emailable
  // itself reports as `accept_all` means the mail server accepts every
  // address — Emailable cannot confirm this specific mailbox either way, so
  // the verdict is "unconfirmable", not "bad". Apollo already verified this
  // address once; parking it here would discard a working lead on nothing
  // more than the domain's own catch-all configuration. In production this
  // was the entire `risky` bucket (100% of a sampled batch), which is why it
  // was silently discarding most of the pipeline's verified yield — see
  // docs/superpowers/plans/2026-08-08-emailable-accept-all-catch-all.md.
  // `low_quality` risky results (role/disposable-style signals) are a
  // different, genuine quality concern and are NOT covered by this
  // carve-out — they stay parked regardless of accept_all.
  const isUnconfirmableCatchAll =
    emailStatus === 'risky' && reason === 'low_deliverability' && outcome.result.accept_all === true

  return {
    emailStatus,
    leadStatus: emailStatus === 'verified' || isUnconfirmableCatchAll ? 'active' : 'parked',
    verification: toJson({
      provider: 'emailable',
      outcome: 'checked',
      checkedAt,
      ...outcome.result,
    }),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/emailable/map-verification.test.ts`
Expected: all tests PASS (pre-existing + the 5 new ones).

- [ ] **Step 5: Commit**

```bash
git add src/lib/emailable/map-verification.ts src/lib/emailable/map-verification.test.ts
git commit -m "fix(emailable): activate risky leads on unconfirmable catch-all domains

Only accept_all + low_deliverability is carved out; low_quality and
every undeliverable/unknown/unrecognized state still park. In
production this carve-out was 100% of the risky bucket, which was
silently discarding 62% of verified leads.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Prove the carve-out reaches the inserted lead row end-to-end

**Files:**
- Modify: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `runDiscoveryForCampaign` (existing, unchanged signature), the file's existing `singleCandidateRun()` / `insertedRow()` / `mockVerifyEmail` helpers, and `mapEmailableVerdict`'s new behavior from Task 1.
- Produces: nothing new for later tasks — this task only adds regression coverage.

No production code changes are expected in this task: `verifyBatch` (`src/lib/pipeline/discover.ts:320-370`) already sets `emailableDeliverable`/`emailableRejected` purely from `verdict.leadStatus === 'active'`, so Task 1's fix threads through automatically. This task locks that in with a test, so a future refactor of `verifyBatch` can't silently reintroduce the bug by special-casing on `emailStatus` instead of `leadStatus`.

- [ ] **Step 1: Write the tests**

In `src/lib/pipeline/discover.test.ts`, add a helper next to the existing `function verification(state: string) { ... }` (around line 60):

```ts
function verificationWithAcceptAll(state: string, reason: string, acceptAll: boolean) {
  return { state, reason, accept_all: acceptAll, email: 'jo@acme.com', score: 60 }
}
```

Then add these tests directly after the existing `it.each([['risky', 'risky'], ['unknown', 'unverified']])('should park the lead when Emailable says %s', ...)` block (after line 621):

```ts
  it('should activate the lead when Emailable says risky but the domain is an unconfirmable catch-all', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_deliverability', true))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'risky', status: 'active' })
    expect(insertedRow().email_verified_at).toEqual(expect.any(String))
    expect(summary.emailableDeliverable).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should still park a risky lead when the domain is not accept_all', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_deliverability', false))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'risky', status: 'parked' })
    expect(summary.emailableRejected).toBe(1)
  })

  it('should still park a risky/low_quality lead even when the domain is accept_all', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_quality', true))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'risky', status: 'parked' })
    expect(summary.emailableRejected).toBe(1)
  })
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: all 3 new tests PASS immediately (Task 1 already shipped the behavior) and no pre-existing test in the file breaks — in particular the pre-existing `it.each(['risky', 'unknown'])` block must still pass unchanged, since its `verification()` helper never sets `accept_all`, so those rows still park.

- [ ] **Step 3: Commit**

```bash
git add src/lib/pipeline/discover.test.ts
git commit -m "test(discover): lock in the accept-all catch-all carve-out end-to-end

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Update the documentation trail

**Files:**
- Modify: `docs/superpowers/specs/2026-07-21-emailable-verification-design.md`
- Modify: `.claude/roadmap.md`

**Interfaces:** None — documentation only.

- [ ] **Step 1: Amend the original design spec**

Open `docs/superpowers/specs/2026-07-21-emailable-verification-design.md`. Find decision #3 (`"Send policy: strict. Only state: 'deliverable' may be activated."`, around line 64) and append a new subsection right after the `## Decisions` list (before the next `##` heading):

```markdown
### Amendment — 2026-08-08

Decision 3 above ("only `deliverable` activates") is narrowed, not reversed.
One week of live data showed the `risky` bucket running ~62% of verified
leads, and a direct query of production rows found it was **100%**
`accept_all: true` + `reason: 'low_deliverability'` — i.e. Emailable
reporting "this domain accepts everything, I cannot confirm this specific
mailbox," not "this address is bad." Emailable's own guidance agrees risky
does not mean do-not-send, and recommends segmenting rather than dropping
these. `low_quality` risky results were not seen in the sample and remain
under the original strict policy.

New policy: `risky` activates when, and only when, `reason ===
'low_deliverability'` and `accept_all === true`. Every other case in the
original decision table — `undeliverable`, `unknown`, unrecognized states,
and `risky`/`low_quality` — parks exactly as originally designed. The
existing per-mailbox bounce-rate health monitoring (P4 deliverability
hardening) and DSN-based bounce handling (`handleBounce`) are the safety
net for this cohort; no new guard was added.

Implementation: `docs/superpowers/plans/2026-08-08-emailable-accept-all-catch-all.md`.
```

- [ ] **Step 2: Close the roadmap follow-up and log the change**

Open `.claude/roadmap.md`. Find the line (around line 411):

```
- [ ] Review `emailableRejected` after the first week of live runs and decide whether the strict policy needs loosening for accept-all domains.
```

Replace it with:

```
- [x] Review `emailableRejected` after the first week of live runs and decide whether the strict policy needs loosening for accept-all domains — **done 2026-08-08**, see the "Accept-all catch-all carve-out" entry below.
```

Then add a new dated entry after the existing "Emailable deliverability guard — shipped 2026-07-21" section (after its last line, before the next `##` heading):

```markdown
## Emailable accept-all catch-all carve-out — shipped 2026-08-08

One week of live data showed the deliverability guard's `risky` bucket
running ~62% of verified leads (54/87 in one operator-reported sample), and
a direct query of production `leads.email_verification` found it was 100%
`accept_all: true` + `reason: 'low_deliverability'` — a domain-level "cannot
confirm" signal, not an address-level "bad" signal. `mapEmailableVerdict`
now activates that specific combination; `low_quality` risky results and
every `undeliverable`/`unknown`/unrecognized state still park unchanged.

Plan: `docs/superpowers/plans/2026-08-08-emailable-accept-all-catch-all.md`.
Spec amendment: `docs/superpowers/specs/2026-07-21-emailable-verification-design.md` (Amendment — 2026-08-08).

- [x] `mapEmailableVerdict` carve-out + unit tests (`src/lib/emailable/map-verification.ts`, `.test.ts`).
- [x] End-to-end regression tests in `src/lib/pipeline/discover.test.ts` proving the carve-out reaches the inserted row.
- [ ] Watch bounce rate on `email_status = 'risky' AND status = 'active'` leads over the next 1-2 weeks (queryable directly against `leads.email_verification` — no new counter was added; see the optional `emailableAcceptAllActivated` task in the implementation plan if a rollup metric turns out to be worth adding later).
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-21-emailable-verification-design.md .claude/roadmap.md
git commit -m "docs: record the accept-all catch-all carve-out decision and close the roadmap follow-up

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4 (optional): Add a dedicated counter for the activated catch-all cohort

Skip this task unless you want a rollup metric in `DiscoverySummary` in addition to the per-lead `email_status: 'risky'` tag already written to every row (Task 1). The per-lead tag is already sufficient to query the cohort's bounce rate directly; this task only adds a discovery-run-level count for a dashboard/log line.

**Files:**
- Modify: `src/lib/pipeline/discover.ts:46-62,320-385,465-483,688-699,741-762,864-876`
- Test: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `LeadVerificationVerdict.leadStatus`/`emailStatus` from Task 1 (unchanged).
- Produces: new field `emailableAcceptAllActivated: number` on `DiscoverySummary`, `EnrichResult`, and `VerifyBatchResult` — later callers (a future analytics surface) would read `summary.emailableAcceptAllActivated`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/pipeline/discover.test.ts`, right after the "should activate the lead when Emailable says risky but the domain is an unconfirmable catch-all" test added in Task 2:

```ts
  it('should count an activated catch-all lead separately from a clean deliverable one', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_deliverability', true))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp })

    expect(summary.emailableAcceptAllActivated).toBe(1)
  })
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts -t "count an activated catch-all"`
Expected: FAIL — `summary.emailableAcceptAllActivated` is `undefined`.

- [ ] **Step 3: Thread the counter through**

In `src/lib/pipeline/discover.ts`:

1. `DiscoverySummary` interface (around line 46-62): add `emailableAcceptAllActivated: number` next to `emailableDeliverable`.
2. `VerifyBatchResult`'s inline return type in `verifyBatch` (around line 369, the `return { rows, checked: ..., deliverable, rejected, failedOpen }` line) and its function-local counters (around line 335-337): add `let acceptAllActivated = 0`, and inside the `slice.forEach` block (around line 346-354) increment it when the verdict is the carve-out case:

```ts
      const verdict = mapEmailableVerdict(outcome, checkedAt)
      verdicts.set(target.index, verdict)
      if (!outcome.ok) failedOpen += 1
      else if (verdict.leadStatus === 'active') {
        deliverable += 1
        if (verdict.emailStatus === 'risky') acceptAllActivated += 1
      } else rejected += 1
```

   And update the return statement: `return { rows, checked: verifiable.length, deliverable, rejected, failedOpen, acceptAllActivated }`.

3. `EnrichResult` interface (around line 372-385): add `emailableAcceptAllActivated: number`.
4. In `enrichCandidates` (around line 474-482 and 678-699): add `let emailableAcceptAllActivated = 0`, increment it with `emailableAcceptAllActivated += verified.acceptAllActivated` next to the existing `emailableDeliverable += verified.deliverable` line, and include it in the returned object.
5. In `runFirstPass`/`runSecondPass`'s local aggregation (around line 741-762): add the same counter and accumulate it the same way as `emailableDeliverable`.
6. In the final `DiscoverySummary` assembly (around line 864-876): include `emailableAcceptAllActivated` in the returned object.

- [ ] **Step 4: Run the test and verify it passes**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: the new test PASSES, and no pre-existing test in the file breaks (every other test either doesn't set `accept_all`, so `acceptAllActivated` stays `0` for it, or explicitly asserts other counters that are unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "feat(discover): add emailableAcceptAllActivated counter to DiscoverySummary

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Full verification pass

**Files:** None modified — verification only.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: every test file passes, count is the pre-existing total plus the new tests added in Tasks 1-2 (and Task 4 if done).

- [ ] **Step 2: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Run the linter**

Run: `pnpm eslint .`
Expected: 0 errors (pre-existing warnings, if any, are unrelated to this change and must not increase).

- [ ] **Step 4: Confirm no other file reads the old strict-only assumption**

Run: `grep -rn "leadStatus === 'active'" src --include="*.ts" | grep -v test`

Expected: only `src/lib/pipeline/discover.ts`'s existing `verifiedCount`/summary logic, which already reads `leadStatus`/`status` generically and needs no change — confirms there is no second place in the codebase hardcoding "only `deliverable` means active" that Task 1 missed.

---

## Self-Review Notes (for whoever executes this plan)

- **Spec coverage:** the carve-out condition (Task 1), its boundary cases — `low_quality` untouched, `accept_all: false/null/undefined` untouched (Task 1) — the end-to-end pipeline proof (Task 2), and the documentation trail closing the roadmap's own flagged follow-up (Task 3) are all covered. Task 4 is explicitly optional and does not gate the fix.
- **No placeholders:** every step above has real, complete code — nothing deferred to "add validation later."
- **Type consistency:** `LeadVerificationVerdict`, `EmailableResult`, `VerificationOutcome` are unchanged types; Task 4's new `emailableAcceptAllActivated: number` field name is used identically across every file it touches.
