export const CHUNK_SIZE_CHARS = 1000
export const CHUNK_OVERLAP_CHARS = 100
// Defensive backstop against a leftover fragment (e.g. a lone heading) that
// survived chunking — in practice strip-boilerplate.ts should already have
// removed things like this before the chunker ever sees them.
export const MIN_CHUNK_CHARS = 20

export interface TextChunk {
  index: number
  content: string
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

// A paragraph alone larger than chunkSize is split at the nearest preceding
// space so a chunk boundary never lands mid-word. Falls back to a hard cut
// only when no space exists at all within the window (a single unbroken
// token longer than chunkSize) — pathological, but still makes progress.
function splitOversizedParagraph(paragraph: string, chunkSize: number): string[] {
  const parts: string[] = []
  let start = 0
  while (start < paragraph.length) {
    let end = Math.min(start + chunkSize, paragraph.length)
    if (end < paragraph.length) {
      const lastSpace = paragraph.lastIndexOf(' ', end)
      if (lastSpace > start) end = lastSpace
    }
    const piece = paragraph.slice(start, end).trim()
    if (piece.length > 0) parts.push(piece)
    start = end
  }
  return parts
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, '').length
}

// Paragraph-aware sliding window: paragraphs are packed greedily up to
// chunkSize, and each chunk after the first is prefixed with a
// whitespace-snapped tail of the previous chunk (the overlap), so a fact
// split across a chunk boundary still appears whole in at least one chunk —
// without ever cutting a word in half, unlike a raw character offset.
export function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE_CHARS,
  overlap: number = CHUNK_OVERLAP_CHARS,
): TextChunk[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const paragraphs = splitParagraphs(trimmed).flatMap((paragraph) =>
    paragraph.length > chunkSize ? splitOversizedParagraph(paragraph, chunkSize) : [paragraph],
  )
  if (paragraphs.length === 0) return []

  const packed: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`
    if (candidate.length > chunkSize && current.length > 0) {
      packed.push(current)
      current = paragraph
    } else {
      current = candidate
    }
  }
  if (current.length > 0) packed.push(current)

  const withOverlap = packed.map((chunk, i) => {
    if (i === 0 || overlap <= 0) return chunk
    const prev = packed[i - 1]!
    const tailStart = Math.max(0, prev.length - overlap)
    let snappedStart = tailStart
    if (tailStart > 0) {
      const nextSpace = prev.indexOf(' ', tailStart)
      snappedStart = nextSpace === -1 ? tailStart : nextSpace + 1
    }
    const tail = prev.slice(snappedStart).trim()
    return tail.length > 0 ? `${tail}\n\n${chunk}` : chunk
  })

  return withOverlap
    .filter((content) => nonWhitespaceLength(content) >= MIN_CHUNK_CHARS)
    .map((content, index) => ({ index, content }))
}
