'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MagnifyingGlass, PlusIcon, XIcon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type DiscoverState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string }
type SubmitState = { status: 'idle' } | { status: 'submitting' }

interface KnowledgeSitemapPickerProps {
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

// Enter a website -> discover its pages via sitemap.xml (Brightdata crawl
// fallback server-side) -> pick which ones to scrape into the knowledge base.
export function KnowledgeSitemapPicker({ clientId }: KnowledgeSitemapPickerProps): React.ReactElement {
  const router = useRouter()
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [discoverState, setDiscoverState] = useState<DiscoverState>({ status: 'idle' })
  const [urls, setUrls] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' })
  const [manualUrl, setManualUrl] = useState('')

  // Merges new urls into the list without disturbing ones already present —
  // used by both sitemap discovery and manual entry, which can interleave.
  function addUrls(newUrls: string[], autoSelect: boolean): void {
    setUrls((prev) => {
      const existing = new Set(prev)
      const additions = newUrls.filter((url) => !existing.has(url))
      return additions.length > 0 ? [...prev, ...additions] : prev
    })
    if (autoSelect) {
      setSelected((prev) => {
        const next = new Set(prev)
        for (const url of newUrls) next.add(url)
        return next
      })
    }
  }

  async function onDiscover(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setDiscoverState({ status: 'loading' })
    try {
      const res = await fetch(`/api/clients/${clientId}/knowledge/discover-sitemap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl }),
      })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not discover pages for this site.')
        setDiscoverState({ status: 'error', message })
        return
      }
      const json = (await res.json()) as { urls: string[] }
      addUrls(json.urls, false)
      setDiscoverState({ status: 'idle' })
      if (json.urls.length === 0) toast.info('No pages found on this site.')
    } catch {
      setDiscoverState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  function onAddManualUrl(event: React.FormEvent): void {
    event.preventDefault()
    const trimmed = manualUrl.trim()
    if (!trimmed) return
    let normalized: string
    try {
      normalized = new URL(trimmed).toString()
    } catch {
      toast.error('Enter a valid page URL, e.g. https://example.com/pricing')
      return
    }
    if (urls.includes(normalized)) {
      toast.info('That page is already in the list.')
      setManualUrl('')
      return
    }
    addUrls([normalized], true)
    setManualUrl('')
  }

  function toggle(url: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  function toggleAll(): void {
    setSelected((prev) => (prev.size === urls.length ? new Set() : new Set(urls)))
  }

  function removeUrl(url: string): void {
    setUrls((prev) => prev.filter((u) => u !== url))
    setSelected((prev) => {
      if (!prev.has(url)) return prev
      const next = new Set(prev)
      next.delete(url)
      return next
    })
  }

  async function onAddSelected(): Promise<void> {
    if (selected.size === 0) return
    setSubmitState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/knowledge/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: Array.from(selected) }),
      })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not add the selected pages.')
        toast.error('Add failed', { description: message })
        setSubmitState({ status: 'idle' })
        return
      }
      const json = (await res.json()) as { insertedCount: number }
      toast.success(
        json.insertedCount > 0 ? `${json.insertedCount} page(s) queued for scraping` : 'Those pages were already added',
      )
      setUrls([])
      setSelected(new Set())
      setWebsiteUrl('')
      setSubmitState({ status: 'idle' })
      router.refresh()
    } catch {
      toast.error('Add failed', { description: 'Network request failed. Check your connection and retry.' })
      setSubmitState({ status: 'idle' })
    }
  }

  const isDiscovering = discoverState.status === 'loading'
  const isSubmitting = submitState.status === 'submitting'
  const overBatchLimit = selected.size > 50

  return (
    <div className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-4">
      <form onSubmit={(e) => void onDiscover(e)} className="flex items-center gap-2">
        <Input
          type="url"
          required
          placeholder="https://client-website.com"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          aria-label="Website URL"
        />
        <Button type="submit" disabled={isDiscovering}>
          <MagnifyingGlass size={14} weight="light" />
          {isDiscovering ? 'Discovering…' : 'Discover pages'}
        </Button>
      </form>

      {discoverState.status === 'error' ? (
        <p role="alert" className="text-destructive text-[13px]">{discoverState.message}</p>
      ) : null}

      <form onSubmit={onAddManualUrl} className="flex items-center gap-2">
        <Input
          type="url"
          placeholder="https://client-website.com/specific-page"
          value={manualUrl}
          onChange={(e) => setManualUrl(e.target.value)}
          aria-label="Add a page URL manually"
        />
        <Button type="submit" variant="outline" disabled={manualUrl.trim().length === 0}>
          <PlusIcon size={14} weight="light" />
          Add page
        </Button>
      </form>

      {urls.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={selected.size === urls.length} onChange={toggleAll} />
              Select all ({urls.length} listed)
            </label>
            <Button type="button" size="sm" disabled={selected.size === 0 || overBatchLimit || isSubmitting} onClick={() => void onAddSelected()}>
              {isSubmitting ? 'Adding…' : `Add selected (${selected.size})`}
            </Button>
          </div>
          {overBatchLimit ? (
            <p className="text-destructive text-[12px]">Select 50 or fewer pages at a time.</p>
          ) : null}
          <ul className="border-hairline max-h-80 overflow-y-auto rounded-md border">
            {urls.map((url) => (
              <li key={url} className="border-hairline flex items-center gap-2 border-b px-3 py-2 text-[13px] last:border-b-0">
                <input type="checkbox" checked={selected.has(url)} onChange={() => toggle(url)} />
                <span className="truncate flex-1">{url}</span>
                <button
                  type="button"
                  onClick={() => removeUrl(url)}
                  aria-label={`Remove ${url}`}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                >
                  <XIcon size={14} weight="light" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
