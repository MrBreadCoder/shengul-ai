// One-time setup: registers the QStash schedule that fans out one monthly
// report job per active client, covering the just-completed calendar month.
// Independent of the weekly cadence (see design spec §1). Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-reports-monthly-cron.ts [cron-expression]
// Default cron: "0 8 1 * *" (1st of month, 08:00 UTC).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 8 1 * *'
  const scheduleId = await scheduleCron('/api/pipeline/reports-monthly-fanout', cron)
  process.stdout.write(`Scheduled reports-monthly-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
