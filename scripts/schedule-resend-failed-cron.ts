// One-time setup: registers the QStash schedule that sweeps stranded
// 'failed' first-touch emails system-wide. See lib/pipeline/resend-failed.ts
// and .claude/roadmap.md 2026-08-19 for what this closes. Same shape as
// schedule-write-cron.ts, a slower cadence by default: unlike write-fanout
// (an underused mailbox becoming eligible again is common and time-
// sensitive), the dominant real-world cause here is a daily send cap, which
// only ever clears at UTC midnight — a 5-minute tick would mostly just be
// 288 no-op reads a day.
//   Usage: tsx scripts/schedule-resend-failed-cron.ts [cron-expression]
// Default cron: "0 * * * *" (top of every hour).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/resend-failed', cron)
  process.stdout.write(`Scheduled resend-failed cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
