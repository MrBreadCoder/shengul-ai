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

// Ordinals rather than uuids: models mangle uuids, and 40 of them is pure token
// waste. One line per entry, because a line break inside a description would
// otherwise let a resource's text impersonate a new menu row.
export function formatResourceMenu(menu: readonly ResourceMenuEntry[]): string {
  if (menu.length === 0) return ''
  return menu
    .map(({ ordinal, resource }) => {
      const title = resource.title.replace(/\s+/g, ' ').trim()
      const description = resource.description.replace(/\s+/g, ' ').trim()
      return `${ordinal} — ${title} — ${description}`
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
