import type { LegalDocument } from '@/lib/legal/document'
import { LEGAL_UPDATED_AT } from '@/lib/legal/document'
import { CONTACT_EMAIL, PRODUCT_NAME } from '@/lib/legal/contact'

/**
 * The cookie notice.
 *
 * Short because the truth is short: this site runs no analytics, no advertising
 * and no third-party tracking, so the only cookies it sets are the ones that
 * make signing in work. The previous version of this document described a
 * Google Analytics install, an advertising stack and a consent manager, none of
 * which exist — claiming tracking you do not do is its own privacy problem.
 */
export const cookiePolicy: LegalDocument = {
  slug: 'cookie-policy',
  title: 'Cookie Notice',
  description:
    'Shengul AI sets only the cookies needed to sign you in and keep you signed in. No analytics, no advertising, no third-party tracking, no pixels in our email.',
  summary: `This notice lists every cookie ${PRODUCT_NAME} sets and what each one does. There are four, they are all strictly necessary, and none of them tracks you across other websites.`,
  updatedAt: LEGAL_UPDATED_AT,
  sections: [
    {
      id: 'what-we-set',
      heading: '1. What we set, and why',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A cookie is a small file a website asks your browser to keep. We use them for one job: to know that a request to the console comes from someone who has already signed in, so you are not asked for your password on every page.',
        },
        {
          kind: 'callout',
          text: 'We run no analytics, no advertising, no A/B testing and no third-party tracking of any kind. No other company sets a cookie through this site. Because every cookie below is strictly necessary to a service you asked for, there is no consent banner — there is nothing to consent to, and nothing to switch off that would leave the service working.',
        },
      ],
    },
    {
      id: 'the-list',
      heading: '2. The complete list',
      blocks: [
        {
          kind: 'table',
          columns: ['Name', 'Purpose', 'Set by', 'Expires'],
          rows: [
            [
              'sb-…-auth-token',
              'Holds your signed-in session so the console can identify you. May be split across a few numbered cookies when the session record is large.',
              'Us, via our authentication provider',
              'When the session expires or you sign out',
            ],
            [
              'sb-…-auth-token-code-verifier',
              'A one-time value that proves a sign-in that was started in your browser is being completed in the same browser.',
              'Us, via our authentication provider',
              'A few minutes, as soon as sign-in completes',
            ],
            [
              'gmail_oauth_state',
              'A single-use random value that proves a Gmail connection being completed was started by you. Prevents a third party from attaching their mailbox to your account.',
              'Us',
              '10 minutes',
            ],
            [
              'outlook_oauth_state',
              'The same protection for connecting an Outlook or Microsoft 365 mailbox.',
              'Us',
              '10 minutes',
            ],
          ],
        },
        {
          kind: 'paragraph',
          text: 'All four are set only on our own domain, are marked HttpOnly so page scripts cannot read them, are sent only over HTTPS in production, and carry SameSite protection against cross-site use. The two connection cookies are scoped to the connection routes and are not sent anywhere else.',
        },
        {
          kind: 'paragraph',
          text: 'The public marketing page sets no cookies at all. You can read it without ever being identified.',
        },
      ],
    },
    {
      id: 'no-other-tracking',
      heading: '3. Other tracking technologies',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We do not use web beacons, clear GIFs, tracking pixels, fingerprinting, local storage for tracking, or Flash local shared objects.',
        },
        {
          kind: 'callout',
          text: 'This applies to the emails we send as well. Outbound emails carry no tracking pixel and no rewritten links, so we do not know whether a message was opened or a link was clicked. That is a deliberate product decision, not an oversight: tracking markup is one of the signals that makes cold email look like bulk mail.',
        },
      ],
    },
    {
      id: 'controlling',
      heading: '4. Controlling cookies',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Every browser lets you see, block and delete cookies from its settings or privacy menu. Because ours exist only to hold your sign-in, blocking them means the console cannot keep you signed in and will return you to the sign-in page. The public marketing page will work normally.',
        },
        {
          kind: 'paragraph',
          text: 'There is no advertising opt-out to give you, because there is no advertising. If a future change to the service required a cookie that was not strictly necessary, we would ask for your consent before setting it and update this notice first.',
        },
      ],
    },
    {
      id: 'questions',
      heading: '5. Questions',
      blocks: [
        {
          kind: 'paragraph',
          text: `How cookies fit into the wider picture of what we hold about you is set out in our Privacy Notice at /legal/privacy-policy. For anything else, email ${CONTACT_EMAIL} or use the contact details at the foot of this page.`,
        },
      ],
    },
  ],
}
