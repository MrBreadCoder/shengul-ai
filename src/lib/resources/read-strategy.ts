// Below this many non-whitespace characters a PDF's text layer is treated as
// absent rather than short: scanned documents and design-led portfolio decks
// routinely extract to a handful of stray glyphs, and reading those as the
// file's content is worse than not reading it at all.
export const RESOURCE_PDF_TEXT_FLOOR = 200

// Matches PDF_MAX_EXTRACTED_CHARS in knowledge/pdf-extract.ts, so a resource
// contributes no more to the chunk/embedding budget than a knowledge PDF does.
export const RESOURCE_CONTENT_MAX_CHARS = 12_000

export type ReadStrategy = 'text' | 'vision' | 'unsupported'

/**
 * How a resource's bytes can be turned into content.
 *
 * `extractedText` is consulted only for PDFs — pass the result of
 * `extractPdfText` there, and omit it for every other type. A PDF is the one
 * format where the answer depends on the bytes rather than the mime type alone.
 *
 * 'unsupported' is a terminal, non-error state: the resource stays fully
 * sendable and its menu line falls back to title + description.
 */
export function chooseReadStrategy(mimeType: string, extractedText?: string): ReadStrategy {
  switch (mimeType) {
    case 'text/plain':
    case 'text/markdown':
    // SVG is markup, and Gemini image input does not accept it, so the source
    // text is both the readable and the only available form.
    case 'image/svg+xml':
      return 'text'
    case 'application/pdf':
      return (extractedText ?? '').trim().length >= RESOURCE_PDF_TEXT_FLOOR ? 'text' : 'vision'
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
      return 'vision'
    default:
      // image/gif lands here: Gemini's image input accepts png, jpeg and webp
      // only, and converting would mean taking on an image-processing
      // dependency for the least common resource type.
      return 'unsupported'
  }
}
