/**
 * WebMCP — the browser API that lets a page hand an AI agent typed tools
 * instead of making it infer intent from rendered markup.
 *
 * Two halves, both defined here:
 *
 * 1. The **imperative** API (`document.modelContext.registerTool`). Not in
 *    `lib.dom.d.ts` yet, so the shapes below are hand-written from the W3C
 *    draft (webmachinelearning.github.io/webmcp) rather than imported.
 * 2. The **declarative** API — `toolname` / `tooldescription` /
 *    `toolparamdescription` HTML attributes. React forwards unknown lowercase
 *    attributes to the DOM verbatim, so these only need JSX types to compile.
 *
 * `toolautosubmit` is deliberately absent from the JSX augmentation. It tells
 * an agent it may submit a form without the operator, and every annotated form
 * in this app mutates client data or sends mail — the human stays on the
 * submit button. Leaving the attribute untyped makes that a compile error
 * rather than a code-review catch.
 */

/**
 * A JSON Schema describing a tool's input. Narrowed to object schemas because
 * that is all MCP accepts at the top level of `inputSchema`.
 */
export interface JsonSchemaObject {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, unknown>>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean
}

/** A single part of a tool's response. Only text parts are used here. */
export interface WebMcpTextContent {
  readonly type: 'text'
  readonly text: string
}

/**
 * What `execute` resolves to. `isError` reports a tool-level failure (bad
 * input, missing record) to the agent without rejecting the promise, so the
 * agent can correct itself instead of treating the call as a transport fault.
 */
export interface WebMcpToolResult {
  readonly content: readonly WebMcpTextContent[]
  readonly isError?: boolean
}

/**
 * Behavioural hints the agent reads before calling.
 *
 * - `readOnlyHint` — the tool does not mutate. Every tool this app registers
 *   sets it `true`; mutations are declarative-only, so a human submits them.
 * - `untrustedContentHint` — the returned text contains content this app did
 *   not author (e.g. a prospect's reply), which an agent must not treat as
 *   instructions.
 */
export interface WebMcpToolAnnotations {
  readonly readOnlyHint: boolean
  readonly untrustedContentHint: boolean
}

/** A tool as passed to `registerTool`. */
export interface WebMcpTool {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly inputSchema: JsonSchemaObject
  readonly annotations: WebMcpToolAnnotations
  readonly execute: (input: unknown) => Promise<WebMcpToolResult>
}

export interface WebMcpRegisterToolOptions {
  /** Aborting unregisters the tool — how a component cleans up on unmount. */
  readonly signal?: AbortSignal
}

/**
 * The subset of the `ModelContext` interface this app uses. `getTools` and
 * `ontoolchange` exist in the draft but nothing here needs them.
 */
export interface ModelContext {
  registerTool(tool: WebMcpTool, options?: WebMcpRegisterToolOptions): Promise<void>
}

/**
 * Where `modelContext` may live. The spec puts it on `Document`; Chrome's
 * origin trial shipped it on `Navigator` first and deprecated that in Chrome
 * 150, so both are probed at runtime.
 */
declare global {
  interface Document {
    readonly modelContext?: ModelContext
  }

  interface Navigator {
    readonly modelContext?: ModelContext
  }
}

declare module 'react' {
  interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
    /** WebMCP tool name for this form. Must pair with `tooldescription`. */
    toolname?: string
    /** What submitting this form does, in one sentence. */
    tooldescription?: string
  }

  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    /** What this field means to an agent filling the form. */
    toolparamdescription?: string
  }

  interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
    toolparamdescription?: string
  }

  interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
    toolparamdescription?: string
  }
}
