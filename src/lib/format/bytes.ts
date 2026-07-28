const KB = 1024
const MB = KB * 1024

// Sizes are shown next to a 3MB budget, so MB needs one decimal to make the
// running total legible; anything smaller reads better as a whole number.
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}
