import type { QuestionAnswer } from '@/components/landing/faq-items'

/**
 * Picks the FAQ entry that best answers a free-text question.
 *
 * Deliberately a lexical scorer, not a model call: this runs inside a WebMCP
 * tool on the visitor's own page, where an extra network round trip would be
 * slower than the agent simply reading `/llms.txt`. The FAQ is a fixed handful
 * of entries, so overlap counting is enough.
 */

/** Words that appear in most questions and would drown out the signal. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'a', 'about', 'actually', 'am', 'an', 'and', 'any', 'anything', 'are', 'as', 'at', 'be',
  'been', 'but', 'by', 'can', 'do', 'does', 'doing', 'for', 'from', 'happens', 'has', 'have',
  'how', 'i', 'if', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'so', 'somebody',
  'that', 'the', 'their', 'them', 'then', 'there', 'they', 'this', 'to', 'up', 'want', 'was',
  'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
])

/** A token this short carries no meaning on its own ("it", "go", "ok"). */
const MIN_TOKEN_LENGTH = 3

/**
 * A hit in the question itself is stronger evidence than the same word buried
 * in a long answer, so question overlap counts for more.
 */
const QUESTION_WEIGHT = 3
const ANSWER_WEIGHT = 1

export interface FaqMatch {
  readonly item: QuestionAnswer
  readonly score: number
}

/** Lowercases, strips punctuation, and drops noise words. */
export function tokenize(text: string): ReadonlySet<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(token))
  return new Set(tokens)
}

function overlapCount(queryTokens: ReadonlySet<string>, text: string): number {
  const textTokens = tokenize(text)
  let count = 0
  for (const token of queryTokens) {
    if (textTokens.has(token)) count += 1
  }
  return count
}

function scoreItem(queryTokens: ReadonlySet<string>, item: QuestionAnswer): number {
  return (
    overlapCount(queryTokens, item.question) * QUESTION_WEIGHT +
    overlapCount(queryTokens, item.answer) * ANSWER_WEIGHT
  )
}

/**
 * Returns the matching entries, best first, capped at `limit`. Empty when
 * nothing overlaps — the caller tells the agent to read the whole FAQ instead
 * of handing back an arbitrary entry.
 */
export function matchFaqItems(
  question: string,
  items: readonly QuestionAnswer[],
  limit: number,
): readonly FaqMatch[] {
  const queryTokens = tokenize(question)
  if (queryTokens.size === 0) return []

  return items
    .map((item) => ({ item, score: scoreItem(queryTokens, item) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}
