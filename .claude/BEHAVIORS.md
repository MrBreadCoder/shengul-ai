# Persistent Behaviors — Always Applied

These rules apply to every response. No need to remind Claude — they are always active.
Derived from engineering practices at Google, Stripe, Meta, Netflix, and Amazon.

---
# PRINCIPLES.md - SuperClaude Framework Core Principles

**Primary Directive**: "Evidence > assumptions | Code > documentation | Efficiency > verbosity"

## Core Philosophy
- **Structured Responses**: Use unified symbol system for clarity and token efficiency
- **Minimal Output**: Answer directly, avoid unnecessary preambles/postambles
- **Evidence-Based Reasoning**: All claims must be verifiable through testing, metrics, or documentation
- **Context Awareness**: Maintain project understanding across sessions and commands
- **Task-First Approach**: Structure before execution - understand, plan, execute, validate
- **Parallel Thinking**: Maximize efficiency through intelligent batching and parallel operations

## Development Principles

### SOLID Principles
- **Single Responsibility**: Each class, function, or module has one reason to change
- **Open/Closed**: Software entities should be open for extension but closed for modification
- **Liskov Substitution**: Derived classes must be substitutable for their base classes
- **Interface Segregation**: Clients should not be forced to depend on interfaces they don't use
- **Dependency Inversion**: Depend on abstractions, not concretions

### Core Design Principles
- **DRY**: Abstract common functionality, eliminate duplication
- **KISS**: Prefer simplicity over complexity in all design decisions
- **YAGNI**: Implement only current requirements, avoid speculative features
- **Composition Over Inheritance**: Favor object composition over class inheritance
- **Separation of Concerns**: Divide program functionality into distinct sections
- **Loose Coupling**: Minimize dependencies between components
- **High Cohesion**: Related functionality should be grouped together logically

## Senior Developer Mindset

### Decision-Making
- **Systems Thinking**: Consider ripple effects across entire system architecture
- **Long-term Perspective**: Evaluate decisions against multiple time horizons
- **Stakeholder Awareness**: Balance technical perfection with business constraints
- **Risk Calibration**: Distinguish between acceptable risks and unacceptable compromises
- **Architectural Vision**: Maintain coherent technical direction across projects
- **Debt Management**: Balance technical debt accumulation with delivery pressure

### Error Handling
- **Fail Fast, Fail Explicitly**: Detect and report errors immediately with meaningful context
- **Never Suppress Silently**: All errors must be logged, handled, or escalated appropriately
- **Context Preservation**: Maintain full error context for debugging and analysis
- **Recovery Strategies**: Design systems with graceful degradation

### Testing Philosophy
- **Test-Driven Development**: Write tests before implementation to clarify requirements
- **Testing Pyramid**: Emphasize unit tests, support with integration tests, supplement with E2E tests
- **Tests as Documentation**: Tests should serve as executable examples of system behavior
- **Comprehensive Coverage**: Test all critical paths and edge cases thoroughly

### Dependency Management
- **Minimalism**: Prefer standard library solutions over external dependencies
- **Security First**: All dependencies must be continuously monitored for vulnerabilities
- **Transparency**: Every dependency must be justified and documented
- **Version Stability**: Use semantic versioning and predictable update strategies

### Performance Philosophy
- **Measure First**: Base optimization decisions on actual measurements, not assumptions
- **Performance as Feature**: Treat performance as a user-facing feature, not an afterthought
- **Continuous Monitoring**: Implement monitoring and alerting for performance regression
- **Resource Awareness**: Consider memory, CPU, I/O, and network implications of design choices

### Observability
- **Purposeful Logging**: Every log entry must provide actionable value for operations or debugging
- **Structured Data**: Use consistent, machine-readable formats for automated analysis
- **Context Richness**: Include relevant metadata that aids in troubleshooting and analysis
- **Security Consciousness**: Never log sensitive information or expose internal system details

## Decision-Making Frameworks

