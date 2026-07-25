export const CHUNK_SIZE_CHARS = 1000
export const CHUNK_OVERLAP_CHARS = 100

export interface TextChunk {
  index: number
  content: string
}

// Fixed-size sliding window with overlap so a fact split across a chunk
// boundary still appears whole in at least one chunk. Pure and deterministic —
// no tokenizer dependency, char-based is precise enough for this use case.
export function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE_CHARS,
  overlap: number = CHUNK_OVERLAP_CHARS,
): TextChunk[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const step = chunkSize - overlap
  const chunks: TextChunk[] = []
  let start = 0
  let index = 0
  while (start < trimmed.length) {
    const end = Math.min(start + chunkSize, trimmed.length)
    chunks.push({ index, content: trimmed.slice(start, end) })
    if (end === trimmed.length) break
    index += 1
    start += step
  }
  return chunks
}
