import type { ClientResourceRow } from '@/lib/db/client-resources'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'

// The scaling ceiling for putting the whole library in the prompt. Past this,
// the menu dilutes the model's attention and eats the token budget; the
// migration at that point is a semantic shortlist (embed `description`,
// retrieve top-K by the lead's question, put only those in the menu).
export const MAX_RESOURCE_MENU = 40

export interface ResourceMenuEntry {
  ordinal: number
  resource: ClientResourceRow
}

export interface ResolvedAttachments {
  resources: ClientResourceRow[]
  droppedResourceIds: string[]
  totalBytes: number
}

export function buildResourceMenu(resources: readonly ClientResourceRow[]): ResourceMenuEntry[] {
  return resources
    .slice(0, MAX_RESOURCE_MENU)
    .map((resource, index) => ({ ordinal: index + 1, resource }))
}

// 40 menu entries at this width costs roughly 4k prompt tokens — the ceiling
// that keeps the whole-library menu affordable. Enforced when the worker writes
// a summary and again here, so a row written before the cap changed cannot blow
// the budget.
export const RESOURCE_SUMMARY_MAX_CHARS = 240

// The menu's own grammar: a newline ends a row, an em dash separates the fields
// within one, and a pipe opens the derived summary. Every value on a line comes
// from the resource itself — an operator's title and hint, and a summary the
// model wrote from the file's own bytes — so none of them may be able to spell a
// separator, or a row can forge a field it was never given.
function menuSafe(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/[—|]/g, '-')
    .trim()
}

// Ordinals rather than uuids: models mangle uuids, and 40 of them is pure token
// waste. One line per entry, with every separator stripped from the values —
// otherwise a resource's own text could impersonate a new menu row or a field
// it was never given.
export function formatResourceMenu(menu: readonly ResourceMenuEntry[]): string {
  if (menu.length === 0) return ''
  return menu
    .map(({ ordinal, resource }) => {
      const segments = [`${ordinal} — ${menuSafe(resource.title)}`]
      const description = resource.description ? menuSafe(resource.description) : ''
      if (description) segments.push(`when to send: ${description}`)
      const line = segments.join(' — ')
      const summary = resource.content_summary ? menuSafe(resource.content_summary) : ''
      if (!summary) return line
      return `${line} | contains: ${summary.slice(0, RESOURCE_SUMMARY_MAX_CHARS)}`
    })
    .join('\n')
}

/**
 * Keeps candidates in order until either budget is spent, reporting what it had
 * to drop. Used wherever the caller must never fail — the automated reply path
 * and the pipeline's defensive re-check — as opposed to the interactive paths,
 * which reject an over-budget selection outright so the human can fix it.
 */
export function applyAttachmentBudget(
  candidates: readonly ClientResourceRow[],
): ResolvedAttachments {
  const resources: ClientResourceRow[] = []
  const droppedResourceIds: string[] = []
  let totalBytes = 0
  for (const resource of candidates) {
    const isOverCount = resources.length >= MAX_ATTACHMENTS_PER_EMAIL
    const isOverBudget = totalBytes + resource.byte_size > MAX_TOTAL_ATTACHMENT_BYTES
    if (isOverCount || isOverBudget) {
      droppedResourceIds.push(resource.id)
      continue
    }
    resources.push(resource)
    totalBytes += resource.byte_size
  }
  return { resources, droppedResourceIds, totalBytes }
}

/**
 * Turns the model's picked ordinals into real rows the sender can attach.
 * Everything the model returns is treated as untrusted: out-of-range ordinals
 * are hallucinations, repeats are noise, and the count and byte budget are
 * enforced here rather than trusted to the prompt.
 */
export function resolveAttachments(
  menu: readonly ResourceMenuEntry[],
  picked: readonly number[],
): ResolvedAttachments {
  const byOrdinal = new Map(menu.map((entry) => [entry.ordinal, entry.resource]))
  const seen = new Set<number>()
  const candidates: ClientResourceRow[] = []
  for (const ordinal of picked) {
    if (seen.has(ordinal)) continue
    seen.add(ordinal)
    const resource = byOrdinal.get(ordinal)
    if (resource) candidates.push(resource)
  }

  return applyAttachmentBudget(candidates)
}
