'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { updateMyLocale } from './locale-actions'
import type { AppLocale } from '@/types/i18n'

const LOCALES: readonly AppLocale[] = ['en', 'tr']

interface LanguageSectionProps {
  currentLocale: AppLocale
}

export function LanguageSection({ currentLocale }: LanguageSectionProps): React.ReactElement {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const [locale, setLocale] = useState<AppLocale>(currentLocale)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onChange(next: AppLocale): void {
    const previous = locale
    setError(null)
    setLocale(next)
    startTransition(async () => {
      try {
        await updateMyLocale(next)
      } catch {
        setError(t('languageSaveFailed'))
        setLocale(previous)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">{t('languageLabel')}</span>
        <select
          value={locale}
          disabled={isPending}
          onChange={(event) => onChange(event.target.value as AppLocale)}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {LOCALES.map((value) => (
            <option key={value} value={value}>
              {tCommon(value === 'en' ? 'english' : 'turkish')}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
