'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Paperclip } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ALLOWED_RESOURCE_MIME_TYPES } from '@/lib/storage/client-resources'

type UploadState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface ResourceUploadProps {
  clientId: string
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  const json: unknown = await res.json().catch(() => ({}))
  if (typeof json === 'object' && json !== null && 'issues' in json) {
    const issues = (json as { issues: unknown }).issues
    if (typeof issues === 'string') return issues
  }
  if (typeof json === 'object' && json !== null && 'error' in json) return String((json as { error: unknown }).error)
  return fallback
}

export function ResourceUpload({ clientId }: ResourceUploadProps): React.ReactElement {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/resources`, { method: 'POST', body: formData })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not upload the file.')
        setState({ status: 'error', message })
        toast.error('Upload failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      formRef.current?.reset()
      toast.success('Resource added', { description: 'The agent can now send this when a lead asks.' })
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Upload failed', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void onSubmit(event)}
      className="border-hairline flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="resource-title" className="text-xs">Title</Label>
        <Input id="resource-title" name="title" required maxLength={120} placeholder="2026 portfolio deck" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="resource-description" className="text-xs">
          When should the agent send this? (optional)
        </Label>
        <Textarea
          id="resource-description"
          name="description"
          maxLength={500}
          rows={2}
          placeholder="Only when a lead asks to see examples."
        />
        <p className="text-faint text-[11px]">
          The agent reads the file itself when the format can be read. Use this only to say when
          it should be sent.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="resource-file" className="text-xs">File (max 3MB)</Label>
        <Input
          id="resource-file"
          name="file"
          type="file"
          required
          accept={ALLOWED_RESOURCE_MIME_TYPES.join(',')}
        />
      </div>
      {state.status === 'error' ? (
        <p role="alert" className="text-[11px]" style={{ color: 'var(--status-lost)' }}>
          {state.message}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={isSubmitting} className="self-start">
        <Paperclip size={14} weight="light" />
        {isSubmitting ? 'Uploading…' : 'Add resource'}
      </Button>
    </form>
  )
}
