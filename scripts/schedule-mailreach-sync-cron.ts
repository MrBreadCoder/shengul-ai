// One-time setup: registers the QStash schedule that refreshes every
// Mailreach-connected mailbox's cached reputation score. Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-mailreach-sync-cron.ts [cron-expression]
// Default cron: "0 */6 * * *" (every 6 hours — same cadence as the existing
// mailbox-health sweep).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 */6 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailreach-sync', cron)
  process.stdout.write(`Scheduled mailreach-sync cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
