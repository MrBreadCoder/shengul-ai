/**
 * Escalation path for an unexpected failure inside browser-side WebMCP code.
 *
 * `reportError` is the platform's own hook for "something broke that nobody
 * awaited": it routes to `window.onerror` and therefore to whatever error
 * monitoring the page installs, without the console noise this project bans and
 * without unwinding the caller. Every browser that ships WebMCP has it.
 */
export function reportBrowserError(error: unknown): void {
  if (typeof globalThis.reportError !== 'function') return
  globalThis.reportError(error)
}
