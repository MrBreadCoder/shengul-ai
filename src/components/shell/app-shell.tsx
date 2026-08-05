'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { List, SignOut, X } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Nav } from './nav'
import { ThemeToggle } from './theme-toggle'
import { Button } from '@/components/ui/button'
import { CompanyMark } from '@/components/company-mark'

// A client-role user's own company, shown in place of "Shengul AI". `null` (or
// omitted entirely) means: show the default Shengul AI mark — always the case for
// operators, who aren't scoped to a single client.
export interface SidebarBrand {
  name: string
  domain: string | null
  logoUrl: string | null
}

interface AppShellProps {
  role: 'operator' | 'client'
  email: string
  inboxCount: number
  brand?: SidebarBrand | null
  children: ReactNode
}

function Brand({ brand }: { brand?: SidebarBrand | null }): React.ReactElement {
  return (
    <Link href="/crm" className="flex items-center gap-2.5 px-2.5">
      {brand ? (
        <CompanyMark
          name={brand.name}
          domain={brand.domain}
          logoUrl={brand.logoUrl}
          className="size-7 rounded-md text-[13px] font-bold"
        />
      ) : null}
      <span className="truncate text-[13px] font-semibold tracking-tight">{brand?.name ?? 'Shengul AI'}</span>
    </Link>
  )
}

function SidebarBody({
  role,
  email,
  inboxCount,
  brand,
  onNavigate,
}: Omit<AppShellProps, 'children'> & { onNavigate?: () => void }): React.ReactElement {
  const t = useTranslations('nav')
  return (
    <div className="flex h-full flex-col gap-6 py-5">
      <Brand brand={brand} />
      <div className="flex flex-1 flex-col px-2.5">
        <Nav role={role} inboxCount={inboxCount} onNavigate={onNavigate} />
      </div>
      <div className="border-hairline mx-2.5 flex items-center gap-2 border-t pt-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={email}>
            {email}
          </p>
          <p className="text-faint text-[11px] capitalize">{role}</p>
        </div>
        <ThemeToggle />
        {/*
          Deliberately unannotated for WebMCP: it takes no input, and the only
          thing an agent could do with it is end the operator's session — which
          also destroys the agent's own access to every other tool on the page.
        */}
        <form action="/api/auth/signout" method="post">
          <Button
            type="submit"
            variant="ghost"
            size="icon"
            aria-label={t('signOut')}
            title={t('signOut')}
            className="text-muted-foreground hover:text-foreground size-8"
          >
            <SignOut size={16} weight="light" />
          </Button>
        </form>
      </div>
    </div>
  )
}

export function AppShell({ role, email, inboxCount, brand, children }: AppShellProps): React.ReactElement {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const pathname = usePathname()
  const [drawerPathname, setDrawerPathname] = useState(pathname)
  const reduceMotion = useReducedMotion()

  // Any navigation closes the drawer, including browser back/forward. Adjusted
  // during render rather than in an effect so the drawer never paints once in
  // the wrong state on the new route.
  if (pathname !== drawerPathname) {
    setDrawerPathname(pathname)
    setIsDrawerOpen(false)
  }

  useEffect(() => {
    if (!isDrawerOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsDrawerOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isDrawerOpen])

  return (
    <div className="min-h-[100dvh]">
      {/* Desktop rail. Fixed so long boards scroll under a stable nav. */}
      <aside className="border-hairline bg-surface-sunken fixed inset-y-0 left-0 z-30 hidden w-60 border-r lg:block">
        <SidebarBody role={role} email={email} inboxCount={inboxCount} brand={brand} />
      </aside>

      {/* Mobile bar. backdrop-blur is safe here: the element is fixed. */}
      <header className="border-hairline bg-background/80 fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b px-3 backdrop-blur-xl lg:hidden">
        <Brand brand={brand} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => setIsDrawerOpen(true)}
          aria-label="Open navigation"
          aria-expanded={isDrawerOpen}
          className="size-9"
        >
          <List size={18} weight="light" />
        </Button>
      </header>

      <AnimatePresence>
        {isDrawerOpen ? (
          <>
            <motion.button
              type="button"
              aria-label="Close navigation"
              onClick={() => setIsDrawerOpen(false)}
              className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm lg:hidden"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Navigation"
              className="bg-surface-sunken border-hairline fixed inset-y-0 left-0 z-50 w-64 border-r lg:hidden"
              initial={reduceMotion ? false : { x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => setIsDrawerOpen(false)}
                aria-label="Close navigation"
                className="absolute top-4 right-3 size-8"
              >
                <X size={16} weight="light" />
              </Button>
              <SidebarBody
                role={role}
                email={email}
                inboxCount={inboxCount}
                brand={brand}
                onNavigate={() => setIsDrawerOpen(false)}
              />
            </motion.div>
          </>
        ) : null}
      </AnimatePresence>

      <main className="pt-14 lg:pt-0 lg:pl-60">
        <div className="mx-auto w-full max-w-[1400px] px-4 py-8 md:px-8 md:py-10">{children}</div>
      </main>
    </div>
  )
}
