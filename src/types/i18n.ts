export const SUPPORTED_LOCALES = ['en', 'tr'] as const

export type AppLocale = (typeof SUPPORTED_LOCALES)[number]
