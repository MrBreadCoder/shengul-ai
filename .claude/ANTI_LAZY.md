# Anti-Lazy Rules — Enforced Completely

These rules exist because AI tends to cut corners. Every rule here represents a failure mode to avoid absolutely.

## Forbidden Patterns — Never Do These

### Stub Code
```ts
// FORBIDDEN
function processPayment(amount: number) {
  // TODO: implement payment logic
}

// FORBIDDEN
async function getUserMemories(userId: string) {
  // ... implementation
}

// FORBIDDEN
// Add your Stripe logic here
```

### Truncated Output
- NEVER write `// ... rest of the component` or `// ... same as above`
- NEVER write `// (unchanged)` and skip sections
- NEVER say "the rest of the file remains the same"
- NEVER output partial file contents and expect the user to merge manually
- If a file is large, edit ONLY the specific sections that change using Edit tool

### Vague Placeholders
- NEVER use `yourApiKey`, `YOUR_SECRET_HERE`, `<insert logic>`, `<add handler>`
- NEVER write component shells without actual logic
- NEVER write type stubs like `type UserData = any // TODO: fill this in`

### Incomplete Error Handling
- NEVER write try/catch with empty catch blocks
- NEVER write `catch (e) { console.log(e) }` as a complete error handler
- NEVER ignore the error case in async operations

### Fake Implementations
- NEVER return hardcoded mock data from a function that should query the DB
- NEVER write `return []` as a stub for a function that should fetch real data
- NEVER skip Supabase/Stripe/Mem0 integration with "you can add this later"

## Required Completeness Standards

### When adding a new feature, you MUST:
1. Implement the full Server Action or Route Handler
2. Implement all Zod validation schemas
3. Implement the full UI component with all states (loading, error, empty, success)
4. Add proper TypeScript types
5. Handle all error cases explicitly
6. Wire up auth/permission checks

### When creating a Supabase query, you MUST:
1. Write the actual SQL or Supabase query builder call
2. Handle the `{ data, error }` return shape
3. Type the return value with generated DB types
4. Consider RLS implications

### When adding an AI feature, you MUST:
1. Build the full prompt with system message
2. Retrieve relevant Mem0 memories and inject into context
3. Handle streaming or handle complete response — not leave it as `// stream here`
4. Store the interaction back to Mem0 after completion
5. Handle rate limit and error cases

### When adding a Stripe feature, you MUST:
1. Implement the full checkout/billing flow
2. Implement the webhook handler for related events
3. Sync state to Supabase
4. Verify auth on server side before creating checkout sessions

### When implementing Composio integrations, you MUST:
1. Handle the OAuth/connection flow fully
2. Handle disconnected state in the UI
3. Validate action results before using them
4. Handle Composio API errors explicitly

## Communication Rules
- If a task is too large for one response, say: "This will take multiple steps. Here is step 1 of N: [complete step 1]"
- If requirements are ambiguous, ask ONE clarifying question — then implement fully
- Do not ask multiple questions before starting — ask the most critical one, then proceed
- Do not explain what you're about to do at length — just do it, then briefly note what was done
- Do not add unsolicited features, refactors, or "improvements" — implement exactly what was asked
