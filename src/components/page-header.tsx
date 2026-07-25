import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface PageHeaderProps {
  title: string
  description?: string
  /** Right-aligned controls: filters, primary action, live indicator. */
  actions?: ReactNode
  /** Breadcrumb or back link rendered above the title. */
  above?: ReactNode
  className?: string
}

export function PageHeader({
  title,
  description,
  actions,
  above,
  className,
}: PageHeaderProps): React.ReactElement {
  return (
    <header className={cn('flex flex-col gap-4 md:flex-row md:items-end md:justify-between', className)}>
      <div className="min-w-0">
        {above ? <div className="mb-2">{above}</div> : null}
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="text-muted-foreground mt-1.5 max-w-[70ch] text-sm">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

interface SectionProps {
  title: string
  /** Right-aligned per-section controls or a count. */
  aside?: ReactNode
  children: ReactNode
  className?: string
}

export function Section({ title, aside, children, className }: SectionProps): React.ReactElement {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside ? <div className="text-muted-foreground text-xs">{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}
