'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FileText } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

type UploadState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface KnowledgeFileUploadProps {
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

export function KnowledgeFileUpload({ clientId }: KnowledgeFileUploadProps): React.ReactElement {
  const t = useTranslations('clients')
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
      const res = await fetch(`/api/clients/${clientId}/knowledge/file`, { method: 'POST', body: formData })
      if (!res.ok) {
        const message = await extractErrorMessage(res, t('knowledgeFileUpload.uploadFailed'))
        setState({ status: 'error', message })
        toast.error(t('knowledgeFileUpload.uploadFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success(t('knowledgeFileUpload.uploadedToast'))
      router.refresh()
    } catch {
      const message = t('knowledgeFileUpload.networkError')
      setState({ status: 'error', message })
      toast.error(t('knowledgeFileUpload.uploadFailedToast'), { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,text/plain,text/markdown,.md"
        className="sr-only"
        onChange={(event) => void onFileSelected(event)}
        aria-label={t('knowledgeFileUpload.inputLabel')}
      />
      <Button type="button" variant="secondary" size="sm" disabled={isSubmitting} onClick={() => inputRef.current?.click()}>
        <FileText size={14} weight="light" />
        {isSubmitting ? t('knowledgeFileUpload.uploading') : t('knowledgeFileUpload.uploadButton')}
      </Button>
      {state.status === 'error' ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">{state.message}</span>
      ) : null}
    </div>
  )
}
