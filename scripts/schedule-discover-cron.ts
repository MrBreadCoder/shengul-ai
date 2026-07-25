// One-time setup: registers the QStash daily schedule that fans discovery out
// to every active campaign. Run manually once per environment after deploy:
//   Usage: tsx scripts/schedule-discover-cron.ts [cron-expression]
// Default cron: "0 6 * * *" (06:00 UTC daily).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 6 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/discover-fanout', cron)
  process.stdout.write(`Scheduled discover-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
