'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { TimeOfDayInput } from '@/components/ui/time-of-day-input'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from '@/lib/apollo/types'

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

const TIMEZONE_OPTIONS: readonly string[] = Intl.supportedValuesOf('timeZone')
const NATIVE_SELECT_CLASSNAME =
  'border-input bg-transparent dark:bg-input/30 h-9 w-full min-w-0 rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

interface FieldProps {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}

export function Field({ id, label, hint, children }: FieldProps): React.ReactElement {
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

export interface CampaignSettingsDefaults {
  valueProp: string
  bookingLink: string
  dailyTarget: number
  contactsPerCompany: number
  personTitles: string
  organizationLocations: string
  excludeOrganizationLocations: string
  employeeMin: number | ''
  employeeMax: number | ''
  keywords: string
  excludeKeywords: string
  personSeniorities: readonly string[]
  contactEmailStatuses: readonly string[]
  discoverTime: string
  discoverTimezone: string
}

interface CampaignSettingsFieldsProps {
  defaultValues: CampaignSettingsDefaults
}

// Shared between NewCampaignForm and EditCampaignForm: value prop, booking
// link, daily target, and the full ICP fieldset are identical in both create
// and edit — only the surrounding <form> (client selector vs. fixed client,
// submit target, submit label) differs between the two callers.
export function CampaignSettingsFields({ defaultValues }: CampaignSettingsFieldsProps): React.ReactElement {
  const t = useTranslations('campaigns')
  // Uncontrolled everywhere else in this component — FormData is read
  // straight off the DOM on submit. discoverTime is the one exception: it's
  // driven by TimeOfDayInput's two <select> elements, so it needs state to
  // combine them into a single "HH:mm" string for the hidden field below.
  const [discoverTime, setDiscoverTime] = useState(defaultValues.discoverTime)

  return (
    <>
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
          defaultValue={defaultValues.valueProp}
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
            defaultValue={defaultValues.bookingLink}
            placeholder="https://cal.com/you/30min"
            toolparamdescription={t('newCampaignForm.bookingLinkToolParamDescription')}
          />
        </Field>

        <Field id="dailyTarget" label={t('newCampaignForm.dailyTargetLabel')} hint={t('newCampaignForm.dailyTargetHint')}>
          <Input
            id="dailyTarget"
            name="dailyTarget"
            type="number"
            defaultValue={defaultValues.dailyTarget}
            min={1}
            max={100}
            className="tnum"
            toolparamdescription={t('newCampaignForm.dailyTargetToolParamDescription')}
          />
        </Field>

        <Field
          id="contactsPerCompany"
          label={t('newCampaignForm.contactsPerCompanyLabel')}
          hint={t('newCampaignForm.contactsPerCompanyHint')}
        >
          <Input
            id="contactsPerCompany"
            name="contactsPerCompany"
            type="number"
            defaultValue={defaultValues.contactsPerCompany}
            min={1}
            max={10}
            className="tnum"
            toolparamdescription={t('newCampaignForm.contactsPerCompanyToolParamDescription')}
          />
        </Field>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="discoverTime"
          label={t('newCampaignForm.discoverTimeLabel')}
          hint={t('newCampaignForm.discoverTimeHint')}
        >
          <input
            type="hidden"
            name="discoverTime"
            value={discoverTime}
            toolparamdescription={t('newCampaignForm.discoverTimeToolParamDescription')}
          />
          <TimeOfDayInput
            value={discoverTime}
            onChange={setDiscoverTime}
            hourAriaLabel={t('newCampaignForm.discoverTimeHourAriaLabel')}
            minuteAriaLabel={t('newCampaignForm.discoverTimeMinuteAriaLabel')}
            className={NATIVE_SELECT_CLASSNAME}
          />
        </Field>

        <Field id="discoverTimezone" label={t('newCampaignForm.discoverTimezoneLabel')}>
          <select
            id="discoverTimezone"
            name="discoverTimezone"
            defaultValue={defaultValues.discoverTimezone}
            className={NATIVE_SELECT_CLASSNAME}
            toolparamdescription={t('newCampaignForm.discoverTimezoneToolParamDescription')}
          >
            <option value="">{t('newCampaignForm.discoverTimezoneInheritOption')}</option>
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <fieldset className="border-hairline flex flex-col gap-5 border-t pt-5">
        <legend className="sr-only">{t('newCampaignForm.icpLegend')}</legend>
        <p className="text-xs font-medium">{t('newCampaignForm.icpLegend')}</p>

        <Field id="personTitles" label={t('newCampaignForm.personTitlesLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="personTitles"
            name="personTitles"
            defaultValue={defaultValues.personTitles}
            placeholder="vp sales, head of revenue, founder"
            toolparamdescription={t('newCampaignForm.personTitlesToolParamDescription')}
          />
        </Field>

        <Field id="organizationLocations" label={t('newCampaignForm.organizationLocationsLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="organizationLocations"
            name="organizationLocations"
            defaultValue={defaultValues.organizationLocations}
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
            defaultValue={defaultValues.excludeOrganizationLocations}
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
              defaultValue={defaultValues.employeeMin}
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
              defaultValue={defaultValues.employeeMax}
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
            defaultValue={defaultValues.keywords}
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
            defaultValue={defaultValues.excludeKeywords}
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
                  defaultChecked={defaultValues.personSeniorities.includes(value)}
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
                  defaultChecked={defaultValues.contactEmailStatuses.includes(value)}
                  toolparamdescription={t('newCampaignForm.contactEmailStatusesToolParamDescription')}
                />
                {t(CONTACT_EMAIL_STATUS_KEY[value] as 'contactEmailStatus.verified')}
              </label>
            ))}
          </div>
        </Field>
      </fieldset>
    </>
  )
}
