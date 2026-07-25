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
      'That is the whole point. It writes short, specific emails from your own address, in your voice, about something real at that company. If it cannot say anything worth reading, it does not send.',
  },
  {
    question: 'Do I have to approve every email?',
    answer:
      'Only if you want to. Some people read everything for the first fortnight and then let it run. Others never look. You can change your mind either way at any point.',
  },
  {
    question: 'What happens when somebody actually replies?',
    answer:
      'The chasing stops instantly and the reply is answered the way you would answer it. Anything that turns into money or a real decision comes straight to you with your booking link already offered.',
  },
  {
    question: 'Will it make things up?',
    answer:
      'No. It only writes from what it could actually verify, and when a question comes back that it cannot answer honestly, it waits for you rather than guessing on your behalf.',
  },
  {
    question: 'What do you need from me?',
    answer:
      'A mailbox, a clear picture of who you want to meet, what you sell, and a link to your calendar. Everything after that is set up and run for you.',
  },
]
