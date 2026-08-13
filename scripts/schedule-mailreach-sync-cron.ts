// One-time setup: registers the QStash schedule that refreshes every
// Mailreach-connected mailbox's cached reputation score. Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-mailreach-sync-cron.ts [cron-expression]
// Default cron: "*/10 * * * *" (every 10 minutes). Re-running this script
// against an environment that already has a schedule registered creates a
// SECOND, duplicate schedule unless you pass the existing scheduleId — use
// `client.schedules.list()` (see src/lib/qstash/client.ts) to find it first,
// or delete the old schedule via the QStash dashboard before re-running.
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/10 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailreach-sync', cron)
  process.stdout.write(`Scheduled mailreach-sync cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
