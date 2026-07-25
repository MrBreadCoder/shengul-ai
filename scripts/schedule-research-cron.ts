// One-time setup: registers the QStash daily schedule that fans research out to
// every case in status 'new'. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-research-cron.ts [cron-expression]
// Default cron: "0 7 * * *" (07:00 UTC daily, after discovery at 06:00).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 7 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/research-fanout', cron)
  process.stdout.write(`Scheduled research-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
