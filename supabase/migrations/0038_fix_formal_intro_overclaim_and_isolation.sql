-- Fixes two defects in the seeded "Formal introduction" email_styles row
-- found from a live Uniforms Fashion send to International Jubilee Private
-- School (2026-08-11):
--
-- 1. Step 3 (Capabilities) gave only one example of folding the recipient's
--    location into the capabilities sentence — "...for police and
--    corrections agencies LIKE YOURS in Wyoming" — but never made the
--    "like yours" analogy framing mandatory. The model dropped it and wrote
--    "we manufacture custom school uniforms ... for K-12 institutions in
--    Abu Dhabi", which reads as an existing operating footprint in Abu
--    Dhabi. Uniforms Fashion (Istanbul) has no such footprint — the
--    sentence stated a false capability the "About our company" text never
--    gave it. FIXED_GUARDRAILS in write.ts only forbids inventing facts
--    about the recipient/dossier, not inventing operating reach for the
--    sender, so nothing else in the prompt caught this. Fixed by making the
--    "like yours" / "such as" analogy framing an explicit requirement and
--    explicitly forbidding an implied existing footprint.
-- 2. The opening "never isolate a fact into its own flat sentence" rule was
--    already explicit, but the same email still produced a bare
--    "Company X has done Y since Z"-shaped sentence for its one available
--    personalization fact ("G7 recently shortlisted International Jubilee
--    Private School among the top three schools in the UAE for the
--    2025-2026 academic year."). The rule was never restated for the
--    single-fact case, where there's nothing else nearby to weave it
--    against. Fixed by adding an explicit single-fact instruction requiring
--    a connecting clause instead of a standalone sentence.
--
-- See docs/superpowers/specs/2026-08-09-editable-email-styles-design.md for
-- why this lives in a DB row rather than write.ts: operators can already
-- edit this row from the client detail page, so this migration only
-- resets the row back to the intended default wording; it does not
-- reintroduce engineer-only editing.
update email_styles
set
  voice_instructions =
    'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect. '
    || 'Structure the body around these ideas. Weave dossier facts into the sentences that need them — '
    || 'never isolate a fact into its own flat sentence like "Company X has done Y since Z"; that reads '
    || 'like a database record, not a personal email. This applies even when only one strong fact is '
    || 'available — tie it to the capability sentence or the ask with a connecting clause ("because", '
    || '"after", "since", "which is why") rather than letting it stand alone as its own sentence. Spread '
    || 'what you know about the recipient across multiple paragraphs below instead of stacking it all '
    || 'into one: '
    || '1. Greeting: "Dear [Recipient first name]," using the recipient''s first name from the Recipient '
    || 'line below; if no name is given, use "Dear," alone. '
    || '2. Self-introduction: one sentence giving the sender name and company name exactly as given in '
    || '"Sender name" / "Our company name" below, plus the company''s home base and years of experience — '
    || 'only the ones you have evidence for in "About our company"; drop whichever you don''t have '
    || 'rather than guessing. One sentence, no added claims about the sender. '
    || '3. Capabilities: what the company manufactures or does, grounded in the value proposition and '
    || '"About our company" below. Fold in the recipient''s industry, sector, or location where it fits '
    || 'naturally, framed as the kind of customer you serve (e.g. "...for police and corrections agencies '
    || 'like yours in Wyoming" or "...for supermarket chains operating in humid climates") instead of '
    || 'listing capabilities generically. Never state or imply that the sender already operates, '
    || 'manufactures, or has clients in the recipient''s country or region unless "About our company" '
    || 'explicitly says so — the recipient''s location is an analogy for who you serve, not a claim about '
    || 'where you already work. '
    || '4. Personalize: use the strongest available dossier fact(s) to show this is not a mass-blast — '
    || 'prefer a (pain_point) or (news) fact over a bare (company) firmographic line (industry/size/ '
    || 'founding year/location). If several strong facts are available, split them between this '
    || 'paragraph and the capabilities sentence above rather than stacking them all here. If the '
    || 'dossier has only a bare (company) firmographic line and nothing sharper, do not give it its own '
    || 'paragraph — fold that one detail (location, size, or sector) into the capabilities sentence '
    || 'above or the ask below instead, and skip this paragraph entirely. Whichever paragraph a fact '
    || 'ends up in, state it plainly; never add a claim about why it matters, what the recipient needs, '
    || 'or what is "a priority" for them — that invents something the dossier does not say. Never fall '
    || 'back to a generic line like "I came across your company", "I wanted to introduce ourselves", "I '
    || 'am reaching out to [company]", or "regarding your [X] needs". '
    || '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the '
    || 'kind of procurement or project relevant to their industry, followed by an offer to send the '
    || 'company profile, references, and product capabilities if so. Only mention the booking link '
    || 'here if it is clearly the natural next step; otherwise the offer to send materials is the '
    || 'entire ask. '
    || 'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any '
    || 'sign-off — a signature block is appended separately in code. '
    || 'Four to five short paragraphs total once personalization is folded in as above. 130 words or '
    || 'fewer, including the greeting.',
  updated_at = now()
where name = 'Formal introduction';
