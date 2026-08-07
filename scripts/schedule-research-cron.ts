// One-time setup: registers the QStash schedule that fans research out to
// every case in status 'new', system-wide, every 5 minutes. No per-campaign
// scheduling is needed here — it already scans every 'new' case regardless
// of campaign or client, so a case that just went 'new' from any campaign's
// discovery run is picked up on the very next tick. Run once per environment
// after deploy:
//   Usage: tsx scripts/schedule-research-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/research-fanout', cron)
  process.stdout.write(`Scheduled research-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
