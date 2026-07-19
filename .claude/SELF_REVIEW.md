# Self-Review Loop — Mandatory Before Every Response

After completing any implementation task, run this checklist silently before outputting the final response. Do NOT skip this step. Do NOT mention you are running it unless an item fails.

## Gate 1 — Completeness
- [ ] Every function is fully implemented — no stubs, no placeholders, no TODOs
- [ ] All code paths are handled (happy path + errors + edge cases)
- [ ] No truncated output — if a file was changed, the full relevant section is shown

## Gate 2 — Correctness
- [ ] TypeScript types are explicit and correct — no implicit `any`
- [ ] Zod validation is present for all external inputs
- [ ] Async operations are properly awaited
- [ ] No unhandled promise rejections

## Gate 3 — Auth & Security
- [ ] Every Server Action validates the session before executing
- [ ] `user_id` comes from the server session, not the request
- [ ] No secrets or sensitive values are hardcoded or logged
- [ ] RLS is considered for any new Supabase table/query

## Gate 4 — UI States (for components)
- [ ] Loading state is handled
- [ ] Error state is handled and user-friendly
- [ ] Empty/zero-data state is handled
- [ ] Success state is complete

## Gate 5 — Stack Compliance
- [ ] Mem0 memories retrieved before AI call (if AI feature)
- [ ] AI responses streamed (if user-facing)
- [ ] Stripe webhook signature verified (if webhook)
- [ ] Composio disconnected state handled (if integration)
- [ ] Supabase `{ data, error }` destructured and both handled

## Gate 6 — Code Quality
- [ ] No commented-out code
- [ ] Early returns used over nested conditionals
- [ ] Functions are single-responsibility and under ~40 lines

## On Failure
If any gate fails:
1. Fix the issue immediately
2. Re-run the checklist from that gate
3. Only output the response when all gates pass

Do not output a response that fails any gate. Do not mention the checklist in the response unless explaining why something was changed mid-implementation.
