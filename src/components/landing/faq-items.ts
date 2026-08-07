/**
 * The questions people ask before saying yes.
 *
 * Kept out of `faq.tsx` because two surfaces render them: the accordion a
 * human reads, and the `FAQPage` JSON-LD an AI crawler quotes. One source
 * means the structured data can never answer differently from the page.
 */
export interface QuestionAnswer {
  readonly question: string
  readonly answer: string
}

export const FAQ_ITEMS: readonly QuestionAnswer[] = [
  {
    question: 'Will it sound like me?',
    answer:
      "Yes. Every email goes out from your own address, in your voice, and mentions something real about that company. If there's nothing worth saying, we don't send anything.",
  },
  {
    question: 'Do I have to approve every email?',
    answer:
      'Only if you want to. Some people read everything for the first fortnight and then let it run. Others never look. You can change your mind either way at any point.',
  },
  {
    question: 'What happens when somebody actually replies?',
    answer:
      'Follow-ups stop right away, and we reply the way you would. Anything serious comes straight to you, with your booking link already included.',
  },
  {
    question: 'Will it make things up?',
    answer:
      "No. We only write what we can verify. If a question comes up that we can't answer honestly, we check with you first.",
  },
  {
    question: 'What do you need from me?',
    answer:
      'A mailbox, a clear picture of who you want to meet, what you sell, and a link to your calendar. Everything after that is set up and run for you.',
  },
]
