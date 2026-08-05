import { z } from 'zod'
import { SUPPORTED_LOCALES } from '@/types/i18n'

export const localeSchema = z.enum(SUPPORTED_LOCALES)
