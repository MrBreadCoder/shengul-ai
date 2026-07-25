import type { LegalDocument } from '@/lib/legal/document'
import { LEGAL_UPDATED_AT } from '@/lib/legal/document'
import { CONTACT_EMAIL, LEGAL_ENTITY, PRODUCT_NAME } from '@/lib/legal/contact'

/**
 * The data processing addendum.
 *
 * Required by any client with European recipients and asked for by most
 * mid-market buyers regardless. Structured to double as the Annex I and Annex II
 * content of the Standard Contractual Clauses, so a client's counsel can map it
 * straight across instead of sending a questionnaire.
 */
export const dataProcessingAddendum: LegalDocument = {
  slug: 'data-processing-addendum',
  title: 'Data Processing Addendum',
  description:
    'The processor terms for personal data Shengul AI handles for a client: security, subprocessors, data-subject requests, breaches, deletion and transfers.',
  summary: `This addendum applies whenever ${LEGAL_ENTITY} processes personal data on a client's behalf through ${PRODUCT_NAME}. It forms part of our Terms of Service and takes precedence over them on anything concerning personal data.`,
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      id: 'roles',
      heading: '1. Roles and scope',
      blocks: [
        {
          kind: 'paragraph',
          text: 'For personal data processed to operate a client\'s campaigns — the business contacts we source, verify, research and email, the content of those threads, and the client\'s own knowledge base — the client is the controller and we are the processor. This addendum governs that processing.',
        },
        {
          kind: 'paragraph',
          text: 'For account administration, billing, security and improving the Services, we are a controller in our own right. That processing is governed by our Privacy Notice at /legal/privacy-policy, not by this addendum.',
        },
        {
          kind: 'paragraph',
          text: '"Data Protection Law" means every privacy and data protection law applicable to the processing, including the EU General Data Protection Regulation, the UK GDPR and Data Protection Act 2018, the Swiss Federal Act on Data Protection, and US state privacy laws including the California Consumer Privacy Act as amended. Terms such as controller, processor, personal data, processing, data subject and personal data breach have the meanings given in the applicable law.',
        },
        {
          kind: 'paragraph',
          text: 'This addendum is incorporated into the Terms of Service. It needs no signature to take effect, but we will sign a copy on request.',
        },
      ],
    },
    {
      id: 'details',
      heading: '2. Details of the processing',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This section is the description of processing required by Article 28(3) GDPR, and serves as Annex I to the Standard Contractual Clauses where those apply.',
        },
        {
          kind: 'table',
          columns: ['Item', 'Detail'],
          rows: [
            ['Subject matter', 'Operation of a managed business-to-business outbound programme on the client\'s instructions'],
            ['Duration', 'The term of the agreement, plus the retention periods in section 10'],
            ['Nature and purpose', 'Sourcing and verifying business contacts; researching target companies; generating, sending and following up on emails; receiving and responding to replies; maintaining suppression records; reporting'],
            ['Categories of data subjects', 'The client\'s personnel who use the console; business contacts at target companies; anyone who replies to a campaign email'],
            ['Categories of personal data', 'Name; job title; seniority; employer and employer domain; professional profile URL; work email address and its verification status; the source record from the contact database; research about the employer; email content in both directions; suppression status; console account and activity records; technical and log data'],
            ['Special category data', 'None. The Services are not designed for it and the client must not submit it'],
            ['Frequency of transfer', 'Continuous, for the duration of the agreement'],
            ['Retention', 'As set out in section 10 of this addendum and the retention table in the Privacy Notice'],
          ],
        },
      ],
    },
    {
      id: 'our-obligations',
      heading: '3. Our obligations',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We will:',
        },
        {
          kind: 'list',
          items: [
            'Process personal data only on the client\'s documented instructions, which consist of this addendum, the Terms of Service, the campaign configuration the client sets, and any further written instruction the client gives — unless we are required to process by law, in which case we will tell the client first unless the law forbids it.',
            'Tell the client if, in our opinion, an instruction infringes Data Protection Law. We may suspend the affected processing until the instruction is withdrawn or amended.',
            'Ensure that everyone we authorise to process the data is bound by a duty of confidentiality.',
            'Implement and maintain the security measures in section 5.',
            'Engage subprocessors only on the terms in section 6.',
            'Assist the client with data-subject requests as described in section 7.',
            'Assist the client with security, breach notification, data protection impact assessments and prior consultation, taking into account the nature of the processing and the information available to us.',
            'Delete or return personal data as described in section 10.',
            'Make available the information needed to demonstrate compliance, and allow audits as described in section 11.',
          ],
        },
        {
          kind: 'callout',
          text: 'We do not sell personal data, we do not share it for cross-context behavioural advertising, and we do not retain, use or disclose it for any purpose other than performing the Services. We do not combine a client\'s personal data with data from another source except as permitted by Data Protection Law. We certify that we understand these restrictions and will comply with them.',
        },
      ],
    },
    {
      id: 'client-obligations',
      heading: '4. Client obligations',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The client will:',
        },
        {
          kind: 'list',
          items: [
            'Comply with Data Protection Law in its own right, including in the buyer profile it asks us to target and the content it asks us to send.',
            'Have and maintain a lawful basis for the processing it instructs, including for contacting the people the campaign reaches, and complete any balancing assessment its own reliance on legitimate interests requires.',
            'Provide any notice and obtain any consent that the law requires of it as controller.',
            'Not instruct us to process special category data, data about children, or data subject to sectoral regulation the Services are not built for.',
            'Keep console access limited to people who need it, and remove access promptly when they do not.',
            'Pass on to us any opt-out, objection or erasure request it receives directly, so the suppression list stays accurate.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We publish a summary of our own legitimate-interests assessment for outbound contact on request, and a client is welcome to rely on it as an input to its own — but it does not replace the client\'s assessment.',
        },
      ],
    },
    {
      id: 'security',
      heading: '5. Security measures',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This section serves as Annex II to the Standard Contractual Clauses where those apply. The measures are those actually in place:',
        },
        {
          kind: 'list',
          items: [
            'Encryption in transit — all traffic to and from the Services and between the Services and subprocessors runs over TLS.',
            'Encryption at rest — stored data is encrypted at the disk level by our infrastructure provider.',
            'Application-level encryption of credentials — mailbox OAuth tokens and SMTP credentials are additionally sealed with AES-256-GCM using a key held outside the database before they are written.',
            'Tenant isolation — every table holding client data carries the owning client identifier, and row-level security in the database enforces isolation independently of application code.',
            'Access control — accounts are created by invitation only, with role separation between operator and client accounts; there is no public sign-up; staff access to production data is limited to those who need it.',
            'Request authentication — internal scheduled jobs are authenticated by cryptographic request signature.',
            'Auditability — every state change and automated decision is written to an append-only audit log with retention as stated in section 10.',
            'Data minimisation in mailbox access — inbound mail is evaluated in memory and only messages from contacts the campaign has already written to are stored; everything else is discarded without being persisted.',
            'Resilience and recovery — managed infrastructure with automated backups and point-in-time recovery.',
            'Secure development — typed codebase with automated tests, dependency management and code review before release.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We review these measures periodically and may change them, provided the level of protection is not reduced.',
        },
      ],
    },
    {
      id: 'subprocessors',
      heading: '6. Subprocessors',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The client gives general written authorisation for us to engage subprocessors. The current list, with the role and location of each, is at /legal/subprocessors.',
        },
        {
          kind: 'paragraph',
          text: 'We will give at least 30 days\' notice before adding or replacing a subprocessor. A client may object within that period on reasonable grounds relating to data protection, by writing to the address in section 14. We will work in good faith to address the objection; if we cannot, the client may terminate the affected part of the Services and receive a refund of fees prepaid for the unused period. That is the client\'s exclusive remedy for an objection.',
        },
        {
          kind: 'paragraph',
          text: 'We impose data protection obligations on each subprocessor that are no less protective than those in this addendum, and we remain fully liable to the client for each subprocessor\'s performance.',
        },
      ],
    },
    {
      id: 'data-subject-requests',
      heading: '7. Data subject requests',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Taking into account the nature of the processing, we will assist the client by appropriate technical and organisational measures — insofar as this is possible — in responding to requests to exercise rights of access, rectification, erasure, restriction, portability and objection.',
        },
        {
          kind: 'paragraph',
          text: 'If a request reaches us directly, we will not respond to it substantively on the client\'s behalf unless the client instructs us to or the law requires it. We will tell the client without undue delay.',
        },
        {
          kind: 'callout',
          text: 'One exception, and it is deliberate: a request to stop being contacted is acted on immediately, whoever it reaches. We suppress the address and stop the sequence at once, and then tell the client. Sitting on an objection while we wait for an instruction is not a defensible way to run this service.',
        },
      ],
    },
    {
      id: 'breach',
      heading: '8. Personal data breaches',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We will notify the client without undue delay, and in any event within 48 hours, after becoming aware of a personal data breach affecting personal data we process for them.',
        },
        {
          kind: 'paragraph',
          text: 'The notification will describe the nature of the breach and, so far as we know it, the categories and approximate number of data subjects and records concerned, the likely consequences, and the measures taken or proposed. Where we cannot provide all of it at once we will provide it in phases without further undue delay.',
        },
        {
          kind: 'paragraph',
          text: 'We will cooperate with the client and take the steps it reasonably requests to investigate and remediate. Notifying supervisory authorities and data subjects is the controller\'s decision and responsibility; we will assist. Notification is not an admission of fault by either of us.',
        },
      ],
    },
    {
      id: 'transfers',
      heading: '9. International transfers',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We process personal data in the United States, and our subprocessors process it in the locations listed at /legal/subprocessors.',
        },
        {
          kind: 'paragraph',
          text: 'Where we process personal data subject to the EU GDPR that is transferred out of the EEA to a country without an adequacy decision, the Standard Contractual Clauses approved by the European Commission (Decision 2021/914) are incorporated into this addendum by reference, with the client as data exporter and us as data importer, Module Two (controller to processor) applying. Section 2 completes Annex I, section 5 completes Annex II, and /legal/subprocessors completes Annex III. Docking clause 7 applies; the option in clause 9(a) is general written authorisation with a 30-day notice period; clause 11(a) does not include the optional independent dispute resolution body; the governing law under clause 17 is that of Ireland and the forum under clause 18 is the courts of Ireland.',
        },
        {
          kind: 'paragraph',
          text: 'Where the UK GDPR applies, the UK International Data Transfer Addendum to the Standard Contractual Clauses is incorporated, with the tables completed by reference to this addendum and neither party able to terminate under section 19 of that addendum. Where the Swiss FADP applies, the Standard Contractual Clauses apply with references read as references to the FADP, the Swiss Federal Data Protection and Information Commissioner as the supervisory authority, and the clauses extending to data about legal entities to the extent Swiss law requires.',
        },
        {
          kind: 'paragraph',
          text: 'We will notify the client if we become unable to comply with these clauses, and the client may suspend the transfer or terminate the affected part of the Services.',
        },
      ],
    },
    {
      id: 'retention',
      heading: '10. Retention, deletion and return',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We retain personal data for the periods set out in the retention table in the Privacy Notice at /legal/privacy-policy.',
        },
        {
          kind: 'paragraph',
          text: 'On termination of the agreement, at the client\'s choice, we will delete or return the personal data we process for them, and delete existing copies, within 90 days — unless the law requires us to keep it. A client may request an export in a machine-readable format at any time up to 30 days after termination.',
        },
        {
          kind: 'callout',
          text: 'Suppression records are the exception. We keep an address that asked not to be contacted, and only that address and the fact of the request, for as long as we operate the service. Deleting a suppression record would let the same person be contacted again by the next campaign, which is the opposite of what they asked for. Retaining it is necessary to comply with their objection.',
        },
        {
          kind: 'paragraph',
          text: 'Personal data held in encrypted backups is isolated from further processing and deleted when the backup rotates.',
        },
      ],
    },
    {
      id: 'audit',
      heading: '11. Audits and information',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We will make available to the client the information reasonably necessary to demonstrate compliance with this addendum, and will respond to a reasonable security questionnaire once in any twelve-month period.',
        },
        {
          kind: 'paragraph',
          text: 'Where that is not sufficient for the client to meet an obligation under Data Protection Law, the client may audit our processing, at its own cost, no more than once in any twelve-month period unless a supervisory authority requires more or a breach has occurred. An audit must be requested at least 30 days in advance, be conducted during business hours, not unreasonably disrupt our operations, be subject to confidentiality, and not extend to another client\'s data or to the data of another client\'s data subjects.',
        },
      ],
    },
    {
      id: 'us-state-law',
      heading: '12. United States state privacy law',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Where the California Consumer Privacy Act applies, we act as a "service provider" and the client as a "business", each as defined in that Act. We are prohibited from, and will not: sell or share personal information; retain, use or disclose it for any purpose other than performing the Services specified in the agreement, including for a commercial purpose other than those services; retain, use or disclose it outside the direct business relationship between us; or combine it with personal information received from another source, except as permitted by the Act.',
        },
        {
          kind: 'paragraph',
          text: 'We will notify the client if we determine we can no longer meet these obligations, and the client may take reasonable steps to stop and remediate unauthorised use. Equivalent terms apply, and equivalent roles are taken, under the comparable laws of Colorado, Connecticut, Texas, Virginia and other states as applicable.',
        },
      ],
    },
    {
      id: 'liability',
      heading: '13. Liability and precedence',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Each party\'s liability under this addendum is subject to the limitations and exclusions in the Terms of Service, except to the extent Data Protection Law does not permit that.',
        },
        {
          kind: 'paragraph',
          text: 'If this addendum conflicts with the Terms of Service or any order form on a matter concerning personal data, this addendum prevails. If this addendum conflicts with the Standard Contractual Clauses, the Clauses prevail.',
        },
        {
          kind: 'paragraph',
          text: 'We may update this addendum to reflect a change in law, in our subprocessors, or in how the Services work, provided the change does not reduce the protection given to personal data. Material changes are notified as described in the Terms of Service.',
        },
      ],
    },
    {
      id: 'contact',
      heading: '14. Contact',
      blocks: [
        {
          kind: 'paragraph',
          text: `Data protection questions, objections to a subprocessor, audit requests and requests for a signed copy of this addendum or of the Standard Contractual Clauses should go to ${CONTACT_EMAIL}, marked for the attention of the data protection contact. Full contact details are at the foot of this page.`,
        },
      ],
    },
  ],
}
