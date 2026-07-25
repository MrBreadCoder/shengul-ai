'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ComponentType } from 'react'
import {
  ChartLineUp,
  Envelope,
  Gear,
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
  readonly label: string
  readonly icon: ComponentType<IconProps>
  /** Operator-only destinations are hidden from client-role users entirely. */
  readonly operatorOnly?: boolean
}

const PRIMARY_NAV: readonly NavItem[] = [
  { href: '/crm', label: 'Pipeline', icon: Kanban },
  { href: '/inbox', label: 'Inbox', icon: Tray },
  { href: '/mail', label: 'Mail', icon: Envelope },
  { href: '/knowledge', label: 'Knowledge', icon: Stack },
  { href: '/analytics', label: 'Analytics', icon: ChartLineUp },
]

const SECONDARY_NAV: readonly NavItem[] = [
  { href: '/clients', label: 'Clients', icon: Buildings, operatorOnly: true },
  { href: '/campaigns', label: 'Campaigns', icon: Lightning, operatorOnly: true },
  { href: '/settings', label: 'Settings', icon: Gear },
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

  const renderItem = (item: NavItem): React.ReactElement | null => {
    if (item.operatorOnly && role !== 'operator') return null
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
        <span className="truncate">{item.label}</span>
        {badge !== null ? (
          <span
            className="bg-primary/15 text-primary tnum ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
            aria-label={`${badge} awaiting you`}
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
