import type { Database } from '@/types/database'
import type { MailboxProvider } from './provider'
import { gmailProvider } from './gmail-provider'
import { outlookProvider } from './outlook-provider'

type ProviderName = Database['public']['Enums']['mailbox_provider']

export function getMailboxProvider(provider: ProviderName): MailboxProvider {
  switch (provider) {
    case 'gmail':
      return gmailProvider
    case 'outlook':
      return outlookProvider
    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown mailbox provider: ${String(exhaustive)}`)
    }
  }
}
