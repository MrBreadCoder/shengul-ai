'use client'

import { useState } from 'react'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'
import { formatBytes } from '@/lib/format/bytes'
import type { ResourceSummary } from '@/components/resource-list'

interface ResourcePickerProps {
  resources: readonly ResourceSummary[]
  /** Form field name; one hidden input is emitted per selected id. */
  name: string
  defaultSelectedIds?: readonly string[]
  onSelectionChange?: (ids: string[]) => void
}

export function ResourcePicker({
  resources,
  name,
  defaultSelectedIds = [],
  onSelectionChange,
}: ResourcePickerProps): React.ReactElement | null {
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(defaultSelectedIds)

  const selected = resources.filter((resource) => selectedIds.includes(resource.id))
  const totalBytes = selected.reduce((sum, resource) => sum + resource.byteSize, 0)

  // Selected but no longer in the library — it was removed after being attached,
  // so it has no row of its own to render. Without an explicit entry it would be
  // invisible yet still submitted, making it impossible to detach.
  const missingSelectedIds = selectedIds.filter(
    (id) => !resources.some((resource) => resource.id === id),
  )

  function toggleId(resourceId: string): void {
    setSelectedIds((ids) => {
      const next = ids.includes(resourceId)
        ? ids.filter((id) => id !== resourceId)
        : [...ids, resourceId]
      onSelectionChange?.([...next])
      return next
    })
  }

  // A client with no library and nothing stale to clear should see no dead
  // control at all.
  if (resources.length === 0 && missingSelectedIds.length === 0) return null

  return (
    <fieldset className="border-hairline flex flex-col gap-2 rounded-lg border p-3">
      <legend className="text-faint px-1 text-[11px]">Attach resources — sent to the lead</legend>

      {missingSelectedIds.map((id) => (
        <label key={id} className="hover:bg-accent/50 flex items-start gap-2.5 rounded-md px-2 py-1.5 text-xs">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0"
            checked
            onChange={() => toggleId(id)}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">Unavailable file</span>
            <span className="text-muted-foreground block">
              Removed from the library since it was attached. Untick to detach it — this email
              cannot be sent while it is still selected.
            </span>
          </span>
        </label>
      ))}

      {resources.map((resource) => {
        const isSelected = selectedIds.includes(resource.id)
        // Counted over every selection, including the unavailable rows above, so
        // the ceiling cannot be exceeded by mixing the two.
        // A selected row is never disabled, so a choice is always reversible.
        const wouldExceedCount = selectedIds.length >= MAX_ATTACHMENTS_PER_EMAIL
        const wouldExceedBytes = totalBytes + resource.byteSize > MAX_TOTAL_ATTACHMENT_BYTES
        const isDisabled = !isSelected && (wouldExceedCount || wouldExceedBytes)

        return (
          <label
            key={resource.id}
            className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 text-xs ${
              isDisabled ? 'opacity-45' : 'hover:bg-accent/50 cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 shrink-0"
              checked={isSelected}
              disabled={isDisabled}
              onChange={() => toggleId(resource.id)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{resource.title}</span>
              <span className="text-muted-foreground block truncate">{resource.description}</span>
            </span>
            <span className="text-faint tnum shrink-0">{formatBytes(resource.byteSize)}</span>
          </label>
        )
      })}

      <p className="text-faint tnum px-2 text-[11px]" aria-live="polite">
        {formatBytes(totalBytes)} / {formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} ·{' '}
        {selectedIds.length} / {MAX_ATTACHMENTS_PER_EMAIL} files
      </p>

      {/* Hidden inputs rather than component state alone, so this composes with
          a plain <form action={serverAction}> and needs no client-side submit. */}
      {selectedIds.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
    </fieldset>
  )
}
