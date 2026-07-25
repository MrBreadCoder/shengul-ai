import type { ComponentType, ReactNode } from 'react'
import type { IconProps } from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

interface EmptyStateProps {
  icon: ComponentType<IconProps>
  title: string
  /** One sentence telling the operator how to populate this view. */
  description: string
  action?: ReactNode
  className?: string
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps): React.ReactElement {
  return (
    <div
      className={cn(
        'border-hairline bg-surface-sunken animate-rise flex flex-col items-center justify-center',
        'rounded-lg border border-dashed px-6 py-14 text-center',
        className,
      )}
    >
      <Icon size={22} weight="light" className="text-faint" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 max-w-[46ch] text-sm">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  )
}
