import Link from 'next/link'
import { ArrowSquareOut, Robot, User } from '@phosphor-icons/react/dist/ssr'
import { StatusPill } from '@/components/status-dot'
import { KNOWLEDGE_KIND } from '@/lib/ui/status'
import { formatAbsolute, formatRelative } from '@/lib/format'
import type { Database } from '@/types/database'
import { cn } from '@/lib/utils'

type KnowledgeKind = Database['public']['Enums']['knowledge_kind']
type AuthorKind = Database['public']['Enums']['author_kind']

interface KnowledgeItemProps {
  kind: KnowledgeKind
  content: string
  sourceUrl: string | null
  citation: string | null
  createdBy: AuthorKind
  createdAt: string
  now: Date
  /** Rendered on the cross-case knowledge browser, omitted inside a case. */
  caseLink?: { id: string; companyName: string }
  className?: string
}

export function KnowledgeItem({
  kind,
  content,
  sourceUrl,
  citation,
  createdBy,
  createdAt,
  now,
  caseLink,
  className,
}: KnowledgeItemProps): React.ReactElement {
  const isHuman = createdBy === 'human'

  return (
    <article className={cn('border-hairline bg-surface rounded-lg border p-4', className)}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
        <StatusPill meta={KNOWLEDGE_KIND[kind]} />

        <span
          className={cn(
            'inline-flex items-center gap-1 text-[11px]',
            isHuman ? 'text-primary' : 'text-faint',
          )}
          title={isHuman ? 'Answered by a human operator' : 'Gathered by the research agent'}
        >
          {isHuman ? <User size={12} weight="fill" /> : <Robot size={12} weight="light" />}
          {isHuman ? 'Human' : 'Agent'}
        </span>

        {caseLink ? (
          <Link
            href={`/cases/${caseLink.id}`}
            className="text-muted-foreground hover:text-foreground truncate text-[11px] underline underline-offset-2 transition-colors duration-200"
          >
            {caseLink.companyName}
          </Link>
        ) : null}

        <time
          dateTime={createdAt}
          title={formatAbsolute(createdAt)}
          className="text-faint ml-auto shrink-0 text-[11px]"
        >
          {formatRelative(createdAt, now)}
        </time>
      </div>

      <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap">{content}</p>

      {citation || sourceUrl ? (
        <div className="border-hairline mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-3">
          {citation ? <p className="text-faint text-[11px] italic">{citation}</p> : null}
          {sourceUrl ? (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-muted-foreground hover:text-foreground ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] transition-colors duration-200"
            >
              Source
              <ArrowSquareOut size={11} weight="light" />
            </a>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
