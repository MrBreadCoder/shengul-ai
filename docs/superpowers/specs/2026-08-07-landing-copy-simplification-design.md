# Landing page copy simplification

## Problem

Clients described the public marketing site as "terrifying and too complicated." The
layout, sections, and visual design are not in question — the copy is. Two distinct
issues drive this:

1. **Voice.** Much of the copy describes the product as an autonomous "it" that
   researches companies and decides what to say on its own — e.g. "It reads the room
   first," "researched one at a time," "it stops and asks you." An unnamed system
   making judgment calls about strangers reads as surveillance software, even though
   the underlying feature (personalized, verified outreach) is benign.
2. **Density.** Several headlines and sentences lean on metaphor that requires
   re-reading before the point lands — e.g. "Doing it yourself is a second job that
   pays in maybes," "researched one at a time."

## Scope

Public marketing landing page only: `src/app/(marketing)/page.tsx` and every component
under `src/components/landing/`. No changes to legal pages, in-app client-facing
copy, layout, section order, or component structure — this is a copy-only pass.

Out of scope: TheGrind/Capabilities/etc. section count, visual design, `BookMeetingButton`
label, nav/footer copy (already short and clear), i18n (the marketing page is not
currently localized and this change does not introduce it).

## Approach

Two rules applied uniformly across every file in scope:

- **"It" → "we" wherever the sentence was describing the product doing something to a
  lead** (researching, writing, deciding, following up). Keeps sentences that already
  read as a plain product description as-is (e.g. "It sounds like a person" is fine —
  nothing there implies judgment about a third party).
- **Cut metaphor that requires a second read**, replacing it with the literal claim
  underneath it. Where a line was already plain and direct, leave it untouched rather
  than rewriting for the sake of rewriting.

No new sections, no removed sections, no reordering. Every array shape (`RELIEFS`,
`MOVEMENTS`, `OUTCOMES`, `PROMISES`, `COMMITMENTS`, `FAQ_ITEMS`, `COSTS`) stays
identical in length and field structure — only the string values change.

## Final copy

### Hero (`hero.tsx`)
- Eyebrow: "Outbound, handled" — unchanged
- Headline: "We book your meetings. You skip the outbound work."
- Subtext: "Tell us who you want to reach. We find them, email them, and pass you the
  ones who book a call."

### TheGrind (`the-grind.tsx`)
- Headline: "Doing this yourself takes hours and rarely pays off."
- Costs: "Hours every morning spent building lead lists." / "Late nights rewriting
  emails that still sound like a template." / "Follow-ups that never get sent, even to
  your best leads." / "Days of work for just a few meetings booked."
- Closer: "We take all of that off your plate."

### HowItWorks (`how-it-works.tsx`)
- Headline: "Four steps. You only do two of them."
- Subtext: "Nothing to learn, nothing to check every morning. You start it and show up
  to the meetings — we handle everything in between."
- Step 1 "Talk with us.": "One call. Tell us what you sell and who you want to reach.
  That's the whole setup."
- Step 2 "We find your leads.": "Every day, we find people who match the buyer you
  described, and check they're a real fit for what you sell."
- Step 3 "We write a real email.": "Not a template with a name dropped in. Each email
  mentions something real about that company, written in your voice, sent from your
  own inbox."
- Step 4 "You take the meetings.": "We follow up until someone replies, then stop
  right away. The meeting lands on your calendar, waiting for you in the morning."

### Capabilities (`capabilities.tsx`)
- Headline: "What a normal week looks like."
- Feature tile: "Get two hours back every day, and meetings on your calendar." / "The
  time you used to spend on lists and rewritten emails now goes to people who already
  replied and picked a time."
- Reliefs: "No list building" / "No first drafts" / "No chasing" — unchanged
- "Up to 3 follow-ups, then we stop." / "Nobody is forgotten, and nobody is spammed.
  The moment someone replies, the follow-ups stop."
- "Every email is personal." / "Each one opens with something real about that
  company — not a guess, not a generic line." Contrast line unchanged: "Rather than: I
  hope this email finds you well."
