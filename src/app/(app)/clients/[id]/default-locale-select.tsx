'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { updateClientDefaultLocale } from './locale-actions'
import type { AppLocale } from '@/types/i18n'

const LOCALES: readonly AppLocale[] = ['en', 'tr']

interface DefaultLocaleSelectProps {
  clientId: string
  value: AppLocale
}

export function DefaultLocaleSelect({ clientId, value }: DefaultLocaleSelectProps): React.ReactElement {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const [locale, setLocale] = useState<AppLocale>(value)
  const [isPending, startTransition] = useTransition()

  function onChange(next: AppLocale): void {
    const previous = locale
    setLocale(next)
    startTransition(async () => {
      const result = await updateClientDefaultLocale(clientId, next)
      if (!result.ok) {
        setLocale(previous)
        toast.error(t('defaultLanguageSaveFailed'))
      }
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`default-locale-${clientId}`} className="text-faint text-[11px]" title={t('defaultLanguageHint')}>
        {t('defaultLanguageLabel')}
      </label>
      <select
        id={`default-locale-${clientId}`}
        value={locale}
        disabled={isPending}
        onChange={(event) => onChange(event.target.value as AppLocale)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {tCommon(option === 'en' ? 'english' : 'turkish')}
          </option>
        ))}
      </select>
    </div>
  )
}
