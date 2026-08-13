import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { CookiePreferencesButton } from '@/components/cookie-preferences-button'
import { publicEnv } from '@/lib/env-public'
import { LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'
import type { AppLocale } from '@/types/i18n'
import { BOOKING_URL } from './constants'

const LINK_CLASS =
  'text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]'

/** Language autonyms are never translated — "English" and "Türkçe" read the
 *  same regardless of which language the page is currently showing. */
const LANGUAGE_LABEL: Record<AppLocale, string> = { en: 'English', tr: 'Türkçe' }

interface SiteFooterProps {
  readonly locale: AppLocale
  /** Only the marketing home page (`/`, `/tr`) has a translated counterpart
   *  to switch to — the legal pages (out of scope) never pass this. */
  readonly showLanguageSwitcher?: boolean
}

export async function SiteFooter({
  locale,
  showLanguageSwitcher = false,
}: SiteFooterProps): Promise<React.ReactElement> {
  const t = await getTranslations({ locale, namespace: 'marketing.footer' })
  // Read per render, not at module scope: a long-lived server process would
  // otherwise keep printing the year it booted in.
  const year = new Date().getFullYear()

  return (
    <footer className="px-4 pb-12">
      <div className="mx-auto max-w-[1180px] border-t border-[var(--l-hairline)] pt-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center">
            <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
          </div>

          {/* Root-relative anchors, not bare fragments: this footer renders on
              the legal pages too, where `#how` would scroll to nothing. */}
          <nav
            aria-label={t('ariaLabelFooter')}
            className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[13px]"
          >
            <Link href="/#how" className={LINK_CLASS}>
              {t('linkHow')}
            </Link>
            <Link href="/#privacy" className={LINK_CLASS}>
              {t('linkPrivacy')}
            </Link>
            <Link href="/login" className={LINK_CLASS}>
              {t('signIn')}
            </Link>
            <a href={BOOKING_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              {t('bookMeeting')}
            </a>
            {showLanguageSwitcher && (
              <span className="flex items-center gap-3">
                <a
                  href="/api/locale?locale=en"
                  aria-current={locale === 'en' ? 'true' : undefined}
                  className={locale === 'en' ? 'text-[var(--l-text)]' : LINK_CLASS}
                >
                  {LANGUAGE_LABEL.en}
                </a>
                <a
                  href="/api/locale?locale=tr"
                  aria-current={locale === 'tr' ? 'true' : undefined}
                  className={locale === 'tr' ? 'text-[var(--l-text)]' : LINK_CLASS}
                >
                  {LANGUAGE_LABEL.tr}
                </a>
              </span>
            )}
          </nav>
        </div>

        <nav
          aria-label={t('ariaLabelLegal')}
          className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[var(--l-hairline)] pt-8 text-[12px]"
        >
          {LEGAL_DOCUMENTS.map((document) => (
            <Link key={document.slug} href={legalDocumentPath(document.slug)} className={LINK_CLASS}>
              {document.title}
            </Link>
          ))}
          {publicEnv.NEXT_PUBLIC_GTM_ID !== undefined && (
            <CookiePreferencesButton className={LINK_CLASS} />
          )}
        </nav>

        <p className="mt-8 text-[12px] text-[var(--l-faint)]">{t('copyright', { year })}</p>
      </div>
    </footer>
  )
}