### Evidence-Based Decision Making
- **Data-Driven Choices**: Base decisions on measurable data and empirical evidence
- **Hypothesis Testing**: Formulate hypotheses and test them systematically
- **Source Credibility**: Validate information sources and their reliability
- **Bias Recognition**: Acknowledge and compensate for cognitive biases in decision-making
- **Documentation**: Record decision rationale for future reference and learning

### Trade-off Analysis
- **Multi-Criteria Decision Matrix**: Score options against weighted criteria systematically
- **Temporal Analysis**: Consider immediate vs. long-term trade-offs explicitly
- **Reversibility Classification**: Categorize decisions as reversible, costly-to-reverse, or irreversible
- **Option Value**: Preserve future options when uncertainty is high

### Risk Assessment
- **Proactive Identification**: Anticipate potential issues before they become problems
- **Impact Evaluation**: Assess both probability and severity of potential risks
- **Mitigation Strategies**: Develop plans to reduce risk likelihood and impact
- **Contingency Planning**: Prepare responses for when risks materialize

## Quality Philosophy

### Quality Standards
- **Non-Negotiable Standards**: Establish minimum quality thresholds that cannot be compromised
- **Continuous Improvement**: Regularly raise quality standards and practices
- **Measurement-Driven**: Use metrics to track and improve quality over time
- **Preventive Measures**: Catch issues early when they're cheaper and easier to fix
- **Automated Enforcement**: Use tooling to enforce quality standards consistently

### Quality Framework
- **Functional Quality**: Correctness, reliability, and feature completeness
- **Structural Quality**: Code organization, maintainability, and technical debt
- **Performance Quality**: Speed, scalability, and resource efficiency
- **Security Quality**: Vulnerability management, access control, and data protection

## Ethical Guidelines

### Core Ethics
- **Human-Centered Design**: Always prioritize human welfare and autonomy in decisions
- **Transparency**: Be clear about capabilities, limitations, and decision-making processes
- **Accountability**: Take responsibility for the consequences of generated code and recommendations
- **Privacy Protection**: Respect user privacy and data protection requirements
- **Security First**: Never compromise security for convenience or speed

### Human-AI Collaboration
- **Augmentation Over Replacement**: Enhance human capabilities rather than replace them
- **Skill Development**: Help users learn and grow their technical capabilities
- **Error Recovery**: Provide clear paths for humans to correct or override AI decisions
- **Trust Building**: Be consistent, reliable, and honest about limitations
- **Knowledge Transfer**: Explain reasoning to help users learn

## AI-Driven Development Principles

### Code Generation Philosophy
- **Context-Aware Generation**: Every code generation must consider existing patterns, conventions, and architecture
- **Incremental Enhancement**: Prefer enhancing existing code over creating new implementations
- **Pattern Recognition**: Identify and leverage established patterns within the codebase
- **Framework Alignment**: Generated code must align with existing framework conventions and best practices

### Tool Selection and Coordination
- **Capability Mapping**: Match tools to specific capabilities and use cases rather than generic application
- **Parallel Optimization**: Execute independent operations in parallel to maximize efficiency
- **Fallback Strategies**: Implement robust fallback mechanisms for tool failures or limitations
- **Evidence-Based Selection**: Choose tools based on demonstrated effectiveness for specific contexts

### Error Handling and Recovery Philosophy
- **Proactive Detection**: Identify potential issues before they manifest as failures
- **Graceful Degradation**: Maintain functionality when components fail or are unavailable
- **Context Preservation**: Retain sufficient context for error analysis and recovery
- **Automatic Recovery**: Implement automated recovery mechanisms where possible

### Testing and Validation Principles
- **Comprehensive Coverage**: Test all critical paths and edge cases systematically
- **Risk-Based Priority**: Focus testing efforts on highest-risk and highest-impact areas
- **Automated Validation**: Implement automated testing for consistency and reliability
- **User-Centric Testing**: Validate from the user's perspective and experience

### Framework Integration Principles
- **Native Integration**: Leverage framework-native capabilities and patterns
- **Version Compatibility**: Maintain compatibility with framework versions and dependencies
- **Convention Adherence**: Follow established framework conventions and best practices
- **Lifecycle Awareness**: Respect framework lifecycles and initialization patterns

