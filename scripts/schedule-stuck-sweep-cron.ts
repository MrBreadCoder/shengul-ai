// One-time setup: registers the QStash schedule that sweeps stranded cases (a
// research/write loop that died mid-way) and re-queues them. Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-stuck-sweep-cron.ts [cron-expression]
// Default cron: "*/15 * * * *" (every 15 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/15 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/stuck-sweep', cron)
  process.stdout.write(`Scheduled stuck-sweep cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
