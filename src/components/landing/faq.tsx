import { Plus } from '@phosphor-icons/react/dist/ssr'
import { BookMeetingButton } from './book-meeting-button'
import { Reveal } from './reveal'

interface QuestionAnswer {
  readonly question: string
  readonly answer: string
}

const FAQ_ITEMS: readonly QuestionAnswer[] = [
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

export function Faq(): React.ReactElement {
  return (
    <section className="px-4 py-28 md:py-32">
      <div className="mx-auto grid max-w-[1180px] gap-12 lg:grid-cols-12">
        <Reveal className="lg:col-span-4">
          <h2 className="text-[2rem] leading-[1.08] font-medium tracking-tight text-balance sm:text-[2.4rem]">
            The things people ask before saying yes.
          </h2>
        </Reveal>

        <div className="lg:col-span-7 lg:col-start-6">
          {FAQ_ITEMS.map(({ question, answer }, index) => (
            <Reveal key={question} delay={index * 0.04}>
              <details className="group border-b border-[var(--l-hairline)] py-6 last:border-b-0">
                <summary className="flex cursor-pointer list-none items-start justify-between gap-6 text-[17px] font-medium tracking-tight [&::-webkit-details-marker]:hidden">
                  {question}
                  <Plus
                    weight="light"
                    aria-hidden
                    className="mt-1 size-4 shrink-0 text-[var(--l-muted)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] group-open:rotate-45"
                  />
                </summary>
                <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-[var(--l-muted)]">
                  {answer}
                </p>
              </details>
            </Reveal>
          ))}

          <Reveal delay={0.2}>
            <div className="mt-12">
              <BookMeetingButton size="lg" />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}
