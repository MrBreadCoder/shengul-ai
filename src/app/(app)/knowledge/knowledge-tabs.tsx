'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'

interface KnowledgeTab {
  readonly href: string
  readonly labelKey: 'facts' | 'sources' | 'resources'
  /** `/knowledge` must match exactly, or it stays lit on every sub-route. */
  readonly exact?: boolean
}

const TABS: readonly KnowledgeTab[] = [
  { href: '/knowledge', labelKey: 'facts', exact: true },
  { href: '/knowledge/sources', labelKey: 'sources' },
  { href: '/knowledge/resources', labelKey: 'resources' },
]

export function KnowledgeTabs(): React.ReactElement {
  const pathname = usePathname()
  const t = useTranslations('knowledge')

  return (
    <nav aria-label={t('tabs.ariaLabel')} className="border-hairline flex items-center gap-1 border-b pb-2">
      {TABS.map((tab) => {
        const isActive = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-[13px]',
              'transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
              isActive
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            {t(`tabs.${tab.labelKey}`)}
          </Link>
        )
      })}
    </nav>
  )
}
