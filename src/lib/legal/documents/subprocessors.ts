import type { LegalDocument } from '@/lib/legal/document'
import { LEGAL_UPDATED_AT } from '@/lib/legal/document'
import { CONTACT_EMAIL, PRODUCT_NAME } from '@/lib/legal/contact'

/**
 * The subprocessor list.
 *
 * Kept as its own document so it can be updated on its own cadence and pointed
 * at from the DPA, the privacy notice and a procurement questionnaire alike.
 * Every entry here corresponds to a service the pipeline actually calls; adding
 * an integration means adding a row before it ships.
 */
export const subprocessors: LegalDocument = {
  slug: 'subprocessors',
  title: 'Subprocessors',
  description:
    'Every third-party service that processes personal data on behalf of Shengul AI, what each one does, and where it processes data.',
  summary: `These are the companies we rely on to run ${PRODUCT_NAME}. Each processes personal data on our instructions, under a written contract with confidentiality, security and data-protection terms at least as protective as our own.`,
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      id: 'current-list',
      heading: '1. Current subprocessors',
      blocks: [
        {
          kind: 'table',
          columns: ['Provider', 'What it does for us', 'Personal data involved', 'Primary location'],
          rows: [
            [
              'Supabase, Inc.',
              'Database, authentication and file storage — the system of record for accounts, campaigns, contacts, research and email threads',
              'All categories held by the service',
              'United States',
            ],
            [
              'Vercel, Inc.',
              'Application hosting, serverless execution and content delivery',
              'Account data, technical and log data, and any data in transit through the application',
              'United States',
            ],
            [
              'Apollo.io (ZenLeads, Inc.)',
              'Sourcing business contacts matching a client\'s buyer profile, and revealing and verifying work email addresses',
              'Business contact details — name, job title, employer, work email, professional profile',
              'United States',
            ],
            [
              'Emailable, Inc.',
              'Independent second check that a work email address is deliverable before anything is sent',
              'Work email addresses',
              'United States',
            ],
            [
              'Bright Data Ltd.',
              'Retrieving publicly available web results used to research a target company',
              'Company and contact names used as search terms',
              'Israel, with infrastructure in the United States and the European Union',
            ],
            [
              'Google LLC',
              'Gemini large language models, used to draft research summaries, emails, follow-ups and replies; and the Gmail API, where a client has connected a Google mailbox',
              'Contact details, research dossiers and email content sent as model input; mailbox content for connected Google mailboxes',
              'United States',
            ],
            [
              'Microsoft Corporation',
              'Microsoft Graph mail APIs, where a client has connected an Outlook or Microsoft 365 mailbox',
              'Mailbox content for connected Microsoft mailboxes',
              'United States',
            ],
            [
              'Upstash, Inc.',
              'Scheduling and delivering the background jobs that run the pipeline, including delayed follow-ups',
              'Record identifiers only — no contact details or message content',
              'United States',
            ],
          ],
        },
        {
          kind: 'paragraph',
          text: 'Where a client connects a mailbox using SMTP and IMAP instead of Google or Microsoft, their own mail host processes the messages. That host is chosen by the client, not by us, and is not our subprocessor.',
        },
      ],
    },
    {
      id: 'model-training',
      heading: '2. Model training',
      blocks: [
        {
          kind: 'callout',
          text: 'We use the language-model providers above under terms that prohibit them from using our data — including client content and contact data — to train their general-purpose models. We do not train any model on one client\'s data for the benefit of another, and we do not sell or license client data to anyone.',
        },
      ],
    },
    {
      id: 'obligations',
      heading: '3. What we require of them',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Before we engage a subprocessor we assess its security and privacy practices, and we put in place a written contract that:',
        },
        {
          kind: 'list',
          items: [
            'Limits processing to our documented instructions and the purpose described above.',
            'Imposes confidentiality obligations on its personnel.',
            'Requires appropriate technical and organisational security measures.',
            'Requires it to assist us with data-subject requests and breach notification.',
            'Requires deletion or return of the data when the engagement ends.',
            'Applies equivalent obligations to any onward subprocessor it uses.',
            'Includes an approved transfer mechanism where personal data leaves the EEA, UK or Switzerland.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We remain responsible to our clients for a subprocessor\'s performance of these obligations.',
        },
      ],
    },
    {
      id: 'changes',
      heading: '4. Changes to this list',
      blocks: [
        {
          kind: 'paragraph',
          text: `We will give clients at least 30 days' notice before adding or replacing a subprocessor, by updating this page and emailing the notice addresses on the account. To receive that notice, email ${CONTACT_EMAIL} and ask to be added to the subprocessor notification list.`,
        },
        {
          kind: 'paragraph',
          text: 'A client may object on reasonable data-protection grounds within those 30 days, as described in section 6 of the Data Processing Addendum at /legal/data-processing-addendum. If we cannot resolve the objection, the client may terminate the affected part of the Services and receive a refund of fees prepaid for the unused period.',
        },
        {
          kind: 'paragraph',
          text: 'We may engage a replacement subprocessor immediately, without prior notice, where it is necessary to keep the Services running or to address a security risk. We will update this page and notify clients as soon as we can afterwards.',
        },
      ],
    },
  ],
}
