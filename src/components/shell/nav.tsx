'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType } from 'react'
import { useTranslations } from 'next-intl'
import {
  ChartLineUp,
  Envelope,
  Gear,
  House,
  Kanban,
  Lightning,
  type IconProps,
  Stack,
  Buildings,
  Tray,
} from '@phosphor-icons/react'
import { cn } from '@/lib/utils'

interface NavItem {
  readonly href: string
  readonly labelKey:
    | 'home'
    | 'pipeline'
    | 'inbox'
    | 'mail'
    | 'knowledge'
    | 'analytics'
    | 'clients'
    | 'campaigns'
    | 'settings'
  readonly icon: ComponentType<IconProps>
  /** Operator-only destinations are hidden from client-role users entirely. */
  readonly operatorOnly?: boolean
  /** Client-only destinations are hidden from operators entirely (the inverse of operatorOnly). */
  readonly clientOnly?: boolean
}

const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/home', labelKey: 'home', icon: House, clientOnly: true },
  { href: '/crm', labelKey: 'pipeline', icon: Kanban },
  { href: '/inbox', labelKey: 'inbox', icon: Tray },
  { href: '/mail', labelKey: 'mail', icon: Envelope },
  { href: '/knowledge', labelKey: 'knowledge', icon: Stack },
  { href: '/analytics', labelKey: 'analytics', icon: ChartLineUp },
]

const SECONDARY_NAV: readonly NavItem[] = [
  { href: '/clients', labelKey: 'clients', icon: Buildings, operatorOnly: true },
  { href: '/campaigns', labelKey: 'campaigns', icon: Lightning, operatorOnly: true },
  { href: '/settings', labelKey: 'settings', icon: Gear },
]

interface NavProps {
  role: 'operator' | 'client'
  /** Count of items awaiting a human decision, shown against Inbox. */
  inboxCount: number
  onNavigate?: () => void
}

function isActive(pathname: string, href: string): boolean {
  if (pathname === href) return true
  // `/cases/<id>` belongs to the Pipeline section, so the parent stays lit.
  if (href === '/crm') return pathname.startsWith('/cases')
  return pathname.startsWith(`${href}/`)
}

export function Nav({ role, inboxCount, onNavigate }: NavProps): React.ReactElement {
  const pathname = usePathname()
  const t = useTranslations('nav')

  const renderItem = (item: NavItem): React.ReactElement | null => {
    if (item.operatorOnly && role !== 'operator') return null
    if (item.clientOnly && role !== 'client') return null
    const active = isActive(pathname, item.href)
    const Icon = item.icon
    const badge = item.href === '/inbox' && inboxCount > 0 ? inboxCount : null

    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'group relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm',
          'transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
          active
            ? 'bg-accent text-accent-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        )}
      >
        <Icon size={17} weight={active ? 'fill' : 'light'} className="shrink-0" />
        <span className="truncate">{t(item.labelKey)}</span>
        {badge !== null ? (
          <span
            className="bg-primary/15 text-primary tnum ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            aria-label={t('awaitingYou', { count: badge })}
          >
            {badge}
          </span>
        ) : null}
      </Link>
    )
  }

  return (
    <nav aria-label="Main" className="flex flex-1 flex-col gap-6">
      <ul className="flex flex-col gap-0.5">
        {PRIMARY_NAV.map((item) => (
          <li key={item.href}>{renderItem(item)}</li>
        ))}
      </ul>
      <ul className="mt-auto flex flex-col gap-0.5">
        {SECONDARY_NAV.map((item) => (
          <li key={item.href}>{renderItem(item)}</li>
        ))}
      </ul>
    </nav>
  )
}
