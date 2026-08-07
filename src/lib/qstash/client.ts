import { Client } from '@upstash/qstash'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'

// This app runs on AWS us-east-1; QStash's regions are fully independent
// (separate resources per region), so the ambiguous default endpoint must
// never be relied on — pin it explicitly. See QSTASH_URL in src/lib/env.ts.
const QSTASH_US_EAST_1_URL = 'https://qstash-us-east-1.upstash.io'

const client = new Client({ token: env.QSTASH_TOKEN, baseUrl: env.QSTASH_URL ?? QSTASH_US_EAST_1_URL })

function destination(path: string): string {
  return new URL(path, env.APP_URL).toString()
}

export async function publishJson(path: string, body: Record<string, unknown>): Promise<string> {
  try {
    const res = await client.publishJSON({ url: destination(path), body })
    return res.messageId
  } catch (cause) {
    throw new AppError('EXTERNAL_ERROR', 'QStash publish failed', {
      path, cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export async function scheduleCron(path: string, cron: string): Promise<string> {
  try {
    const res = await client.schedules.create({ destination: destination(path), cron })
    return res.scheduleId
  } catch (cause) {
    throw new AppError('EXTERNAL_ERROR', 'QStash schedule create failed', {
      path, cron, cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export async function publishJsonWithDelay(
  path: string,
  body: Record<string, unknown>,
  delaySeconds: number,
): Promise<string> {
  try {
    const res = await client.publishJSON({ url: destination(path), body, delay: delaySeconds })
    return res.messageId
  } catch (cause) {
    throw new AppError('EXTERNAL_ERROR', 'QStash delayed publish failed', {
      path, delaySeconds, cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
