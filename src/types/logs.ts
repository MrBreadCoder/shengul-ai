import type { Database } from './database'

export type LogSeverity = Database['public']['Enums']['log_severity']
export type LogSource = Database['public']['Enums']['log_source']

/** Display order, most severe last — used to render filter chips. */
export const LOG_SEVERITIES: readonly LogSeverity[] = ['info', 'warn', 'error'] as const

export const LOG_SOURCES: readonly LogSource[] = [
  'app',
  'pipeline',
  'gemini',
  'apollo',
  'brightdata',
  'mailbox',
  'qstash',
  'db',
  'emailable',
  'crm',
] as const

/**
 * What the Logs tab shows. `problems` is the default view: an operator opening
 * a client wants to know what is broken, not to scroll past every LLM call.
 */
export type LogSeverityFilter = 'problems' | 'errors' | 'all'

export const LOG_SEVERITY_FILTERS: readonly LogSeverityFilter[] = ['problems', 'errors', 'all'] as const

export const SEVERITIES_FOR_FILTER: Record<LogSeverityFilter, LogSeverity[]> = {
  problems: ['warn', 'error'],
  errors: ['error'],
  all: ['info', 'warn', 'error'],
}

/** One row of `events_error_counts`, mapped to camelCase. */
export interface ClientErrorCount {
  clientId: string
  errorCount: number
  warnCount: number
}