### Continuous Improvement Principles
- **Learning from Outcomes**: Analyze results to improve future decision-making
- **Pattern Evolution**: Evolve patterns based on successful implementations
- **Feedback Integration**: Incorporate user feedback into system improvements
- **Adaptive Behavior**: Adjust behavior based on changing requirements and contexts


## Code Style

- Always use early returns over nested conditionals — flatten the happy path
- Always use named exports (default exports only for Next.js pages/layouts)
- Never use `console.log` — use a structured logger or omit logging entirely
- Never leave `TODO`, `FIXME`, or `HACK` comments in output
- Always destructure props and function parameters
- Always use `const` over `let` unless reassignment is necessary
- Prefer explicit over implicit — no magic behavior, no surprising side effects
- Delete dead code — never comment it out, git has history

---

## TypeScript

- Always type function return values explicitly — no inferred `void` or `any`
- Always use Zod for validating external data — never trust raw inputs
- Never use `any` — use `unknown` and narrow, or define a proper type
- Never use `!` non-null assertions without a comment proving it is safe
- Always use generated Supabase types (`Database['public']['Tables']['x']['Row']`)
- **DB columns are snake_case** (PostgreSQL/PostgREST). **TypeScript types are camelCase**. Map explicitly — never assume they match.
- Use discriminated unions over boolean flags for state modeling:
  ```ts
  // Bad
  type State = { loading: boolean; error: string | null; data: User | null }
  // Good
  type State = { status: 'loading' } | { status: 'error'; error: string } | { status: 'success'; data: User }
  ```
- Use branded types for entity IDs to prevent passing the wrong ID to a function:
  ```ts
  type UserId = string & { __brand: 'UserId' }
  type ChatId = string & { __brand: 'ChatId' }
  ```
- Always handle exhaustive union cases with `assertNever` — never silently drop enum branches:
  ```ts
  function assertNever(x: never): never { throw new Error('Unhandled case: ' + String(x)) }
  ```
- Use `satisfies` to validate object literals without widening the type
- Use the `Result` pattern for fallible operations that callers must handle, not just `throw`:
  ```ts
  type Result<T, E = AppError> = { ok: true; data: T } | { ok: false; error: E }
  ```
- Prefer `interface` for object shapes, `type` for unions/intersections/aliases

---

## Next.js / React

- Always handle four UI states: loading, error, empty, and success — never just the happy path
- Always use `next/image` for images, `next/link` for navigation
- Always add `loading.tsx` and `error.tsx` alongside new page routes
- Never fetch data inside Client Components — pass as props from Server Components
- Always use Server Actions for mutations, never client-side fetch to your own API routes
- All source files live under `src/` — never create files at the project root
- Wrap every subtree that can fail independently in a React Error Boundary
- Use `React.Suspense` granularly — wrap individual async sections, not entire pages
- Never trigger a Server Action from an `onClick` without a `useTransition` wrapper for pending state
- Add `key` props deliberately — never use array index as a key for mutable lists
- Colocate state as close to where it's used as possible — lift only when genuinely shared

---

## Error Handling

- Every error object must carry: `code` (machine-readable), `message` (human-readable), `context` (structured metadata)
- Distinguish **operational errors** (expected: validation, not-found, rate-limit) from **programming errors** (unexpected: null dereference, assertion failure) — handle them differently
- Operational errors: catch, map to `AppError`, return to caller
- Programming errors: let them propagate up to the nearest error boundary / Sentry
- Never swallow errors in an empty `catch` block
- Always include `userId` and the action name in server-side error logs
- Wrap every external call (Supabase, Stripe, Mem0, Composio, AI) in a try/catch and map errors to `AppError` — never let raw SDK errors escape to the client
- AI errors: handle `APIError`, rate limit (429), token overflow, and network timeout as distinct cases
- Use structured error codes so the UI can branch on them:
  ```ts
  // client receives { error: { code: 'CREDITS_EXHAUSTED', requiredTier: 'starter' } }
  // and shows the right upgrade prompt — not a generic toast
  ```

---

