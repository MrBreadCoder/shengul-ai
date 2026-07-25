// One-time setup: registers the QStash schedule that re-evaluates every
// mailbox's health from its recent hard-bounce rate. Run once per environment
// after deploy:
//   Usage: tsx scripts/schedule-mailbox-health-cron.ts [cron-expression]
// Default cron: "0 */6 * * *" (every 6 hours — fast enough to catch a bounce
// spike within a sending day, slow enough not to thrash on a single bad address).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 */6 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailbox-health', cron)
  process.stdout.write(`Scheduled mailbox-health cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
