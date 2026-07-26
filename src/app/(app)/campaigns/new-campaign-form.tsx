'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from '@phosphor-icons/react'
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
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const isFixed = 'fixedClientId' in props
  // Radix Select renders a hidden input only when controlled, so the selected
  // client is held in React state rather than read off the form. When the
  // client is fixed by the route, this never changes.
  const [clientId, setClientId] = useState(isFixed ? props.fixedClientId : '')

  async function onSubmit(formData: FormData): Promise<void> {
    if (!clientId) {
      setState({ status: 'error', message: 'Choose a client first.' })
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
            : 'The server rejected the campaign.'
        setState({ status: 'error', message })
        toast.error('Could not create campaign', { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success('Campaign created')
      // Server Components hold the campaign list, so refresh rather than reload.
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Could not create campaign', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form
      action={onSubmit}
      // Declarative WebMCP: an agent may fill this in, but the operator presses
      // the button. No `toolautosubmit` — see `@/types/webmcp`.
      toolname="createCampaign"
      tooldescription="Sets up an outreach campaign: which client it runs for, what it promises, and the ideal customer profile the daily Apollo discovery run searches against."
      className="border-hairline bg-surface flex flex-col gap-5 rounded-lg border p-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {isFixed ? null : (
          <Field id="clientId" label="Client">
            {/* `name` makes Radix's hidden native select a named required field,
                which is what an agent (and Lighthouse) looks for. The submit
                handler still reads `clientId` from state. */}
            <Select value={clientId} onValueChange={setClientId} name="clientId" required>
              <SelectTrigger id="clientId" className="w-full">
                <SelectValue placeholder="Select a client" />
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

        <Field id="name" label="Campaign name">
          <Input
            id="name"
            name="name"
            required
            placeholder="Q3 mid-market ops"
            toolparamdescription="An internal label for this campaign. Never shown to a prospect."
          />
        </Field>
      </div>

      <Field
        id="valueProp"
        label="Value proposition"
        hint="The agent grounds every first email on this. Be specific about the outcome, not the product."
      >
        <Textarea
          id="valueProp"
          name="valueProp"
          required
          rows={3}
          placeholder="We cut invoice reconciliation time for finance teams running NetSuite."
          className="resize-y"
          toolparamdescription="One or two sentences naming the outcome the client delivers, not the product. Every first email is grounded on this, so vague copy produces vague email."
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="bookingLink" label="Booking link" hint="Optional. Used on a hot handoff.">
          <Input
            id="bookingLink"
            name="bookingLink"
            type="url"
            placeholder="https://cal.com/you/30min"
            toolparamdescription="Optional. The scheduler URL offered when a prospect turns into a real decision. Leave blank to hand those threads straight to the operator instead."
          />
        </Field>

        <Field id="dailyTarget" label="Daily discovery target" hint="Apollo records pulled per day.">
          <Input
            id="dailyTarget"
            name="dailyTarget"
            type="number"
            defaultValue={50}
            min={1}
            max={100}
            className="tnum"
            toolparamdescription="How many new people to pull from Apollo each day, 1 to 100. Defaults to 50."
          />
        </Field>
      </div>

      <fieldset className="border-hairline flex flex-col gap-5 border-t pt-5">
        <legend className="sr-only">Ideal customer profile</legend>
        <p className="text-xs font-medium">Ideal customer profile</p>

        <Field id="personTitles" label="Target titles" hint="Comma-separated.">
          <Input
            id="personTitles"
            name="personTitles"
            placeholder="vp sales, head of revenue, founder"
            toolparamdescription="Comma-separated job titles to search for. Broad titles find more people; narrow ones find better ones."
          />
        </Field>

        <Field id="organizationLocations" label="Company locations" hint="Comma-separated.">
          <Input
            id="organizationLocations"
            name="organizationLocations"
            placeholder="united states, united kingdom"
            toolparamdescription="Comma-separated countries or regions the target company is headquartered in."
          />
        </Field>

        <Field
          id="excludeOrganizationLocations"
          label="Exclude company locations"
          hint="Comma-separated. Companies headquartered here are skipped."
        >
          <Input
            id="excludeOrganizationLocations"
            name="excludeOrganizationLocations"
            placeholder="ireland, india"
            toolparamdescription="Comma-separated countries or regions to skip. Companies headquartered in one of these are never contacted."
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="employeeMin" label="Min employees">
            <Input
              id="employeeMin"
              name="employeeMin"
              type="number"
              min={1}
              placeholder="50"
              className="tnum"
              toolparamdescription="Smallest headcount to consider. Leave blank for no lower bound."
            />
          </Field>
          <Field id="employeeMax" label="Max employees">
            <Input
              id="employeeMax"
              name="employeeMax"
              type="number"
              min={1}
              placeholder="500"
              className="tnum"
              toolparamdescription="Largest headcount to consider. Leave blank for no upper bound."
            />
          </Field>
        </div>

        <Field id="keywords" label="Keywords" hint="Comma-separated.">
          <Input
            id="keywords"
            name="keywords"
            placeholder="saas, logistics, fintech"
            toolparamdescription="Comma-separated industry or market words the target company should match."
          />
        </Field>

        <Field
          id="excludeKeywords"
          label="Exclude keywords"
          hint="Comma-separated. Matched against company name and title — Apollo doesn't expose company keyword/industry text at search time, so this filter runs after Apollo returns results, not inside Apollo's own search."
        >
          <Input
            id="excludeKeywords"
            name="excludeKeywords"
            placeholder="staffing, agency, recruiting"
            toolparamdescription="Comma-separated words that disqualify a company. Matched against its name and the person's title after Apollo returns results."
          />
        </Field>
      </fieldset>

      <div className="border-hairline flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <Plus size={14} weight="bold" />
          {isSubmitting ? 'Creating…' : 'Create campaign'}
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
