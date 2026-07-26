import { describe, expect, it } from 'vitest'
import { matchFaqItems, tokenize } from '@/lib/webmcp/faq-match'
import { FAQ_ITEMS } from '@/components/landing/faq-items'

const ITEMS = [
  { question: 'Will it sound like me?', answer: 'It writes in your voice from your own address.' },
  { question: 'Do I have to approve every email?', answer: 'Only if you want to. You can let it run.' },
  {
    question: 'What happens when somebody actually replies?',
    answer: 'The chasing stops instantly and the reply is answered.',
  },
] as const

describe('tokenize', () => {
  it('should lowercase and split on punctuation', () => {
    expect([...tokenize('Booking-Link, Voice.')]).toEqual(['booking', 'link', 'voice'])
  })

  it('should drop stop words and tokens shorter than three characters', () => {
    expect([...tokenize('what will it do to my inbox')]).toEqual(['inbox'])
  })

  it('should deduplicate repeated tokens', () => {
    expect([...tokenize('email email EMAIL')]).toEqual(['email'])
  })

  it('should return an empty set for text made entirely of noise', () => {
    expect(tokenize('what is it?').size).toBe(0)
  })
})

describe('matchFaqItems', () => {
  it('should return the entry whose question shares the query wording', () => {
    const matches = matchFaqItems('does it sound like me?', ITEMS, 3)
    expect(matches[0]?.item.question).toBe('Will it sound like me?')
  })

  it('should match on answer wording when the question shares nothing', () => {
    const matches = matchFaqItems('how is the chasing stopped', ITEMS, 3)
    expect(matches[0]?.item.question).toBe('What happens when somebody actually replies?')
  })

  it('should rank a question hit above an answer-only hit', () => {
    const matches = matchFaqItems('replies', ITEMS, 3)
    expect(matches[0]?.item.question).toBe('What happens when somebody actually replies?')
  })

  it('should order results by descending score', () => {
    const scores = matchFaqItems('email reply approve', ITEMS, 3).map(({ score }) => score)
    expect(scores).toEqual([...scores].sort((left, right) => right - left))
  })

  it('should cap the number of results at the given limit', () => {
    expect(matchFaqItems('email reply approve voice run', ITEMS, 1)).toHaveLength(1)
  })

  it('should return no matches when nothing overlaps, rather than an arbitrary entry', () => {
    expect(matchFaqItems('what does a kubernetes migration cost', ITEMS, 3)).toEqual([])
  })

  it('should return no matches for a query made entirely of stop words', () => {
    expect(matchFaqItems('what is it and how do you do that', ITEMS, 3)).toEqual([])
  })

  it('should return no matches for an empty query', () => {
    expect(matchFaqItems('   ', ITEMS, 3)).toEqual([])
  })

  it('should return no matches when there are no items to search', () => {
    expect(matchFaqItems('voice', [], 3)).toEqual([])
  })

  it('should find something for every published question asked back verbatim', () => {
    for (const item of FAQ_ITEMS) {
      const matches = matchFaqItems(item.question, FAQ_ITEMS, 3)
      expect(matches[0]?.item.question, `no match for "${item.question}"`).toBe(item.question)
    }
  })
})
