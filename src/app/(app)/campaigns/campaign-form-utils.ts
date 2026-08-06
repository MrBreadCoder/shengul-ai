// Shared FormData parsing between NewCampaignForm and EditCampaignForm —
// both submit the same comma-separated-text and multi-checkbox field shapes.

export function splitCsv(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function getAllStrings(formData: FormData, name: string): string[] {
  return formData.getAll(name).map(String)
}
