// One-time setup: registers the QStash schedule that sweeps stranded
// 'waiting' outbound emails system-wide (first-touch and follow-up steps
// alike). See lib/pipeline/resend-failed.ts and
// docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md.
// Same shape as schedule-write-cron.ts, and now the same cadence: 'waiting'
// content should send before the same day's brand-new work once the cap
// resets, and running on write-fanout's own 5-minute cadence keeps that
// priority window tight (the two crons remain independent — no hard
// ordering guarantee — but a wide 59-minute gap after a UTC-midnight cap
// reset shrinks to about 5 minutes).
//   Usage: tsx scripts/schedule-resend-failed-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/resend-failed', cron)
  process.stdout.write(`Scheduled resend-failed cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
