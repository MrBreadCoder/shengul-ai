'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { MailboxOption } from '@/lib/db/mailboxes'
import { CampaignSettingsFields, Field } from './campaign-settings-fields'
import { splitCsv, getAllStrings } from './campaign-form-utils'

interface ClientOption {
  id: string
  name: string
}

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

type NewCampaignFormProps =
  | { clients: ClientOption[]; mailboxesByClientId: Record<string, MailboxOption[]> }
  | { fixedClientId: string; fixedClientName: string; mailboxes: MailboxOption[] }

export function NewCampaignForm(props: NewCampaignFormProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const isFixed = 'fixedClientId' in props
  // Radix Select renders a hidden input only when controlled, so the selected
  // client is held in React state rather than read off the form. When the
  // client is fixed by the route, this never changes.
  const [clientId, setClientId] = useState(isFixed ? props.fixedClientId : '')
  // Mailbox options depend on which client is selected — when the client
  // picker is visible, switching it must re-render the checkbox list against
  // that client's own mailboxes, not the previous client's.
  const mailboxes = isFixed ? props.mailboxes : (props.mailboxesByClientId[clientId] ?? [])

  async function onSubmit(formData: FormData): Promise<void> {
    if (!clientId) {
      setState({ status: 'error', message: t('newCampaignForm.chooseClientFirst') })
      return
    }
    setState({ status: 'submitting' })

    const employeeMinRaw = formData.get('employeeMin')
    const employeeMaxRaw = formData.get('employeeMax')
    const bookingLinkRaw = formData.get('bookingLink')
    const signatureNameRaw = formData.get('signatureName')
    const signatureTitleRaw = formData.get('signatureTitle')
    const phoneRaw = formData.get('phone')
    const addressRaw = formData.get('address')
    const body = {
      clientId,
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      contactsPerCompany: Number(formData.get('contactsPerCompany') ?? 2),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
      discoverTime: formData.get('discoverTime') ? String(formData.get('discoverTime')) : null,
      discoverTimezone: formData.get('discoverTimezone') ? String(formData.get('discoverTimezone')) : null,
      mailboxIds: getAllStrings(formData, 'mailboxIds'),
      signatureName: signatureNameRaw ? String(signatureNameRaw) : null,
      signatureTitle: signatureTitleRaw ? String(signatureTitleRaw) : null,
      phone: phoneRaw ? String(phoneRaw) : null,
      address: addressRaw ? String(addressRaw) : null,
    }

    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('newCampaignForm.rejected')
        setState({ status: 'error', message })
        toast.error(t('newCampaignForm.createFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success(t('newCampaignForm.createdToast'))
      // Server Components hold the campaign list, so refresh rather than reload.
      router.refresh()
    } catch {
      const message = t('newCampaignForm.networkError')
      setState({ status: 'error', message })
      toast.error(t('newCampaignForm.createFailedToast'), { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form
      action={onSubmit}
      // Declarative WebMCP: an agent may fill this in, but the operator presses
      // the button. No `toolautosubmit` — see `@/types/webmcp`.
      toolname="createCampaign"
      tooldescription={t('newCampaignForm.toolDescription')}
      className="border-hairline bg-surface flex flex-col gap-5 rounded-lg border p-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {isFixed ? null : (
          <Field id="clientId" label={t('newCampaignForm.clientLabel')}>
            {/* `name` makes Radix's hidden native select a named required field,
                which is what an agent (and Lighthouse) looks for. The submit
                handler still reads `clientId` from state. */}
            <Select value={clientId} onValueChange={setClientId} name="clientId" required>
              <SelectTrigger id="clientId" className="w-full">
                <SelectValue placeholder={t('newCampaignForm.clientPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {props.clients.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        <Field id="name" label={t('newCampaignForm.nameLabel')}>
          <Input
            id="name"
            name="name"
            required
            placeholder="Q3 mid-market ops"
            toolparamdescription={t('newCampaignForm.nameToolParamDescription')}
          />
        </Field>
      </div>

      <CampaignSettingsFields
        mailboxes={mailboxes}
        defaultValues={{
          valueProp: '',
          bookingLink: '',
          dailyTarget: 50,
          contactsPerCompany: 2,
          personTitles: '',
          organizationLocations: '',
          excludeOrganizationLocations: '',
          employeeMin: '',
          employeeMax: '',
          keywords: '',
          excludeKeywords: '',
          personSeniorities: [],
          contactEmailStatuses: ['verified'],
          discoverTime: '',
          discoverTimezone: '',
          mailboxIds: [],
          signatureName: '',
          signatureTitle: '',
          phone: '',
          address: '',
        }}
      />

      <div className="border-hairline flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <Plus size={14} weight="bold" />
          {isSubmitting ? t('newCampaignForm.creating') : t('newCampaignForm.createButton')}
        </Button>
        {state.status === 'error' ? (
          <span role="alert" className="text-destructive text-xs">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  )
}
