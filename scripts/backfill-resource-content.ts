// One-time backfill: every resource uploaded before 0019_resource_content.sql
// sits at content_status 'pending' with no job behind it, because the enqueue
// only exists on the upload path added in the same change. Run once per
// environment after deploying:
//   Usage: tsx scripts/backfill-resource-content.ts [limit]
// Default limit: 500. Safe to re-run — a row that succeeded is no longer
// 'pending', and the worker's delete-then-insert makes a repeat read idempotent.
import { createAdminClient } from '../src/lib/supabase/admin'
import { listResourcesAwaitingContent } from '../src/lib/db/resource-content'
import { publishJson } from '../src/lib/qstash/client'

const DEFAULT_LIMIT = 500

async function main() {
  const limit = Number(process.argv[2] ?? DEFAULT_LIMIT)
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`Limit must be a positive integer, got "${process.argv[2]}"`)
  }

  const admin = createAdminClient()
  const pending = await listResourcesAwaitingContent(admin, limit)
  if (pending.length === 0) {
    process.stdout.write('No resources are awaiting content.\n')
    return
  }

  let queued = 0
  const failed: string[] = []
  for (const resource of pending) {
    try {
      await publishJson('/api/pipeline/resource-read', { resourceId: resource.id })
      queued += 1
    } catch {
      // Recorded and reported rather than thrown: one unpublishable row must not
      // strand the rest of the backlog.
      failed.push(resource.id)
    }
  }

  process.stdout.write(`Queued ${queued} of ${pending.length} resource reads.\n`)
  if (failed.length > 0) {
    process.stdout.write(`Failed to queue: ${failed.join(', ')}\n`)
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
