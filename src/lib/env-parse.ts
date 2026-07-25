import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'

export function parseEnv<T>(schema: z.ZodType<T>, source: Record<string, string | undefined>): T {
  const parsed = schema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new AppError('CONFIG_ERROR', `Invalid environment configuration: ${issues}`, {
      issues: parsed.error.flatten().fieldErrors,
    })
  }
  return parsed.data
}
