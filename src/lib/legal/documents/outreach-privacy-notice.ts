import type { LegalDocument } from '@/lib/legal/document'
import { LEGAL_UPDATED_AT } from '@/lib/legal/document'
import { CONTACT_ADDRESS_INLINE, CONTACT_EMAIL, LEGAL_ENTITY } from '@/lib/legal/contact'

/**
 * The notice for people we email who never asked to hear from us.
 *
 * This is the Article 14 obligation — telling someone whose data you obtained
 * from a third party what you hold and where it came from — and it is the one
 * document the previous set was missing entirely, despite that group being the
 * majority of the personal data this service touches.
 *
 * Written for someone who is mildly annoyed and wants it to stop, so the way to
 * make it stop comes before anything else. Every other section is a right they
 * already have; this one is the thing they came here to do.
 */
export const outreachPrivacyNotice: LegalDocument = {
  slug: 'outreach-privacy-notice',
  title: 'If you received an email from us',
  description:
    'Where we got your details, why you received a business email, what we hold about you, and how to make it stop for good — in plain language.',
  summary:
    'You are probably here because an email arrived that you did not ask for. This page explains where your details came from, and how to make sure you never hear from us again.',
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      id: 'make-it-stop',
      heading: '1. How to make it stop',
      blocks: [
        {
          kind: 'callout',
          text: `Reply to the email and say you are not interested, or that you want to be removed. That is enough. The sequence stops immediately and your address goes on a permanent do-not-contact list. You do not have to click anything, fill in a form, explain why, or be polite about it. If you would rather not reply to the sender, email ${CONTACT_EMAIL} instead and we will do the same.`,
        },
        {
          kind: 'paragraph',
          text: 'We apply the request across every campaign on our platform, not just the one that reached you. If you hear from us again after that, it is a mistake — tell us and we will fix it and explain what went wrong.',
        },
        {
          kind: 'paragraph',
          text: 'There is no unsubscribe link at the bottom of our emails. That is because we send individual messages from an ordinary mailbox rather than through a bulk mailing platform, and a bulk footer would be the one thing in the message that was not written by a person. A reply does the same job and reaches a human.',
        },
      ],
    },
    {
      id: 'who-we-are',
      heading: '2. Who is actually writing to you',
      blocks: [
        {
          kind: 'paragraph',
          text: `The email came from a company that wants to sell you something. ${LEGAL_ENTITY} runs their outbound programme for them: we found your details, wrote the message, and sent it from their mailbox. They decide who to approach and what to offer; we operate the machinery.`,
        },
        {
          kind: 'paragraph',
          text: 'In data protection terms, they are the controller and we are their processor. You can exercise your rights against either of us, and we will act on your request either way rather than sending you back and forth. The company\'s name is in the email you received.',
        },
      ],
    },
    {
      id: 'where-from',
      heading: '3. Where your details came from',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Not from you, and not from anyone who knows you. We obtained them from Apollo.io, a commercial business-contact database that compiles professional details of people in work roles. We then confirmed your work address was real and deliverable using Emailable, an address verification service.',
        },
        {
          kind: 'paragraph',
          text: 'We also researched your employer using publicly available web pages, so the email could refer to something true about your business. That research is about the company, and we keep a link to the source of each statement.',
        },
        {
          kind: 'paragraph',
          text: 'We do not guess email addresses from name patterns, we do not scrape your mailbox or your contacts, and we did not get anything from a social network.',
        },
      ],
    },
    {
      id: 'what-we-hold',
      heading: '4. What we hold about you',
      blocks: [
        {
          kind: 'list',
          items: [
            'Your name, job title, employer and the employer\'s web domain.',
            'Your public professional profile link, if the database had one.',
            'Your work email address, and the record that it verified as deliverable.',
            'The original record as the database supplied it, so we can show where any detail came from.',
            'Research about your employer, with sources.',
            'The emails we sent you, and any reply you sent back.',
            'If you asked us to stop: your email address, on the list that makes sure we do.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'All of it concerns you at work. We do not hold your home address, your personal email, your phone number, your date of birth, or anything about your health, beliefs, politics or private life — and we do not want to.',
        },
        {
          kind: 'paragraph',
          text: 'Our emails contain no tracking pixel and no rewritten links, so we do not know whether you opened the message or clicked anything.',
        },
      ],
    },
    {
      id: 'why-allowed',
      heading: '5. Why we are allowed to do this',
      blocks: [
        {
          kind: 'paragraph',
          text: 'In the UK and Europe we rely on legitimate interests: our client\'s interest in reaching business buyers who might genuinely want what they sell, weighed against the intrusion of a small number of work emails to a work address.',
        },
        {
          kind: 'paragraph',
          text: 'We have carried out that balancing exercise, and it shapes how the service works: we contact people only in a professional capacity, we verify addresses instead of guessing them, we cap how much any mailbox sends in a day, we send a handful of messages rather than a blast, we stop the moment you reply, and we suppress permanently the moment you ask.',
        },
        {
          kind: 'callout',
          text: 'You can object to this at any time, and we will stop. Direct marketing is the one case where an objection needs no reason and admits no balancing test — if you object, that is the end of it.',
        },
      ],
    },
    {
      id: 'who-sees-it',
      heading: '6. Who else sees it',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The client whose campaign reached you sees your details, the research, and your reply. That is the point of the service.',
        },
        {
          kind: 'paragraph',
          text: 'Beyond that, only the service providers who help us run the platform — hosting, databases, contact sourcing, verification, web research, the language model that drafts the text, and the mail provider. Each is listed at /legal/subprocessors, with what it does and where.',
        },
        {
          kind: 'paragraph',
          text: 'We do not sell your details, we do not add you to any list we license to anyone else, and we do not use your data to serve you advertising. We do not use language-model providers that would train their general models on it.',
        },
      ],
    },
    {
      id: 'how-long',
      heading: '7. How long we keep it',
      blocks: [
        {
          kind: 'paragraph',
          text: 'For as long as the client\'s engagement with us lasts, and then up to 90 days after it ends, unless you ask us to delete it sooner.',
        },
        {
          kind: 'paragraph',
          text: 'The exception is the do-not-contact list. If you asked us to stop, we keep your email address on that list indefinitely, and nothing else. It is the only record that prevents a future campaign from finding you again, so deleting it would undo your own request. If you would rather we erased even that, tell us and we will — but you may hear from a later campaign as a result, and we will say so before doing it.',
        },
      ],
    },
    {
      id: 'your-rights',
      heading: '8. Your other rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Depending on where you live, you can ask us to give you a copy of what we hold, correct anything wrong, delete it, restrict what we do with it, or send it to you in a portable format. You can ask all of this for free and without giving a reason.',
        },
        {
          kind: 'paragraph',
          text: `Email ${CONTACT_EMAIL} and say what you want. We answer within one month under UK and EU law, and within 45 days under US state laws. We may need to check you are who you say you are before we act — usually replying from the address we hold is enough.`,
        },
        {
          kind: 'paragraph',
          text: 'The full detail of how we handle personal information, including our legal bases and international transfers, is in our Privacy Notice at /legal/privacy-policy.',
        },
      ],
    },
    {
      id: 'complaints',
      heading: '9. If you are not satisfied',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Tell us first if you can — we would rather fix it. If we get it wrong, you can complain to the data protection authority in your EU member state, to the Information Commissioner\'s Office in the UK, to the Federal Data Protection and Information Commissioner in Switzerland, or to your state attorney general in the United States. You do not need our permission and you do not have to come to us first.',
        },
        {
          kind: 'paragraph',
          text: `You can also write to us at ${LEGAL_ENTITY}, ${CONTACT_ADDRESS_INLINE}. Full contact details are at the foot of this page.`,
        },
      ],
    },
  ],
}
