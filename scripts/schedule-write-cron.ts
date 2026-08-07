// One-time setup: registers the QStash schedule that fans the writer out to
// every case in status 'ready', system-wide, every 5 minutes. No per-campaign
// scheduling is needed here — it already scans every 'ready' case regardless
// of campaign or client, so a case a research tick just marked 'ready' is
// picked up on the very next tick. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-write-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/write-fanout', cron)
  process.stdout.write(`Scheduled write-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
