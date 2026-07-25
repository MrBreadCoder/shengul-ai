// One-time setup: registers the QStash daily schedule that fans the writer out
// to every case in status 'ready'. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-write-cron.ts [cron-expression]
// Default cron: "0 8 * * *" (08:00 UTC daily, after research at 07:00).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 8 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/write-fanout', cron)
  process.stdout.write(`Scheduled write-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
