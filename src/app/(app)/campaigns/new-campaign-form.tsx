'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from '@/lib/apollo/types'

interface ClientOption {
  id: string
  name: string
}

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

function splitCsv(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const SENIORITY_KEY: Record<(typeof apolloPersonSeniorities)[number], string> = {
  owner: 'seniority.owner',
  founder: 'seniority.founder',
  c_suite: 'seniority.c_suite',
  partner: 'seniority.partner',
  vp: 'seniority.vp',
  head: 'seniority.head',
  director: 'seniority.director',
  manager: 'seniority.manager',
  senior: 'seniority.senior',
  entry: 'seniority.entry',
  intern: 'seniority.intern',
}

const CONTACT_EMAIL_STATUS_KEY: Record<(typeof apolloContactEmailStatuses)[number], string> = {
  verified: 'contactEmailStatus.verified',
  unverified: 'contactEmailStatus.unverified',
  'likely to engage': 'contactEmailStatus.likelyToEngage',
  unavailable: 'contactEmailStatus.unavailable',
}

function getAllStrings(formData: FormData, name: string): string[] {
  return formData.getAll(name).map(String)
}

interface FieldProps {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ id, label, hint, children }: FieldProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-faint text-[11px]">{hint}</p> : null}
    </div>
  )
}

type NewCampaignFormProps = { clients: ClientOption[] } | { fixedClientId: string; fixedClientName: string }

export function NewCampaignForm(props: NewCampaignFormProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const isFixed = 'fixedClientId' in props
  // Radix Select renders a hidden input only when controlled, so the selected
  // client is held in React state rather than read off the form. When the
  // client is fixed by the route, this never changes.
  const [clientId, setClientId] = useState(isFixed ? props.fixedClientId : '')

  async function onSubmit(formData: FormData): Promise<void> {
    if (!clientId) {
      setState({ status: 'error', message: t('newCampaignForm.chooseClientFirst') })
      return
    }
    setState({ status: 'submitting' })

    const employeeMinRaw = formData.get('employeeMin')
    const employeeMaxRaw = formData.get('employeeMax')
    const bookingLinkRaw = formData.get('bookingLink')
    const body = {
      clientId,
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

      <Field
        id="valueProp"
        label={t('newCampaignForm.valuePropLabel')}
        hint={t('newCampaignForm.valuePropHint')}
      >
        <Textarea
          id="valueProp"
          name="valueProp"
          required
          rows={3}
          placeholder="We cut invoice reconciliation time for finance teams running NetSuite."
          className="resize-y"
          toolparamdescription={t('newCampaignForm.valuePropToolParamDescription')}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="bookingLink" label={t('newCampaignForm.bookingLinkLabel')} hint={t('newCampaignForm.bookingLinkHint')}>
          <Input
            id="bookingLink"
            name="bookingLink"
            type="url"
            placeholder="https://cal.com/you/30min"
            toolparamdescription={t('newCampaignForm.bookingLinkToolParamDescription')}
          />
        </Field>

        <Field id="dailyTarget" label={t('newCampaignForm.dailyTargetLabel')} hint={t('newCampaignForm.dailyTargetHint')}>
          <Input
            id="dailyTarget"
            name="dailyTarget"
            type="number"
            defaultValue={50}
            min={1}
            max={100}
            className="tnum"
            toolparamdescription={t('newCampaignForm.dailyTargetToolParamDescription')}
          />
        </Field>
      </div>

      <fieldset className="border-hairline flex flex-col gap-5 border-t pt-5">
        <legend className="sr-only">{t('newCampaignForm.icpLegend')}</legend>
        <p className="text-xs font-medium">{t('newCampaignForm.icpLegend')}</p>

        <Field id="personTitles" label={t('newCampaignForm.personTitlesLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="personTitles"
            name="personTitles"
            placeholder="vp sales, head of revenue, founder"
            toolparamdescription={t('newCampaignForm.personTitlesToolParamDescription')}
          />
        </Field>

        <Field id="organizationLocations" label={t('newCampaignForm.organizationLocationsLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="organizationLocations"
            name="organizationLocations"
            placeholder="united states, united kingdom"
            toolparamdescription={t('newCampaignForm.organizationLocationsToolParamDescription')}
          />
        </Field>

        <Field
          id="excludeOrganizationLocations"
          label={t('newCampaignForm.excludeOrganizationLocationsLabel')}
          hint={t('newCampaignForm.excludeOrganizationLocationsHint')}
        >
          <Input
            id="excludeOrganizationLocations"
            name="excludeOrganizationLocations"
            placeholder="ireland, india"
            toolparamdescription={t('newCampaignForm.excludeOrganizationLocationsToolParamDescription')}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="employeeMin" label={t('newCampaignForm.employeeMinLabel')}>
            <Input
              id="employeeMin"
              name="employeeMin"
              type="number"
              min={1}
              placeholder="50"
              className="tnum"
              toolparamdescription={t('newCampaignForm.employeeMinToolParamDescription')}
            />
          </Field>
          <Field id="employeeMax" label={t('newCampaignForm.employeeMaxLabel')}>
            <Input
              id="employeeMax"
              name="employeeMax"
              type="number"
              min={1}
              placeholder="500"
              className="tnum"
              toolparamdescription={t('newCampaignForm.employeeMaxToolParamDescription')}
            />
          </Field>
        </div>

        <Field id="keywords" label={t('newCampaignForm.keywordsLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="keywords"
            name="keywords"
            placeholder="saas, logistics, fintech"
            toolparamdescription={t('newCampaignForm.keywordsToolParamDescription')}
          />
        </Field>

        <Field
          id="excludeKeywords"
          label={t('newCampaignForm.excludeKeywordsLabel')}
          hint={t('newCampaignForm.excludeKeywordsHint')}
        >
          <Input
            id="excludeKeywords"
            name="excludeKeywords"
            placeholder="staffing, agency, recruiting"
            toolparamdescription={t('newCampaignForm.excludeKeywordsToolParamDescription')}
          />
        </Field>

        <Field id="personSeniorities" label={t('newCampaignForm.personSenioritiesLabel')} hint={t('newCampaignForm.personSenioritiesHint')}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {apolloPersonSeniorities.map((value) => (
              <label key={value} htmlFor={`personSeniorities-${value}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`personSeniorities-${value}`}
                  name="personSeniorities"
                  value={value}
                  toolparamdescription={t('newCampaignForm.personSenioritiesToolParamDescription')}
                />
                {t(SENIORITY_KEY[value] as 'seniority.owner')}
              </label>
            ))}
          </div>
        </Field>

        <Field
          id="contactEmailStatuses"
          label={t('newCampaignForm.contactEmailStatusesLabel')}
          hint={t('newCampaignForm.contactEmailStatusesHint')}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {apolloContactEmailStatuses.map((value) => (
              <label key={value} htmlFor={`contactEmailStatuses-${value}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`contactEmailStatuses-${value}`}
                  name="contactEmailStatuses"
                  value={value}
                  defaultChecked={value === 'verified'}
                  toolparamdescription={t('newCampaignForm.contactEmailStatusesToolParamDescription')}
                />
                {t(CONTACT_EMAIL_STATUS_KEY[value] as 'contactEmailStatus.verified')}
              </label>
            ))}
          </div>
        </Field>
      </fieldset>

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
