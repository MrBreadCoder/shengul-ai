'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FloppyDisk } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ApolloIcpFilters } from '@/lib/apollo/types'
import { CampaignSettingsFields, Field } from '../../campaign-settings-fields'
import { splitCsv, getAllStrings } from '../../campaign-form-utils'

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface EditCampaignFormProps {
  campaignId: string
  clientName: string
  name: string
  valueProp: string
  bookingLink: string | null
  dailyTarget: number
  icp: ApolloIcpFilters
}

export function EditCampaignForm({
  campaignId,
  clientName,
  name,
  valueProp,
  bookingLink,
  dailyTarget,
  icp,
}: EditCampaignFormProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onSubmit(formData: FormData): Promise<void> {
    setState({ status: 'submitting' })

    const employeeMinRaw = formData.get('employeeMin')
    const employeeMaxRaw = formData.get('employeeMax')
    const bookingLinkRaw = formData.get('bookingLink')
    const body = {
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
    }

    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('editCampaignForm.rejected')
        setState({ status: 'error', message })
        toast.error(t('editCampaignForm.saveFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success(t('editCampaignForm.savedToast'))
      router.push('/campaigns')
      router.refresh()
    } catch {
      const message = t('editCampaignForm.networkError')
      setState({ status: 'error', message })
      toast.error(t('editCampaignForm.saveFailedToast'), { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form action={onSubmit} className="border-hairline bg-surface flex flex-col gap-5 rounded-lg border p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="clientNameReadonly" label={t('newCampaignForm.clientLabel')}>
          <Input id="clientNameReadonly" value={clientName} disabled readOnly />
        </Field>

        <Field id="name" label={t('newCampaignForm.nameLabel')}>
          <Input id="name" name="name" required defaultValue={name} placeholder="Q3 mid-market ops" />
        </Field>
      </div>

      <CampaignSettingsFields
        defaultValues={{
          valueProp,
          bookingLink: bookingLink ?? '',
          dailyTarget,
          personTitles: icp.personTitles.join(', '),
          organizationLocations: icp.organizationLocations.join(', '),
          excludeOrganizationLocations: icp.excludeOrganizationLocations.join(', '),
          employeeMin: icp.employeeRangeMin ?? '',
          employeeMax: icp.employeeRangeMax ?? '',
          keywords: icp.keywords.join(', '),
          excludeKeywords: icp.excludeKeywords.join(', '),
          personSeniorities: icp.personSeniorities,
          contactEmailStatuses: icp.contactEmailStatuses,
        }}
      />

      <div className="border-hairline flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <FloppyDisk size={14} weight="bold" />
          {isSubmitting ? t('editCampaignForm.saving') : t('editCampaignForm.saveButton')}
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
