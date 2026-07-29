import { ArrowBendUpLeft, PaperPlaneTilt } from '@phosphor-icons/react/dist/ssr'
import { StatusPill } from '@/components/status-dot'
import { EMAIL_STATUS } from '@/lib/ui/status'
import { formatAbsolute, formatRelative } from '@/lib/format'
import type { Database } from '@/types/database'
import { cn } from '@/lib/utils'

type EmailDirection = Database['public']['Enums']['email_direction']
type EmailStatus = Database['public']['Enums']['email_status']

/** Bodies longer than this collapse behind a native disclosure. */
const CLAMP_CHARS = 900

interface EmailMessageProps {
  direction: EmailDirection
  status: EmailStatus
  subject: string | null
  body: string | null
  sequenceStep: number | null
  /** `sent_at` when the mail went out, otherwise `created_at`. */
  timestamp: string
  now: Date
  /** Outbound only: true when a person wrote it, false/absent when the agent did. */
  sentByHuman?: boolean
  className?: string
}

export function EmailMessage({
  direction,
  status,
  subject,
  body,
  sequenceStep,
  timestamp,
  now,
  sentByHuman = false,
  className,
}: EmailMessageProps): React.ReactElement {
  const isInbound = direction === 'inbound'
  const text = body ?? ''
  const isLong = text.length > CLAMP_CHARS

  return (
    <article
      className={cn(
        'border-hairline rounded-lg border',
        // Inbound mail is the signal an operator scans for, so it gets the
        // raised surface and an accent edge; outbound sits quieter.
        isInbound ? 'bg-surface-raised border-l-primary/50 border-l-2' : 'bg-surface',
        className,
      )}
    >
      <header className="border-hairline flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
        <span
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-md',
            isInbound ? 'bg-primary/15 text-primary' : 'bg-accent text-muted-foreground',
          )}
        >
          {isInbound ? (
            <ArrowBendUpLeft size={13} weight="bold" />
          ) : (
            <PaperPlaneTilt size={13} weight="bold" />
          )}
        </span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{subject ?? '(no subject)'}</p>
          <p className="text-faint text-[11px]">
            {isInbound ? 'Reply received' : sentByHuman ? 'Sent by a person' : 'Sent by agent'}
            {sequenceStep !== null ? ` · step ${sequenceStep}` : ''}
          </p>
        </div>

        <StatusPill meta={EMAIL_STATUS[status]} />
        <time
          dateTime={timestamp}
          title={formatAbsolute(timestamp)}
          className="text-faint shrink-0 text-[11px]"
        >
          {formatRelative(timestamp, now)}
        </time>
      </header>

      {text.length === 0 ? (
        <p className="text-faint px-4 py-3 text-sm italic">No body recorded.</p>
      ) : isLong ? (
        <details className="group">
          <summary
            className={cn(
              'text-muted-foreground cursor-pointer list-none px-4 py-3 text-sm leading-relaxed',
              'whitespace-pre-wrap group-open:hidden',
            )}
          >
            {text.slice(0, CLAMP_CHARS).trimEnd()}
            <span className="text-primary mt-2 block text-xs font-medium">Show full message</span>
          </summary>
          <div className="text-muted-foreground px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
            {text}
          </div>
        </details>
      ) : (
        <div className="text-muted-foreground px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      )}
    </article>
  )
}
