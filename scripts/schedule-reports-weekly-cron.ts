// One-time setup: registers the QStash schedule that fans out one weekly
// report job per active client. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-reports-weekly-cron.ts [cron-expression]
// Default cron: "0 8 * * 1" (Monday 08:00 UTC).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 8 * * 1'
  const scheduleId = await scheduleCron('/api/pipeline/reports-weekly-fanout', cron)
  process.stdout.write(`Scheduled reports-weekly-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
