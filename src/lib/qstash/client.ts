import { Client } from '@upstash/qstash'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'

const client = new Client({ token: env.QSTASH_TOKEN })

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
