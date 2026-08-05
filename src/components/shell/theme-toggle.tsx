'use client'

import { Moon, Sun } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

const STORAGE_KEY = 'ai-b2b-theme'

/**
 * Holds no React state: the current theme lives in the `dark` class on <html>,
 * which the no-flash script sets before first paint. Reading it at click time
 * and letting CSS pick the icon keeps the button correct on the very first
 * render, with no hydration mismatch and no effect.
 */
export function ThemeToggle(): React.ReactElement {
  const t = useTranslations('common')
  const toggle = (): void => {
    const isDark = document.documentElement.classList.toggle('dark')
    try {
      window.localStorage.setItem(STORAGE_KEY, isDark ? 'dark' : 'light')
    } catch {
      // Private browsing blocks writes. The theme still applies for this tab.
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={t('toggleTheme')}
      title={t('toggleTheme')}
      className="text-muted-foreground hover:text-foreground size-8"
    >
      <Sun size={16} weight="light" className="hidden dark:block" />
      <Moon size={16} weight="light" className="block dark:hidden" />
    </Button>
  )
}
