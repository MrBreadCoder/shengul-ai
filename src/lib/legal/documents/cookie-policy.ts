import type { LegalDocument } from '@/lib/legal/document'
import { CONTACT_EMAIL, PRODUCT_NAME } from '@/lib/legal/contact'

/**
 * The cookie notice.
 *
 * Four cookies are strictly necessary and always set. A fifth category —
 * analytics, run through Google Tag Manager — only ever activates after a
 * visitor accepts it in the on-site banner, and never for advertising. The
 * previous version of this document claimed no tracking of any kind; that
 * stopped being true the day GTM was installed, so this version says exactly
 * what runs and exactly what is gated behind consent.
 */
export const cookiePolicy: LegalDocument = {
  slug: 'cookie-policy',
  title: 'Cookie Notice',
  description:
    'Shengul AI sets four sign-in cookies always, plus analytics cookies only if you accept them in the on-site banner. No advertising, ever.',
  summary: `This notice lists every cookie ${PRODUCT_NAME} sets and what each one does. Four are strictly necessary and always on. Analytics cookies exist too, but only after you say yes.`,
  updatedAt: '2026-07-29',
  sections: [
    {
      id: 'what-we-set',
      heading: '1. What we set, and why',
      blocks: [
        {
          kind: 'paragraph',
          text: 'A cookie is a small file a website asks your browser to keep. Four of ours exist for one job: to know that a request to the console comes from someone who has already signed in, so you are not asked for your password on every page. Those are set automatically and cannot be switched off without signing out.',
        },
        {
          kind: 'callout',
          text: 'We also run Google Tag Manager (GTM), a tag-management container that can load analytics tools such as Google Analytics. GTM itself is not an advertising product and we do not use it for advertising, ad personalization, or selling data. Any tag it loads is blocked by default and only switches on after you click "Accept analytics" in the banner shown on your first visit — see the next section for how that works and how to change your mind later.',
        },
      ],
    },
    {
      id: 'the-list',
      heading: '2. The complete list',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Strictly necessary — always set, cannot be declined without signing out:',
        },
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
          text: 'Analytics — only set once you accept them in the banner:',
        },
        {
          kind: 'table',
          columns: ['Name', 'Purpose', 'Set by', 'Expires'],
          rows: [
            [
              '_ga, _ga_*, _gid (if enabled)',
              'Google Analytics cookies that distinguish one visitor session from another, so we can see aggregate usage such as which pages get read. We do not configure Google Analytics or any other tag to build advertising profiles.',
              'Google, via our GTM container, only after consent',
              'Up to 13 months (Google\'s standard expiry — see Google\'s own cookie documentation for the current values)',
            ],
          ],
        },
        {
          kind: 'paragraph',
          text: 'This table lists what the consent banner is capable of switching on. Whether every row is active at any given time depends on what is currently configured inside our GTM container — clicking "Accept analytics" grants permission, it does not by itself guarantee every named cookie is present.',
        },
        {
          kind: 'paragraph',
          text: 'Alongside cookies, your browser also holds one item of local storage — a key named ai-b2b-consent that records whether you accepted or rejected analytics cookies, so we do not ask again on every visit. It stays in your browser; we never read or receive it.',
        },
      ],
    },
    {
      id: 'no-other-tracking',
      heading: '3. Other tracking technologies',
      blocks: [
        {
          kind: 'paragraph',
          text: 'We do not use web beacons, clear GIFs, fingerprinting, or Flash local shared objects. We do not run advertising pixels of any kind, on this site or anywhere else.',
        },
        {
          kind: 'callout',
          text: 'This applies to the emails we send. Outbound emails carry no tracking pixel and no rewritten links, so we do not know whether a message was opened or a link was clicked. That is a deliberate product decision, not an oversight: tracking markup is one of the signals that makes cold email look like bulk mail.',
        },
      ],
    },
    {
      id: 'controlling',
      heading: '4. Controlling cookies',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Analytics cookies are opt-in: nothing loads until you click "Accept analytics" in the banner. If you click "Reject" or close the banner, they stay off. You can change your mind at any time using the "Cookie preferences" link in the site footer, which withdraws consent as easily as it was given and clears the analytics cookies going forward.',
        },
        {
          kind: 'paragraph',
          text: 'Every browser also lets you see, block and delete cookies from its own settings or privacy menu. Blocking the four strictly-necessary cookies means the console cannot keep you signed in and will return you to the sign-in page; the public marketing page will still work normally either way.',
        },
        {
          kind: 'paragraph',
          text: 'There is no advertising opt-out to give you, because there is no advertising. If a future change added a cookie that is neither strictly necessary nor covered by the analytics consent above, we would ask first and update this notice before setting it.',
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
