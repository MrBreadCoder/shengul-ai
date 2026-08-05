import { GoogleLogo, MicrosoftOutlookLogo, Plus } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { ConnectSmtpDialog } from './connect-smtp-dialog'

const OAUTH_PROVIDERS = [
  { href: '/api/mailboxes/google/connect', label: 'Gmail', icon: GoogleLogo },
  { href: '/api/mailboxes/outlook/connect', label: 'Outlook', icon: MicrosoftOutlookLogo },
] as const

export async function ConnectButtons(): Promise<React.ReactElement> {
  const t = await getTranslations('settings')
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {OAUTH_PROVIDERS.map(({ href, label, icon: Icon }) => (
        // A full page navigation into the OAuth consent screen, so this is an
        // anchor rather than a button with a click handler.
        <a
          key={href}
          href={href}
          className="border-hairline bg-surface hover:border-hairline-strong group flex items-center gap-3 rounded-lg border p-4 transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.99]"
        >
          <span className="bg-accent text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
            <Icon size={18} weight="light" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{t('connectProvider', { provider: label })}</span>
            <span className="text-faint block text-[11px]">{t('connectHint')}</span>
          </span>
          <Plus
            size={15}
            weight="light"
            className="text-faint group-hover:text-foreground shrink-0 transition-colors duration-200"
          />
        </a>
      ))}
      {/* SMTP has no consent screen, so it collects credentials in a dialog
          instead of navigating away. */}
      <ConnectSmtpDialog />
    </div>
  )
}
