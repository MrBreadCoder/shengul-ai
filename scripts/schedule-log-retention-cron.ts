// One-time setup: registers the QStash schedule that purges log rows past their
// retention window (30 days for info, 90 days for warn/error). Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-log-retention-cron.ts [cron-expression]
// Default cron: "20 3 * * *" (daily at 03:20 UTC, off the pipeline's peak).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '20 3 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/log-retention', cron)
  process.stdout.write(`Scheduled log-retention cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
