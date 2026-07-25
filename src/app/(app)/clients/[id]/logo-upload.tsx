'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Image as ImageIcon, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

type UploadState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp,image/svg+xml'

interface LogoUploadProps {
  clientId: string
  hasLogo: boolean
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  const json: unknown = await res.json().catch(() => ({}))
  if (typeof json === 'object' && json !== null && 'issues' in json && typeof (json as { issues: unknown }).issues === 'string') {
    return (json as { issues: string }).issues
  }
  if (typeof json === 'object' && json !== null && 'error' in json) {
    return String((json as { error: unknown }).error)
  }
  return fallback
}

// Sits next to the client's CompanyMark on /clients/[id]. Uploading replaces
// any existing logo; removing reverts to the domain favicon or initials.
export function LogoUpload({ clientId, hasLogo }: LogoUploadProps): React.ReactElement {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  async function onFileSelected(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setState({ status: 'submitting' })
    try {
      const formData = new FormData()
      formData.set('file', file)
      const res = await fetch(`/api/clients/${clientId}/logo`, { method: 'POST', body: formData })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not upload the logo.')
        setState({ status: 'error', message })
        toast.error('Upload failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success('Logo updated')
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Upload failed', { description: message })
    }
  }

  async function onRemove(): Promise<void> {
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/logo`, { method: 'DELETE' })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not remove the logo.')
        setState({ status: 'error', message })
        toast.error('Remove failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success('Logo removed')
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Remove failed', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <div className="flex items-center gap-1">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        className="sr-only"
        onChange={(event) => void onFileSelected(event)}
        aria-label="Upload logo"
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={hasLogo ? 'Replace logo' : 'Upload logo'}
        disabled={isSubmitting}
        onClick={() => inputRef.current?.click()}
      >
        <ImageIcon size={14} weight="light" />
      </Button>
      {hasLogo ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Remove logo"
          disabled={isSubmitting}
          onClick={() => void onRemove()}
        >
          <Trash size={14} weight="light" />
        </Button>
      ) : null}
      {state.status === 'error' ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {state.message}
        </span>
      ) : null}
    </div>
  )
}
