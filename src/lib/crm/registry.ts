import type { CrmProvider, CrmProviderName } from './provider'
import { hubspotProvider } from './hubspot-provider'
import { pipedriveProvider } from './pipedrive-provider'

export function getCrmProvider(provider: CrmProviderName): CrmProvider {
  switch (provider) {
    case 'hubspot':
      return hubspotProvider
    case 'pipedrive':
      return pipedriveProvider
    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown CRM provider: ${String(exhaustive)}`)
    }
  }
}
