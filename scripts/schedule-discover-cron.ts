// One-time setup: registers the QStash schedule that ticks the discovery
// scheduler every 5 minutes. Each tick fires only the campaigns whose own
// next_discover_at is due (see /api/pipeline/discover-fanout) — not every
// active campaign. Run manually once per environment after deploy:
//   Usage: tsx scripts/schedule-discover-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/discover-fanout', cron)
  process.stdout.write(`Scheduled discover-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
