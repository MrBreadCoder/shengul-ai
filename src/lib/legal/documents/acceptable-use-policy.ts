import type { LegalDocument } from '@/lib/legal/document'
import { LEGAL_UPDATED_AT } from '@/lib/legal/document'
import { CONTACT_EMAIL, PRODUCT_NAME } from '@/lib/legal/contact'

/**
 * The acceptable use policy.
 *
 * The single most important document for a service that sends mail in somebody
 * else's name: without it, every obligation a client owes their recipients sits
 * with us by default. Incorporated into the terms of service, so a breach here
 * is a breach of contract.
 */
export const acceptableUsePolicy: LegalDocument = {
  slug: 'acceptable-use-policy',
  title: 'Acceptable Use Policy',
  description:
    'The rules for using Shengul AI: who may be contacted, what may be sent, how opt-outs are honoured, and what gets an account suspended.',
  summary: `This policy sets the limits on what ${PRODUCT_NAME} may be used for. It is part of our Terms of Service, and breaking it is a breach of contract that can get a campaign stopped without notice.`,
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      id: 'scope',
      heading: '1. Scope',
      blocks: [
        {
          kind: 'paragraph',
          text: 'This policy applies to everyone who uses the Services, and to every campaign we run on a client\'s instructions. It is incorporated into the Terms of Service at /legal/terms-of-service; defined terms there have the same meaning here.',
        },
        {
          kind: 'paragraph',
          text: 'It is not exhaustive. We may act on conduct that is plainly against the spirit of these rules even if no bullet below names it.',
        },
      ],
    },
    {
      id: 'who-you-may-contact',
      heading: '2. Who may be contacted',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The Services exist to start business conversations with business people. You may only ask us to target people you have a lawful basis to contact, and you must be able to explain that basis if a regulator or a recipient asks.',
        },
        {
          kind: 'paragraph',
          text: 'You may not use the Services to contact:',
        },
        {
          kind: 'list',
          items: [
            'Consumers, or people at a personal email address. This is a business-to-business service only.',
            'Anyone in a jurisdiction where the messages you want to send require prior consent you do not have. This includes, in most cases, personal email addresses in Canada under CASL, and jurisdictions with equivalent opt-in rules.',
            'Anyone who has told you, or told us, that they do not want to be contacted — whether the request reached us through a reply, through you, or through any other route.',
            'Anyone whose details you obtained unlawfully, or in breach of another platform\'s terms, and then asked us to load.',
            'Children, or anyone you know to be under 18.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We source contacts from a licensed commercial database and verify every address before use. If you supply your own list instead, you are confirming that you collected it lawfully, that you have a lawful basis to email everyone on it, and that it contains no address that has opted out.',
        },
      ],
    },
    {
      id: 'what-you-may-send',
      heading: '3. What may be sent',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Every message must accurately identify who is writing and what they want. You may not use the Services to send:',
        },
        {
          kind: 'list',
          items: [
            'Anything with a false, disguised or misleading sender name, reply-to address, domain or subject line, or that impersonates another person or organisation.',
            'Anything unlawful, defamatory, harassing, threatening, hateful, obscene, or that promotes violence or discrimination.',
            'Phishing, credential harvesting, malware, ransomware, or links to any of the above.',
            'Fraudulent, deceptive or unsubstantiated claims about a product, service, price, endorsement, certification or result.',
            'Chain letters, pyramid or matrix schemes, "get rich quick" offers, or anything of that character.',
            'Content promoting adult services, illegal drugs, weapons, gambling where it is not licensed, cryptocurrency or securities offerings that are not lawfully registered or exempt, debt relief, essay mills, or the sale of personal data.',
            'Content that infringes somebody else\'s copyright, trademark, trade secret or other rights.',
            'Anything subject to HIPAA, GLBA, PCI DSS or similar sectoral regulation, which the Services are not built to handle.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'The knowledge base you give us to answer questions from must be accurate. Feeding the system false claims about your product, your pricing or your customers means those claims go out under your name, in a message a person will reasonably rely on.',
        },
      ],
    },
    {
      id: 'opt-outs',
      heading: '4. Opt-outs and complaints',
      blocks: [
        {
          kind: 'callout',
          text: 'When somebody asks to stop hearing from you, that request is absolute. It does not need a reason, it does not expire, and it is not a negotiation.',
        },
        {
          kind: 'paragraph',
          text: 'The system detects an opt-out in a reply, adds the address to your suppression list, and stops the sequence immediately. Your obligations alongside that:',
        },
        {
          kind: 'list',
          items: [
            'Pass on any opt-out that reaches you directly — by phone, on another channel, or in a reply you handled yourself — so we can suppress the address.',
            'Never remove an address from a suppression list, and never re-import a suppressed address under another campaign, another domain or another list.',
            'Never make somebody go through an extra step, pay, log in, or explain themselves in order to opt out.',
            'Respond to a complaint from a recipient, a mailbox provider or a regulator promptly, and tell us about it so we can help.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'Recipients can also opt out by writing to us directly. We will honour that request against every campaign on our platform that concerns them, not just the one they replied to.',
        },
      ],
    },
    {
      id: 'sending-conduct',
      heading: '5. Sending conduct and reputation',
      blocks: [
        {
          kind: 'paragraph',
          text: 'The volume caps, warm-up schedule, pacing and per-mailbox rotation the Services apply are safety limits, not obstacles. You may not:',
        },
        {
          kind: 'list',
          items: [
            'Attempt to circumvent daily caps, pacing or suppression — including by rotating in extra mailboxes or domains for the purpose of sending more of the same campaign to the same people.',
            'Connect a mailbox you are not authorised to use, or send from a domain you do not control.',
            'Run the same campaign to the same recipients through a second provider in parallel.',
            'Use the Services to relay mail generated somewhere else, or as a general-purpose bulk sending platform.',
            'Configure sender details to disguise which organisation is writing.',
            'Continue a campaign we have told you is generating complaints or bounces at a level that threatens deliverability.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'We monitor bounce and complaint rates and may pause a campaign or a mailbox to protect your reputation and ours. We will tell you when we do.',
        },
      ],
    },
    {
      id: 'platform',
      heading: '6. Use of the platform itself',
      blocks: [
        {
          kind: 'paragraph',
          text: 'You may not:',
        },
        {
          kind: 'list',
          items: [
            'Probe, scan or test the vulnerability of the Services, or breach or circumvent authentication, rate limits or other security measures, other than under a written testing agreement with us.',
            'Attempt to access another client\'s data, account or campaigns.',
            'Reverse engineer, decompile or disassemble the Services, except where the law expressly permits it despite this restriction.',
            'Copy, resell, sublicense, white-label or provide the Services to a third party as your own, unless your order form says you may.',
            'Extract data from the Services other than your own data, or use it to build or train a competing contact database, prospecting product or AI model.',
            'Interfere with the operation of the Services or place an unreasonable load on them.',
            'Remove or obscure any proprietary notice.',
            'Misuse our support channels, or harass our staff.',
          ],
        },
        {
          kind: 'paragraph',
          text: 'For the avoidance of doubt: exporting your own campaign data, contacts, threads and reporting — by hand or through any export or interface we provide — is expressly permitted. It is your data.',
        },
      ],
    },
    {
      id: 'enforcement',
      heading: '7. Enforcement',
      blocks: [
        {
          kind: 'paragraph',
          text: 'If we believe this policy has been breached we may, depending on how serious and how urgent it is: ask you to fix it; pause a campaign, a mailbox or an account; remove offending content; suspend the Services; terminate the agreement under section 6 of the Terms of Service; and where the law requires it, report the matter to the authorities.',
        },
        {
          kind: 'paragraph',
          text: 'Where the risk allows, we will tell you first and give you a chance to put it right. Where it does not — active phishing, a live security compromise, a campaign causing serious harm — we will act first and tell you immediately afterwards.',
        },
        {
          kind: 'paragraph',
          text: 'Suspension for a breach of this policy does not entitle you to a refund of fees for the suspended period.',
        },
      ],
    },
    {
      id: 'reporting',
      heading: '8. Reporting a problem',
      blocks: [
        {
          kind: 'paragraph',
          text: `If you have received a message you believe breaks these rules, or you want a campaign to stop contacting you, email ${CONTACT_EMAIL}. Include the message if you can — it tells us which campaign to stop. We will act on it whether or not you are a client of ours, and we will not ask you to justify the request.`,
        },
        {
          kind: 'paragraph',
          text: 'If you believe you have found a security vulnerability, email the same address with the details and give us a reasonable opportunity to fix it before disclosing it publicly. We will not pursue legal action against anyone who reports a vulnerability in good faith and does not access, alter or exfiltrate data beyond what is needed to demonstrate it.',
        },
      ],
    },
  ],
}
