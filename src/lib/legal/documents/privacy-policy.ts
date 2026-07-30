import type { LegalDocument } from '@/lib/legal/document'
import {
  CONTACT_ADDRESS_INLINE,
  CONTACT_EMAIL,
  LEGAL_ENTITY,
  PRODUCT_NAME,
} from '@/lib/legal/contact'

/**
 * The privacy notice.
 *
 * Written around the fact that most of the personal data this service touches
 * belongs to people who have never visited the site: prospects sourced from
 * Apollo, researched, and emailed. A notice that only addresses account holders
 * describes a minority of the processing, so this one names both audiences in
 * the first section and keeps them separate throughout.
 */
export const privacyPolicy: LegalDocument = {
  slug: 'privacy-policy',
  title: 'Privacy Notice',
  description:
    'How Shengul AI collects and uses personal information — both for the people who hold accounts and for the business contacts our outbound service reaches.',
  summary: `This notice explains what ${LEGAL_ENTITY} does with personal information when you use ${PRODUCT_NAME}, and what we do with the business-contact information we process on behalf of our clients when we run outbound campaigns for them.`,
  updatedAt: '2026-07-29',
  sections: [
    {
      id: 'who-this-covers',
      heading: '1. Who this notice covers',
      blocks: [
        {
          kind: 'paragraph',
          text: `${LEGAL_ENTITY} operates ${PRODUCT_NAME}, a managed business-to-business outbound service. A client tells us which kind of buyer they want to meet; we find people matching that description, research their companies, write to them from the client's own mailbox, handle the replies, and pass the resulting meetings back to the client.`,
        },
        {
          kind: 'paragraph',
          text: 'That business model means we hold personal information about two very different groups of people, with different rights and different expectations. This notice addresses both, and says which of the two it is talking about in every section.',
        },
        {
          kind: 'list',
          items: [
            'Client users — people at our client companies who hold an account and sign in to the console, and people at prospective client companies who contact us or book a call.',
            'Business contacts — people at other companies whom a client has asked us to reach. If you received an email from a campaign we operate, this is you, and section 5 is written for you.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'There is no self-service sign-up. Console accounts exist only because we created them for a client we have a contract with.',
        },
      ],
    },
    {
      id: 'our-role',
      heading: '2. Our role: controller and processor',
      blocks: [
        {
          kind: 'paragraph',
          text: 'For account information, billing and marketing relationships, and for the operation and security of the service itself, we act as a controller: we decide why and how the information is processed.',
        },
        {
          kind: 'paragraph',
          text: 'For campaign data — the business contacts we source, research and email on a client\'s instructions, together with the contents of those email threads and the client\'s own knowledge base — we act as a processor on behalf of that client, who is the controller. Our obligations in that role, and the client\'s, are set out in our Data Processing Addendum at /legal/data-processing-addendum.',
        },
        {
          kind: 'paragraph',
          text: 'Where we decide independently which sources to draw contacts from and how to verify them, we and the client may be joint controllers for that step. In practice this means a business contact can exercise their rights against either of us, and we will honour a request regardless of which of us it reaches. See section 12.',
        },
      ],
    },
    {
      id: 'client-users',
      heading: '3. Information we collect about client users',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We collect the following directly from you or from the client that asked us to create your account:',
        },
        {
          kind: 'list',
          items: [
            'Account information — name, work email address, the client organisation you belong to, your role in the console (operator or client), and an authentication credential. Passwords are stored only as salted hashes by our authentication provider; we never see or store your password in readable form.',
            'Console activity — the actions you take in the console, such as approving a draft, answering a knowledge request, or creating a campaign, recorded in our audit log against your account.',
            'Content you provide — campaign settings, your value proposition, booking links, brand assets, and any documents you upload to your knowledge base so that the system can answer questions about your business accurately.',
            'Mailbox connection details — see section 4.',
            'Correspondence — messages you send us by email, and notes from calls or onboarding.',
            'Technical and log data — IP address, browser and device type, timestamps, requested pages and error diagnostics, collected automatically when you use the console.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We do not ask for and do not want special category data — information revealing racial or ethnic origin, political opinions, religious beliefs, trade union membership, genetic or biometric data, health, sex life or sexual orientation. We do not knowingly process it. We do not collect payment card numbers or bank details through the service; fees are invoiced outside the platform under the commercial terms agreed with each client.',
        },
        {
          kind: 'paragraph',
          text: 'We do not offer social or third-party sign-in, and we do not receive profile information, friend lists, contact lists or address books from any social network.',
        },
      ],
    },
    {
      id: 'mailbox-access',
      heading: '4. Mailbox access, and what we do with it',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The service sends from a client\'s own mailbox rather than from a bulk sending platform, because that is what makes the mail read as a person writing rather than a campaign arriving. To do that we need the client to connect a mailbox, using Google or Microsoft\'s own consent screen, or by supplying SMTP and IMAP credentials.',
        },
        {
          kind: 'paragraph',
          text: 'A connected mailbox grants us permission to send mail as that address and to read newly arriving mail. We use the read permission for exactly one purpose: to notice when somebody replies to an email we sent, so that the follow-up sequence stops and the reply can be handled.',
        },
        {
          kind: 'callout',
          text: 'When we check a connected mailbox we look only at messages that have arrived since the last check. A message is stored in our systems only if its sender address matches a contact that the campaign has already written to. Anything else — ordinary correspondence, internal mail, newsletters — is discarded in memory without ever being written to our database.',
        },
        {
          kind: 'paragraph',
          text: 'Automated bounce notifications and out-of-office replies are detected and used to protect sending reputation, and are not treated as a human reply.',
        },
        {
          kind: 'paragraph',
          text: 'Mailbox credentials and OAuth tokens are encrypted with AES-256-GCM using a key held outside the database, before they are written to storage. A client can revoke a connection at any time, from their Google or Microsoft account or by removing the mailbox in the console; sending stops immediately and no further mail is read.',
        },
        {
          kind: 'callout',
          text: 'Google API Services Limited Use. Our use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. Specifically: we use Gmail data only to provide and improve the user-facing features described in this notice; we do not transfer it except as necessary to provide those features, to comply with applicable law, or as part of a merger or acquisition; we do not use it to serve advertising; and we do not allow humans to read it except with the client\'s explicit consent, to resolve a specific support issue the client has raised, where required by law, or on data that has been aggregated and de-identified for security or operational purposes.',
        },
      ],
    },
    {
      id: 'business-contacts',
      heading: '5. Information we process about business contacts',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If you received an email from a campaign we operate, this section explains where your details came from and what we hold. A shorter, plain-language version is published at /legal/outreach-privacy-notice.',
        },
        {
          kind: 'paragraph',
          text: 'We did not get your details from you. We obtained them from a commercial business-contact database, and we then checked and added to them. Concretely, we may hold:',
        },
        {
          kind: 'list',
          items: [
            'Your name, job title, employer, the employer\'s web domain, and your public professional profile URL.',
            'Your work email address, together with the verification result that told us it was a real, deliverable address. We do not guess addresses from name patterns.',
            'The underlying record as supplied by our data provider, kept so that we can show where a detail came from and correct it.',
            'Research about your employer, compiled from publicly available web sources and summarised by an automated system, with the source link kept alongside each statement.',
            'The emails we sent you, any reply you sent back, and the state of the conversation.',
            'If you asked not to be contacted, your email address on a suppression list, so that we do not contact you again.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We process information about you in your professional capacity only. We do not knowingly build profiles of individuals outside a work context, and we do not process special category data about you.',
        },
        {
          kind: 'paragraph',
          text: 'The sources we draw on are named in section 8 and listed in full at /legal/subprocessors.',
        },
      ],
    },
    {
      id: 'how-we-use',
      heading: '6. How we use personal information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'For client users:',
        },
        {
          kind: 'list',
          items: [
            'To create accounts, authenticate sign-in, and keep the console working.',
            'To deliver the outbound service the client has engaged us for, and to report on it.',
            'To answer support questions and escalate the questions the system cannot answer.',
            'To send service messages — changes to these documents, security notices, and operational alerts. These are not marketing and cannot be unsubscribed from while an account is open.',
            'To secure the service, investigate abuse, and keep an audit record of who did what.',
            'To meet legal, tax and accounting obligations.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'For business contacts:',
        },
        {
          kind: 'list',
          items: [
            'To determine whether you fit the buyer description a client gave us.',
            'To confirm that your work email address is real and deliverable before anything is sent, so that we do not mail dead addresses.',
            'To research your employer so that an email refers to something true about your business rather than to a merge field.',
            'To write and send a small number of relevant emails, and to follow up if there is no answer.',
            'To read and respond to your reply, to stop the sequence when you answer, and to pass a genuine conversation to a person at the client.',
            'To record and honour a request not to be contacted.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We do not use any personal information to serve advertising, we do not build advertising profiles, and we do not operate a marketing exchange. We do not sell personal information, and we do not share it for cross-context behavioural advertising.',
        },
      ],
    },
    {
      id: 'automated-processing',
      heading: '7. Automated processing and artificial intelligence',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Substantial parts of this service are automated, and we would rather state that plainly than bury it.',
        },
        {
          kind: 'list',
          items: [
            'Selecting which contacts to approach, and grouping contacts by employer, is done by ordinary rule-based code against the buyer description a client supplied. No language model is involved in that decision.',
            'Verifying an email address is done by two independent providers. Only an address confirmed deliverable is used.',
            'Research summaries, outbound emails, follow-ups and replies are drafted by a large language model — Google Gemini — from the research dossier and the client\'s own knowledge base.',
            'Depending on the client\'s configuration, a drafted email may be sent automatically, or may be held for a person at the client to read and approve first.',
            'When the model cannot answer a question truthfully from what it knows, it is required to stop and ask a person at the client rather than invent an answer. Anything touching price or a commercial commitment is always escalated to a person.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Content sent to the model may include your name, job title, employer, the research dossier about your employer, and the text of the email thread. We use these providers under contracts that prohibit them from using our data to train their general models.',
        },
        {
          kind: 'paragraph',
          text: 'None of this automated processing produces a legal effect concerning you or similarly significantly affects you: the outcome is an email, which you are free to ignore. If you believe an automated decision has affected you significantly, contact us and we will review it manually.',
        },
        {
          kind: 'paragraph',
          text: 'We do not place tracking pixels in the emails we send, and we do not record whether you opened a message or clicked a link.',
        },
      ],
    },
    {
      id: 'sharing',
      heading: '8. Who we share information with',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We share personal information with service providers who process it on our instructions and under contract. The current list, with the role and location of each, is maintained at /legal/subprocessors. In summary, they cover hosting and databases, contact sourcing, email verification, web research, language models, email delivery and inbox access, and background job scheduling.',
        },
        {
          kind: 'paragraph',
          text: 'We also share personal information:',
        },
        {
          kind: 'list',
          items: [
            'With the client whose campaign a business contact belongs to — that client sees the contacts sourced for them, the research, and the email threads. That is the service.',
            'With professional advisers — lawyers, accountants, auditors — under a duty of confidentiality.',
            'Where we are legally required to, or where disclosure is necessary to establish, exercise or defend legal claims, or to protect the rights, property or safety of any person.',
            'In connection with a merger, acquisition, financing or sale of assets, in which case the recipient remains bound by this notice until it gives notice of any change.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We do not sell personal information, and we have not sold or shared personal information for cross-context behavioural advertising in the preceding twelve months.',
        },
      ],
    },
    {
      id: 'international',
      heading: '9. International transfers',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We are based in the United States and our infrastructure is operated in the United States. Some of our service providers process data in other countries; the location of each is stated at /legal/subprocessors.',
        },
        {
          kind: 'paragraph',
          text: 'Where personal information is transferred out of the European Economic Area, the United Kingdom or Switzerland, we rely on the European Commission\'s Standard Contractual Clauses, together with the UK International Data Transfer Addendum where the UK GDPR applies, and we assess whether additional safeguards are needed for the destination. A copy of the clauses we rely on for a specific transfer is available on request from the address in section 17.',
        },
      ],
    },
    {
      id: 'retention',
      heading: '10. How long we keep information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We keep personal information only as long as it serves the purpose it was collected for, or as long as the law requires. Our retention periods are:',
        },
        {
          kind: 'table',
          columns: ['What', 'How long'],
          rows: [
            ['Console account and profile', 'For as long as the account is open, then deleted within 30 days of the account being closed'],
            ['Client campaign data — contacts, research, cases and email threads', 'For the duration of the client engagement, then deleted or returned within 90 days of the engagement ending, unless the client instructs otherwise'],
            ['Client knowledge base documents and brand assets', 'Until the client deletes them, or within 90 days of the engagement ending'],
            ['Mailbox credentials and tokens', 'Until the mailbox is disconnected or the engagement ends, then deleted; a revoked token stops working immediately'],
            ['Routine activity log entries', '30 days'],
            ['Error and security log entries', '90 days'],
            ['Suppression list — addresses that asked not to be contacted', 'Kept indefinitely, and deliberately so: this is the only record that stops us contacting you again, and deleting it would defeat your own request'],
            ['Records needed for tax, accounting or legal claims', 'As long as the relevant limitation or statutory period requires'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Where deletion is not immediately possible because information sits in an encrypted backup, we isolate it from further processing and delete it when the backup rotates.',
        },
      ],
    },
    {
      id: 'security',
      heading: '11. How we protect information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The measures below are the ones actually in place, not an aspiration:',
        },
        {
          kind: 'list',
          items: [
            'All traffic runs over TLS, and stored data is encrypted at rest at the disk level.',
            'Mailbox credentials and OAuth tokens receive a second, application-level layer of AES-256-GCM encryption before they are written, with the key held outside the database.',
            'Every table holding client work carries the owning client\'s identifier, and row-level security in the database — not application code alone — enforces that a query can only return rows belonging to the signed-in user\'s organisation.',
            'Accounts are created by invitation only. There is no public sign-up.',
            'Internal scheduled jobs are authenticated by request signature, so an unauthenticated caller cannot trigger the pipeline.',
            'Every state change and agent decision is written to an append-only audit log.',
            'Access to production data by our staff is limited to those who need it to operate the service.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'No system is perfectly secure, and we cannot guarantee that a determined attacker will never defeat these measures. If a breach affects your personal information and the law requires us to tell you, we will, without undue delay.',
        },
      ],
    },
    {
      id: 'your-rights',
      heading: '12. Your rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Depending on where you live, you may have some or all of the following rights over your personal information: to know whether we process it and to get a copy; to have inaccurate information corrected; to have it deleted; to restrict or object to processing; to receive it in a portable format; to withdraw consent where we relied on consent; and not to be discriminated against for exercising any of these.',
        },
        {
          kind: 'callout',
          text: `You do not need an account to exercise these rights, and you do not need to explain why. Email ${CONTACT_EMAIL} and tell us what you want. If you are a business contact who received one of our emails, replying to that email and asking us to stop is enough — we will suppress your address and stop the sequence.`,
        },
        {
          kind: 'paragraph',
          text: 'Client users can also review and update their own account details in the console under Settings.',
        },
        {
          kind: 'paragraph',
          text: 'We will respond within the period the applicable law allows — one month under the UK and EU GDPR, and 45 days under most US state laws, each extendable once where the request is complex. We will tell you if we need longer. We may need to verify your identity before acting, and will only use what you give us for that purpose. An authorised agent may act for you if they provide written proof of authority.',
        },
        {
          kind: 'paragraph',
          text: 'Where we act as a processor for a client, we will pass your request to that client and support them in answering it, and we will tell you that we have done so.',
        },
        {
          kind: 'paragraph',
          text: 'If we refuse a request, we will tell you why, and you may appeal by replying to our decision. If your appeal is refused you may complain to your state attorney general, to your EU member state supervisory authority, to the UK Information Commissioner\'s Office, or to the Swiss Federal Data Protection and Information Commissioner, as applicable.',
        },
      ],
    },
    {
      id: 'legal-bases',
      heading: '13. Legal bases (EEA, UK and Switzerland)',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If the GDPR or UK GDPR applies to you, we rely on the following legal bases:',
        },
        {
          kind: 'table',
          columns: ['Processing', 'Legal basis'],
          rows: [
            ['Operating console accounts and delivering the service to a client', 'Performance of a contract, or steps taken at your request before entering one'],
            ['Sourcing, verifying, researching and emailing business contacts', 'Legitimate interests — our clients\' interest in reaching relevant business buyers, and our interest in operating the service, balanced against the limited intrusion of a small number of work-related emails'],
            ['Maintaining a suppression list', 'Legal obligation and legitimate interests — we cannot honour an objection without recording it'],
            ['Security, abuse prevention and audit logging', 'Legitimate interests in keeping the service safe and accountable'],
            ['Service and security notices', 'Legitimate interests, and legal obligation where the law requires notification'],
            ['Compliance with tax, accounting and legal obligations', 'Legal obligation'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Where we rely on legitimate interests to contact business people, we have carried out a balancing assessment. Its conclusions are reflected in how the service is built: we contact people only in a work capacity and at a work address, we verify the address rather than guess it, we cap volume per mailbox per day, we send a small number of messages rather than a campaign blast, we stop the moment somebody replies, and we suppress permanently on request. A summary of the assessment is available on request.',
        },
        {
          kind: 'callout',
          text: 'You have an absolute right to object to direct marketing. If you object, we stop — there is no balancing test to apply and we will not ask you to justify it.',
        },
        {
          kind: 'paragraph',
          text: 'Because we obtained your details from a third party rather than from you, we are also required to tell you what we hold, where it came from and how long we keep it. That is set out in sections 5, 8 and 10, and summarised at /legal/outreach-privacy-notice.',
        },
      ],
    },
    {
      id: 'us-states',
      heading: '14. United States state privacy rights',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If you live in California, Colorado, Connecticut, Delaware, Florida, Indiana, Iowa, Kentucky, Maryland, Minnesota, Montana, Nebraska, New Hampshire, New Jersey, Oregon, Rhode Island, Tennessee, Texas, Utah or Virginia, you have the rights described in section 12, and the categories of personal information we have collected in the past twelve months are:',
        },
        {
          kind: 'table',
          columns: ['Category', 'Examples', 'Collected'],
          rows: [
            ['A. Identifiers', 'Name, work email address, account name, IP address, online identifier', 'Yes'],
            ['B. Customer records (Cal. Civ. Code § 1798.80)', 'Name, contact details, employer and employment history', 'Yes'],
            ['C. Protected classifications', 'Age, gender, race, national origin, marital status', 'No'],
            ['D. Commercial information', 'Purchase history, financial details, payment information', 'No'],
            ['E. Biometric information', 'Fingerprints, voiceprints', 'No'],
            ['F. Internet or network activity', 'Log data, pages requested, interactions with the console', 'Yes'],
            ['G. Geolocation data', 'Precise device location', 'No'],
            ['H. Audio, electronic or sensory information', 'Call or video recordings', 'No'],
            ['I. Professional or employment information', 'Job title, employer, seniority, professional profile URL', 'Yes'],
            ['J. Education information', 'Student records', 'No'],
            ['K. Inferences', 'Whether a contact matches a client\'s buyer description; research summaries about an employer', 'Yes'],
            ['L. Sensitive personal information', 'Government identifiers, precise geolocation, contents of private communications not directed to us, health, race, religion, sexual orientation', 'No'],
          ],
        },
        {
          kind: 'paragraph',
          text: 'We may derive an approximate region from an IP address for security purposes; we do not collect precise device location. We do not collect or process sensitive personal information, so there is nothing for you to limit under California\'s right to limit the use of sensitive personal information.',
        },
        {
          kind: 'paragraph',
          text: 'We do not sell personal information and we do not share it for cross-context behavioural advertising, so there is no opt-out to exercise for those purposes. We honour the Global Privacy Control signal as an opt-out request in any case.',
        },
        {
          kind: 'paragraph',
          text: 'Under California\'s "Shine the Light" law, California residents may request once a year, free of charge, details of personal information disclosed to third parties for their direct marketing purposes. We make no such disclosures.',
        },
      ],
    },
    {
      id: 'cookies',
      heading: '15. Cookies',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The public site and the console always set the cookies strictly necessary to sign you in and keep you signed in. We also run Google Tag Manager, which can load analytics cookies — but only after you accept them in the on-site consent banner, and only for aggregate usage measurement. We do not use advertising cookies, we do not use analytics for advertising or ad personalization, and no third-party tracking runs before you have consented to it. The full list, and how to withdraw consent, is at /legal/cookie-policy.',
        },
        {
          kind: 'paragraph',
          text: 'There is no industry standard for honouring the Do Not Track browser setting, so we do not respond to it. We do honour the Global Privacy Control signal.',
        },
      ],
    },
    {
      id: 'minors',
      heading: '16. Children',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This is a business service. It is not directed at children, we do not knowingly collect information from anyone under 18, and we do not sell such information. If you believe a child has provided us with personal information, contact us and we will delete it.',
        },
      ],
    },
    {
      id: 'changes-and-contact',
      heading: '17. Changes, and how to reach us',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We will update this notice when our practices change. The date at the top shows when it last changed in substance. If a change is material we will tell account holders directly as well as posting it here.',
        },
        {
          kind: 'paragraph',
          text: `For any question about this notice, or to exercise a right, email ${CONTACT_EMAIL} or write to ${LEGAL_ENTITY} at ${CONTACT_ADDRESS_INLINE}. Full contact details are at the foot of this page.`,
        },
      ],
    },
  ],
}
