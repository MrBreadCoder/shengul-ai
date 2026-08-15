'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { TimeOfDayInput } from '@/components/ui/time-of-day-input'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from '@/lib/apollo/types'
import type { MailboxOption } from '@/lib/db/mailboxes'
import type { EmailTemplateRow } from '@/lib/db/email-templates'

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
  mailboxIds: readonly string[]
  // Per-campaign signature overrides — empty string means "no override,
  // inherit the client's value", same convention as discoverTime/
  // discoverTimezone above. See resolveSignatureContext in
  // src/lib/pipeline/signature.ts.
  signatureName: string
  signatureTitle: string
  phone: string
  address: string
  // Per-campaign email template override — empty string means "no override,
  // inherit the client's template", same convention as discoverTimezone/
  // signature fields above. See resolveEmailTemplate in
  // src/lib/pipeline/write.ts.
  emailTemplateId: string
}

interface CampaignSettingsFieldsProps {
  defaultValues: CampaignSettingsDefaults
  // The client's available mailboxes to pick from — not a "default value"
  // like the rest of the fieldset, since it's the option list rather than the
  // current selection. Empty when the client has none connected yet.
  mailboxes: MailboxOption[]
  // Every email template available to pick from for the override below —
  // same "option list, not a default value" reasoning as mailboxes.
  emailTemplates: EmailTemplateRow[]
}

// Shared between NewCampaignForm and EditCampaignForm: value prop, booking
// link, daily target, and the full ICP fieldset are identical in both create
// and edit — only the surrounding <form> (client selector vs. fixed client,
// submit target, submit label) differs between the two callers.
export function CampaignSettingsFields({ defaultValues, mailboxes, emailTemplates }: CampaignSettingsFieldsProps): React.ReactElement {
  const t = useTranslations('campaigns')
  // Uncontrolled everywhere else in this component — FormData is read
  // straight off the DOM on submit. discoverTime is the one exception: it's
  // driven by TimeOfDayInput's two <select> elements, so it needs state to
  // combine them into a single "HH:mm" string for the hidden field below.
  const [discoverTime, setDiscoverTime] = useState(defaultValues.discoverTime)

  return (
    <>
      <Field id="mailboxIds" label={t('newCampaignForm.mailboxesLabel')} hint={t('newCampaignForm.mailboxesHint')}>
        {mailboxes.length === 0 ? (
          <p className="text-faint text-xs">{t('newCampaignForm.mailboxesEmpty')}</p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {mailboxes.map((mailbox) => (
              <label key={mailbox.id} htmlFor={`mailboxIds-${mailbox.id}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`mailboxIds-${mailbox.id}`}
                  name="mailboxIds"
                  value={mailbox.id}
                  defaultChecked={defaultValues.mailboxIds.includes(mailbox.id)}
                  toolparamdescription={t('newCampaignForm.mailboxesToolParamDescription')}
                />
                {mailbox.email_address}
              </label>
            ))}
          </div>
        )}
      </Field>

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
        <legend className="sr-only">{t('newCampaignForm.signatureLegend')}</legend>
        <p className="text-xs font-medium">{t('newCampaignForm.signatureLegend')}</p>
        <p className="text-faint text-[11px]">{t('newCampaignForm.signatureHint')}</p>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="campaignSignatureName" label={t('newCampaignForm.signatureNameLabel')}>
            <Input
              id="campaignSignatureName"
              name="signatureName"
              defaultValue={defaultValues.signatureName}
              placeholder="John Smith"
              toolparamdescription={t('newCampaignForm.signatureNameToolParamDescription')}
            />
          </Field>
          <Field id="campaignSignatureTitle" label={t('newCampaignForm.signatureTitleLabel')}>
            <Input
              id="campaignSignatureTitle"
              name="signatureTitle"
              defaultValue={defaultValues.signatureTitle}
              placeholder="Sales Director"
              toolparamdescription={t('newCampaignForm.signatureTitleToolParamDescription')}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            id="campaignPhone"
            label={t('newCampaignForm.phoneLabel')}
            hint={t('newCampaignForm.phoneHint')}
          >
            <Input
              id="campaignPhone"
              name="phone"
              defaultValue={defaultValues.phone}
              placeholder="+1 555 123 4567"
              toolparamdescription={t('newCampaignForm.phoneToolParamDescription')}
            />
          </Field>
          <Field id="campaignAddress" label={t('newCampaignForm.addressLabel')}>
            <Input
              id="campaignAddress"
              name="address"
              defaultValue={defaultValues.address}
              placeholder="123 Main St, Istanbul, Turkey"
              toolparamdescription={t('newCampaignForm.addressToolParamDescription')}
            />
          </Field>
        </div>
      </fieldset>

      <Field
        id="emailTemplateId"
        label={t('newCampaignForm.emailTemplateLabel')}
        hint={t('newCampaignForm.emailTemplateHint')}
      >
        <select
          id="emailTemplateId"
          name="emailTemplateId"
          defaultValue={defaultValues.emailTemplateId}
          className={NATIVE_SELECT_CLASSNAME}
          toolparamdescription={t('newCampaignForm.emailTemplateToolParamDescription')}
        >
          <option value="">{t('newCampaignForm.emailTemplateInheritOption')}</option>
          {emailTemplates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </Field>

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
