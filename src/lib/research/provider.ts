export interface WebSnippet {
  url: string
  title: string
  content: string
}

export interface ResearchLead {
  fullName: string
  title: string | null
}

export interface WebResearch {
  // Runs a single web search and returns the top result snippets. Never throws
  // for "no results" — returns an empty array. Throws AppError only on a
  // transport/parse failure.
  search(query: string): Promise<WebSnippet[]>

  // Fetches a single page and returns its text content, capped at maxChars
  // (implementation provides its own default). Throws AppError on a
  // transport/parse failure.
  scrape(url: string, maxChars?: number): Promise<string>
}
