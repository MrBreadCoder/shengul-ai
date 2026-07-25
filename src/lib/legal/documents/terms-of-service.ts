import type { LegalDocument } from '@/lib/legal/document'
import { LEGAL_UPDATED_AT } from '@/lib/legal/document'
import {
  CONTACT_ADDRESS_INLINE,
  CONTACT_EMAIL,
  CONTACT_PHONE,
  GOVERNING_STATE,
  LEGAL_ENTITY,
  LEGAL_ENTITY_DBA,
  NOTICE_EMAIL,
  PRODUCT_NAME,
  SITE_HOME_URL,
} from '@/lib/legal/contact'

/**
 * The terms of service.
 *
 * Rewritten from a consumer-app template into an agreement for a managed
 * business service. The template's payment, subscription, user-contribution and
 * consumer-arbitration machinery described a product that does not exist here;
 * what it lacked — acceptable use, deliverability risk, AI output, data
 * processing, confidentiality — is what this service actually needs.
 */
export const termsOfService: LegalDocument = {
  slug: 'terms-of-service',
  title: 'Terms of Service',
  description:
    'The agreement governing use of Shengul AI: what the managed outbound service does, what each side is responsible for, and how risk is allocated between us.',
  summary: `These terms govern your use of ${PRODUCT_NAME}, operated by ${LEGAL_ENTITY}. This is a business service and these are business terms — they assume you are agreeing on behalf of a company, not as a consumer.`,
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      id: 'agreement',
      heading: '1. This agreement',
      blocks: [
        {
          kind: 'paragraph',
          text: `${LEGAL_ENTITY}, doing business as ${LEGAL_ENTITY_DBA} ("we", "us", "our"), operates ${PRODUCT_NAME} and the website at ${SITE_HOME_URL} (together, the "Services").`,
        },
        {
          kind: 'paragraph',
          text: 'These terms form a binding agreement between us and the organisation on whose behalf the Services are used ("you", "your", the "Client"). If you are accepting these terms, you confirm that you are at least 18 years old and that you have authority to bind that organisation. If you do not agree, do not use the Services.',
        },
        {
          kind: 'paragraph',
          text: 'These terms incorporate our Acceptable Use Policy at /legal/acceptable-use-policy, our Data Processing Addendum at /legal/data-processing-addendum, and our Privacy Notice at /legal/privacy-policy. Where we have signed a separate written agreement, order form or statement of work with you, that document governs any conflict with these terms.',
        },
        {
          kind: 'paragraph',
          text: `We may change these terms. We will post the updated version here and, for a material change, give notice to account holders by email from ${NOTICE_EMAIL} at least 30 days before it takes effect. Continuing to use the Services after the effective date means you accept the change. If a material change is unacceptable to you, you may terminate under section 6 before it takes effect.`,
        },
      ],
    },
    {
      id: 'the-services',
      heading: '2. What the Services are',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We operate a managed outbound programme on your behalf. Working from a description of the buyer you want to meet, we:',
        },
        {
          kind: 'list',
          items: [
            'Identify people matching that description using a commercial business-contact database.',
            'Verify each work email address through two independent providers before anything is sent, and discard addresses that do not verify.',
            'Research each target company from publicly available sources and compile a dossier with sources cited.',
            'Draft and send personalised emails from a mailbox you have connected, at capped daily volume with human-like pacing.',
            'Follow up on a set cadence, and stop the sequence the moment somebody replies.',
            'Handle replies, escalate questions we cannot answer truthfully, and hand any conversation involving price or commitment to a person at your organisation.',
            'Give you a console showing the resulting pipeline and reporting.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'This is an operated service, not self-service software. We configure campaigns for you. Scope, volume, the number of mailboxes and the fees are set in an order form or statement of work.',
        },
        {
          kind: 'paragraph',
          text: 'The Services are not built to satisfy industry-specific regulation such as HIPAA, FISMA, PCI DSS or the Gramm-Leach-Bliley Act. Do not use them to process data subject to those regimes.',
        },
      ],
    },
    {
      id: 'accounts',
      heading: '3. Accounts and access',
      blocks: [
        {
          kind: 'paragraph',
          text: 'There is no public sign-up. We create console accounts for named individuals at your organisation. You are responsible for keeping credentials confidential, for all activity under your accounts, and for telling us promptly if you believe an account has been compromised.',
        },
        {
          kind: 'paragraph',
          text: 'You will tell us promptly when someone at your organisation should no longer have access, so we can remove it. We may suspend an account we reasonably believe has been compromised or is being used in breach of these terms.',
        },
        {
          kind: 'paragraph',
          text: 'Registration details you give us must be accurate and kept up to date.',
        },
      ],
    },
    {
      id: 'fees',
      heading: '4. Fees',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Fees, the billing period, the committed term and any usage limits are set out in the order form or statement of work agreed with you. We do not take card payments through the Services and the Services contain no self-service checkout, subscription management or free trial.',
        },
        {
          kind: 'paragraph',
          text: 'Unless the order form says otherwise: invoices are payable within 30 days of the invoice date, in US dollars; fees exclude sales, use, VAT and similar taxes, which you are responsible for other than taxes on our income; and we may charge interest on overdue amounts at 1.5% per month or the maximum the law allows, whichever is lower.',
        },
        {
          kind: 'paragraph',
          text: 'If an invoice is more than 30 days overdue and we have given you written notice and 10 days to cure, we may suspend the Services until it is paid. Fees already paid for a period are non-refundable except where these terms expressly say otherwise or the law requires a refund.',
        },
        {
          kind: 'paragraph',
          text: 'We may change fees for a renewal term by giving you at least 45 days\' notice before the current term ends.',
        },
      ],
    },
    {
      id: 'your-responsibilities',
      heading: '5. Your responsibilities',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This service sends email in your name, from your domain, to people you have asked us to reach. Several things only you can be responsible for, and you represent and warrant that:',
        },
        {
          kind: 'list',
          items: [
            'You have the right and authority to connect each mailbox you connect, and to authorise sending from the domain it belongs to.',
            'You have a lawful basis to contact the people described by the buyer profile you give us, and your use of the Services complies with all applicable law — including the CAN-SPAM Act, CASL, the UK and EU GDPR and ePrivacy rules, and any equivalent law where your recipients are located.',
            'The description of your business, your value proposition, pricing statements and knowledge base content that you give us are accurate and not misleading, and you have the right to give them to us.',
            'You will not use the Services in breach of our Acceptable Use Policy.',
            'You will review and honour opt-out requests and complaints that reach you directly, and pass them to us so we can add them to the suppression list.',
            'Where you have chosen automatic sending rather than approval, you accept responsibility for emails sent under that configuration.',
          ],
        },
        {
          kind: 'callout',
          text: 'Email sent from your mailbox is your email. We build the safeguards — verification, caps, pacing, suppression, escalation — but the message goes out under your name and your domain, and as between you and us you are responsible for its content and for the lawfulness of contacting the recipient.',
        },
      ],
    },
    {
      id: 'term',
      heading: '6. Term, termination and what happens after',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The agreement runs for the term stated in your order form, and renews for successive periods of the same length unless either of us gives written notice of non-renewal at least 30 days before the current term ends.',
        },
        {
          kind: 'paragraph',
          text: 'Either of us may terminate immediately on written notice if the other commits a material breach and fails to cure it within 30 days of being told, or becomes insolvent. We may suspend or terminate immediately, without a cure period, for a breach of the Acceptable Use Policy that creates a risk of legal liability, security compromise, or serious harm to sending reputation — ours, yours or a third party\'s.',
        },
        {
          kind: 'paragraph',
          text: 'On termination: your access to the console ends; all active sequences stop; and we stop sending. You may request an export of your campaign data in a machine-readable format at any time up to 30 days after termination, and we will provide it within a reasonable period. We delete or return your data in line with the retention schedule in our Privacy Notice, except for the suppression list, which we keep so that people who asked not to be contacted are not contacted again, and except for records we must keep by law.',
        },
        {
          kind: 'paragraph',
          text: 'If we terminate for our own convenience, or you terminate for our uncured material breach, we will refund fees you have prepaid for the period after termination. Sections 8 to 14 and 16 to 18 survive termination.',
        },
      ],
    },
    {
      id: 'mailboxes',
      heading: '7. Connected mailboxes and deliverability',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You connect a mailbox through Google\'s or Microsoft\'s own consent screen, or by giving us SMTP and IMAP credentials. We use send permission to send campaign mail and read permission only to detect replies to mail we sent, as described in section 4 of the Privacy Notice. You may revoke a connection at any time, and sending from it stops immediately.',
        },
        {
          kind: 'paragraph',
          text: 'Your relationship with Google, Microsoft or your mail host is governed by your agreement with them. We are not responsible for their acts, outages, policy changes, or decisions to restrict or suspend your account.',
        },
        {
          kind: 'callout',
          text: `Cold outbound carries real risk to a sending domain. We reduce it — verified addresses only, per-mailbox daily caps, warm-up, pacing and jitter, automatic suppression on bounce and on opt-out — but we cannot eliminate it. We do not warrant any level of deliverability, inbox placement, open rate, reply rate, number of meetings booked, or revenue, and we are not liable for deterioration of your domain or IP reputation, spam-folder placement, blocklisting, or action taken against your mailbox by your mail provider. If protecting your primary domain matters to you, use a separate sending domain; we will advise on this if you ask.`,
        },
      ],
    },
    {
      id: 'ai-output',
      heading: '8. AI-generated content',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Research summaries, outbound emails, follow-ups and replies are generated by a large language model from your inputs and from public sources. The system is built to refuse rather than invent — it cites sources for research, escalates questions it cannot answer truthfully, and always hands anything about price or commitment to a person at your organisation — but no language model is reliably accurate, and output may be wrong, incomplete or inappropriate.',
        },
        {
          kind: 'paragraph',
          text: 'You choose the level of human review: emails may be held as drafts for approval, or sent automatically. Where you choose approval, you are responsible for what you approve. Where you choose automatic sending, you accept that no person at your organisation reads the message first.',
        },
        {
          kind: 'paragraph',
          text: 'As between you and us, you own the emails sent from your mailbox and the research dossiers generated for your campaigns, and you are responsible for them. We make no warranty that generated output is accurate, non-infringing, or unique to you — similar inputs can produce similar output for another client. We are not liable for decisions made in reliance on generated content.',
        },
      ],
    },
    {
      id: 'data-protection',
      heading: '9. Data protection',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Where we process personal data on your behalf, we do so as your processor under the Data Processing Addendum at /legal/data-processing-addendum, which is incorporated into these terms. It sets out our security obligations, our use of subprocessors, how we handle data-subject requests and breaches, and the transfer mechanisms we rely on.',
        },
        {
          kind: 'paragraph',
          text: 'You are the controller of that data. You are responsible for the lawfulness of your instructions, including the buyer profile you ask us to target and the basis on which those people are contacted.',
        },
      ],
    },
    {
      id: 'confidentiality',
      heading: '10. Confidentiality',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Each of us may receive information from the other that is marked confidential or that a reasonable person would understand to be confidential — including your pricing, positioning, knowledge base and pipeline, and our non-public methods and materials.',
        },
        {
          kind: 'paragraph',
          text: 'Each of us will use the other\'s confidential information only to perform under this agreement, will protect it with at least the care it uses for its own confidential information and no less than reasonable care, and will not disclose it except to employees, contractors and advisers who need it and are bound by comparable obligations. These duties do not apply to information that is or becomes public through no fault of the recipient, was already known without a duty of confidence, is independently developed, or is lawfully received from a third party. Disclosure compelled by law is permitted, with prior notice where lawful.',
        },
      ],
    },
    {
      id: 'ip',
      heading: '11. Intellectual property',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We own the Services — all software, models of operation, designs, documentation, trademarks and content we provide — and everything we develop in the course of providing them, other than your material. Subject to these terms, we grant you a non-exclusive, non-transferable, revocable right to access and use the Services and their output for your own business purposes for the term of this agreement, including for generating revenue. Nothing else is granted.',
        },
        {
          kind: 'paragraph',
          text: 'You own your material — your brand assets, value proposition, knowledge base documents, contact lists you provide, and the content of your mailboxes. You grant us a limited, non-exclusive, worldwide, royalty-free licence to host, copy, process, transmit and display that material, and to provide it to our subprocessors, solely to operate the Services for you. The licence lasts only as long as we hold the material and ends when it is deleted or returned.',
        },
        {
          kind: 'callout',
          text: 'We claim no ownership of your material. We do not publish it, sell it, license it to anyone else, or use it to train general-purpose AI models, and we do not use one client\'s data to benefit another.',
        },
        {
          kind: 'paragraph',
          text: 'If you send us feedback, suggestions or ideas about the Services, we may use them without restriction or payment. Feedback is not your confidential information, and we ask that you do not include any in it.',
        },
        {
          kind: 'paragraph',
          text: 'Neither of us may use the other\'s name, logo or trademarks publicly without prior written consent, which may be given by email.',
        },
      ],
    },
    {
      id: 'availability',
      heading: '12. Availability, changes and support',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We aim to keep the Services available, but we do not commit to an uptime level unless an order form says otherwise. The Services depend on third parties — hosting, databases, contact data, verification, language models, mail providers, job scheduling — and an outage at any of them may interrupt us. We may perform maintenance, and will try to schedule it to minimise disruption.',
        },
        {
          kind: 'paragraph',
          text: 'We may change, improve or discontinue features. We will not make a change that materially reduces the core functionality of the Services during a paid term without giving you notice and, if you object, the option to terminate and receive a refund of fees prepaid for the unused period.',
        },
        {
          kind: 'paragraph',
          text: `Support is provided by email at ${CONTACT_EMAIL} during our normal business hours, and by whatever additional channel your order form specifies.`,
        },
        {
          kind: 'paragraph',
          text: 'The Services may contain typographical errors, inaccuracies or omissions, including in reporting figures. We may correct them at any time without notice.',
        },
      ],
    },
    {
      id: 'disclaimer',
      heading: '13. Disclaimer of warranties',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We will provide the Services with reasonable skill and care. Beyond that, and to the fullest extent permitted by law, the Services are provided "as is" and "as available", and we disclaim all other warranties, express or implied, including implied warranties of merchantability, fitness for a particular purpose, title and non-infringement.',
        },
        {
          kind: 'paragraph',
          text: 'In particular, we do not warrant that the Services will be uninterrupted or error-free; that contact data obtained from third-party providers is accurate, current or complete; that a verified address will remain deliverable; that generated content will be accurate; or that the Services will produce any particular volume of replies, meetings, pipeline or revenue.',
        },
      ],
    },
    {
      id: 'liability',
      heading: '14. Limitation of liability',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Neither of us is liable to the other for indirect, incidental, special, consequential, exemplary or punitive damages, or for lost profits, lost revenue, lost business opportunity, lost goodwill or loss of data, even if advised that such damages were possible.',
        },
        {
          kind: 'paragraph',
          text: 'Each party\'s total aggregate liability arising out of or relating to this agreement is limited to the total fees you paid or owed us for the Services in the twelve months before the event giving rise to the claim.',
        },
        {
          kind: 'paragraph',
          text: 'That cap does not apply to: your obligation to pay fees; either party\'s indemnification obligations under section 15; a party\'s breach of section 10 (confidentiality); your breach of section 11 (our intellectual property); or liability that cannot be limited by law, including fraud, fraudulent misrepresentation, and death or personal injury caused by negligence.',
        },
        {
          kind: 'paragraph',
          text: 'These limits apply regardless of the form of action and even if a limited remedy fails of its essential purpose. They reflect an agreed allocation of risk between two businesses and are part of the basis on which the fees were set.',
        },
      ],
    },
    {
      id: 'indemnity',
      heading: '15. Indemnification',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You will defend us against any third-party claim arising from your breach of section 5 (your responsibilities) or the Acceptable Use Policy, from the content of emails sent from your mailboxes, from your material, or from your violation of applicable law — including a claim by a recipient, a regulator or an attorney general relating to a campaign we ran on your instructions — and will indemnify us for damages and costs finally awarded or agreed in settlement.',
        },
        {
          kind: 'paragraph',
          text: 'We will defend you against any third-party claim that the Services as provided by us infringe that party\'s intellectual property rights, and will indemnify you for damages and costs finally awarded or agreed in settlement. If such a claim is made we may, at our option, modify the Services, obtain a licence, or terminate and refund fees prepaid for the unused period. This does not apply to a claim arising from your material, from your use of the Services in breach of this agreement, or from combination with anything we did not supply.',
        },
        {
          kind: 'paragraph',
          text: 'The indemnified party must notify the other promptly, give reasonable cooperation, and let the indemnifying party control the defence. No settlement that admits liability or imposes an obligation on the indemnified party may be made without its consent.',
        },
      ],
    },
    {
      id: 'law',
      heading: '16. Governing law and disputes',
      blocks: [
        {
          kind: 'paragraph',
          text: `This agreement is governed by the laws of the State of ${GOVERNING_STATE}, without regard to its conflict of law rules. The United Nations Convention on Contracts for the International Sale of Goods and the Uniform Computer Information Transactions Act do not apply.`,
        },
        {
          kind: 'paragraph',
          text: 'If a dispute arises, the party raising it will give the other written notice describing it. Both of us will then attempt in good faith to resolve it through discussion between people with authority to settle, for at least 30 days from that notice, before starting arbitration.',
        },
        {
          kind: 'paragraph',
          text: `If it is not resolved in that period, the dispute will be finally settled by binding arbitration administered by the American Arbitration Association under its Commercial Arbitration Rules, before a single arbitrator, seated in ${GOVERNING_STATE}, United States, conducted in English. The arbitrator will issue a reasoned written award, and judgment on the award may be entered in any court of competent jurisdiction. Both of us understand that we are giving up the right to a court trial and to a jury.`,
        },
        {
          kind: 'paragraph',
          text: `Arbitration is limited to the dispute between us individually. Neither of us may bring a claim as a class, collective or representative action, or consolidate it with another proceeding, without the other's consent. Either of us may instead bring a claim in the small-claims court of ${GOVERNING_STATE} if it qualifies, and either of us may go to court at any time for interim or injunctive relief, or to protect intellectual property or confidential information. For any dispute that proceeds in court, we both submit to the exclusive jurisdiction of the state and federal courts located in ${GOVERNING_STATE} and waive objections to venue.`,
        },
        {
          kind: 'paragraph',
          text: 'If any part of this section is held unenforceable, the rest remains in force, and the affected dispute will be decided by the courts named above.',
        },
      ],
    },
    {
      id: 'general',
      heading: '17. General',
      blocks: [
        {
          kind: 'list',
          items: [
            'Entire agreement. These terms, together with the incorporated policies and any order form or statement of work, are the entire agreement between us about the Services and replace anything said or written before.',
            'Notices. We may give notice by email to the addresses on your account or by posting in the console. You may give notice to us at the address in section 18. Notice by email is effective when sent, absent a delivery failure.',
            'Electronic dealing. You agree that electronic signatures, records and communications satisfy any requirement that an agreement or notice be in writing.',
            'Assignment. Neither of us may assign this agreement without the other\'s consent, except to a successor in a merger, acquisition or sale of substantially all assets, on notice.',
            'Subcontracting. We may use subcontractors and subprocessors to provide the Services, and remain responsible for their performance.',
            'No waiver. A failure to enforce a right is not a waiver of it.',
            'Severability. If a provision is held unenforceable, it is modified to the minimum extent needed or severed, and the rest stands.',
            'No partnership. Nothing here creates a partnership, joint venture, employment or agency relationship, and neither of us may bind the other.',
            'Force majeure. Neither of us is liable for a delay or failure caused by something beyond its reasonable control, other than an obligation to pay.',
            'Export and sanctions. Each of us will comply with applicable export control and sanctions laws, and you confirm you are not subject to any sanctions programme that would prohibit us from providing the Services.',
            'Construction. Neither of us will have this agreement construed against it merely because it drafted the wording. Headings are for convenience only.',
            'Third parties. Nobody other than the two of us has any right to enforce this agreement.',
          ],
        },
      ],
    },
    {
      id: 'contact',
      heading: '18. How to reach us',
      blocks: [
        {
          kind: 'paragraph',
          text: `To resolve a complaint or ask about these terms, email ${CONTACT_EMAIL}, call ${CONTACT_PHONE}, or write to ${LEGAL_ENTITY}, ${CONTACT_ADDRESS_INLINE}.`,
        },
      ],
    },
  ],
}
