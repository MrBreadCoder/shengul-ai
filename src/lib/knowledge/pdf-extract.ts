import { getDocumentProxy, extractText } from 'unpdf'
import { AppError } from '@/lib/errors/app-error'

// Mirrors brightdata.ts's MAX_SCRAPE_CHARS pattern — full documents can run
// much longer than a scraped page, so this cap is generous, but still bounds
// what a single source can contribute to the chunking/embedding budget.
export const PDF_MAX_EXTRACTED_CHARS = 12_000

// unpdf is chosen over pdf-parse: no filesystem side effects at import time
// (pdf-parse has a known debug-mode footgun that tries to read a test fixture
// off disk on first import), and it's built for serverless/edge runtimes.
export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    return text.slice(0, PDF_MAX_EXTRACTED_CHARS)
  } catch (cause) {
    throw new AppError('VALIDATION_ERROR', 'Could not extract text from this PDF', {
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