- "It sounds like a person." (unchanged) / "No tracking pixels, no bulk-email
  markers — just a normal email from your own address, sent like a person would send
  it."
- "You can read every email." / "Every email we send is there for you to check. If a
  reply asks something we can't answer honestly, we check with you instead of
  guessing."

### Outcomes (`outcomes.tsx`)
- Headline: "Four numbers we track. One you close."
- Subtext: "Everything here is meant to grow that fourth number. These are example
  figures for one month, just to show how the numbers connect — not a promise of your
  results."
- Leads found: "People who match the buyer you described."
- Emails sent: "Sent from your own mailbox, in small batches, at normal hours."
- Replies: "Answered in your voice. Follow-ups stop the moment someone replies."
- Meetings booked: "Booked straight into your calendar, with notes on the company
  attached."
- Fifth-number panel: "68 meetings, a $10,000 average deal, and a 30% close rate adds
  up to $204,000 in new business from one month. Use your own numbers to see what a
  month could be worth to you."

### Safeguards (`safeguards.tsx`)
- Headline: "Protect and grow your email reputation."
- Intro: "Your emails shouldn't end up in spam. Sending too many at once is what
  causes that, so we do the opposite — small numbers, human hours, your own mailbox.
  The reputation you've built stays protected, and gets stronger over time." (keeps
  the existing inline link to `#privacy`)
- "We start small.": "A few emails on day one, building up gradually. Nothing about it
  looks automated."
- "We back off automatically.": "If something looks off, we pull that mailbox out of
  rotation right away, and tell you."
- "One switch stops it." (unchanged): "Stop one email, one mailbox, or everything at
  once — instantly."

### Privacy (`privacy.tsx`)
- Headline: "How your data is handled." — unchanged
- Intro: "Running outbound means sharing your mailbox and your lead list with us.
  Here's exactly what happens to both." (keeps the existing inline link to
  `#safeguards`)
- "Everything is encrypted.": "Every connection uses TLS, and your mailbox login gets
  extra encryption before it's ever saved."
- "You can disconnect anytime.": "Your mailbox connects through Google or Microsoft's
  own sign-in screen. Disconnect it and sending stops immediately."
- "Your data stays yours.": "Kept separate at the database level — no query can ever
  return someone else's information."
- "Nothing is kept forever." (unchanged): "Regular activity is deleted after 30 days,
  flagged records after 90, automatically."

### FAQ (`faq-items.ts`)
- "Will it sound like me?" → "Yes. Every email goes out from your own address, in your
  voice, and mentions something real about that company. If there's nothing worth
  saying, we don't send anything."
- "Do I have to approve every email?" — unchanged
- "What happens when somebody actually replies?" → "Follow-ups stop right away, and we
  reply the way you would. Anything serious comes straight to you, with your booking
  link already included."
- "Will it make things up?" → "No. We only write what we can verify. If a question
  comes up that we can't answer honestly, we check with you first."
- "What do you need from me?" — unchanged

### Unchanged
`closing-cta.tsx`, `site-nav.tsx`, `site-footer.tsx`, `outcome-panel.tsx`,
`book-meeting-button.tsx`, `constants.ts` — already short and plain, no edits.

## Testing / verification

No behavior change, so no new unit tests. Verification is: `pnpm build` (or
equivalent typecheck) passes, and a manual read-through of the rendered page for tone
and line-length (does any headline now exceed the layout's `max-w` character
constraints already baked into the JSX, e.g. `max-w-[24ch]` on headings — check each
edited heading fits its existing wrapper).

## Risks

- SEO/JSON-LD: `FAQ_ITEMS` feeds `buildLandingJsonLd` for `FAQPage` structured data
  ([page.tsx](../../../src/app/(marketing)/page.tsx)) — the answer field must stay a
  complete, standalone sentence (it does, in the copy above).
- Any edited heading/paragraph must still fit inside its component's `max-w-[Nch]`
  Tailwind constraint so layout doesn't reflow awkwardly — checked per section above,
  will re-verify by rendering during implementation.
