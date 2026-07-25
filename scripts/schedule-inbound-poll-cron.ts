// One-time setup: registers the QStash schedule that fans inbound polling out to
// every connected mailbox. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-inbound-poll-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes). Reply latency for cold outreach
// tolerates minutes; push subscriptions (P4) can lower it further behind the
// same fetchInbound interface.
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/inbound/poll-fanout', cron)
  process.stdout.write(`Scheduled inbound poll-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
