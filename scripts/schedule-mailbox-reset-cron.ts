// One-time setup: registers the QStash daily schedule that resets every
// mailbox's sent_today counter. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-mailbox-reset-cron.ts [cron-expression]
// Default cron: "0 0 * * *" (00:00 UTC daily, before the day's sends).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 0 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailbox-reset', cron)
  process.stdout.write(`Scheduled mailbox-reset cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
