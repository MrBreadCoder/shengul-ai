-- Operator-managed, fully dynamic first-touch email voices. Replaces the
-- fixed 'concise'/'formal_intro' enum from migration 0034 with a proper
-- table: operators can now create, edit, and delete styles from the client
-- detail page with no engineer/migration involved. See
-- docs/superpowers/specs/2026-08-09-editable-email-styles-design.md

create table email_styles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  voice_instructions text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index email_styles_name_key on email_styles (name);

-- Enforces "exactly one default" at the DB level: at most one row can have
-- is_default = true at any time.
create unique index email_styles_single_default_key on email_styles (is_default) where is_default;

-- Seed rows, ported from write.ts's CONCISE_SYSTEM_PROMPT / FORMAL_INTRO_SYSTEM_PROMPT
-- as they stand at HEAD (post 9ffcf3e "close formal-intro personalization
-- gaps" — NOT the migration-0034-era wording the design doc sketched, which
-- predates that commit) with the now-fixed guardrail lines (English/translate,
-- no bulk markers, dossier-only facts, subject-line rules, human voice)
-- stripped out — those move into write.ts's FIXED_GUARDRAILS constant and
-- get appended to every style automatically, never stored per-row. Each
-- style keeps its own opening role sentence ("You write short..." /
-- "You write a formal B2B introduction email...") since that framing is
-- voice-specific, not a universal guardrail. Using the stale 0034-era text
-- here would silently regress Uniforms Fashion's live emails back to an
-- older wording, breaking this migration's own "byte-for-byte unchanged"
-- rollout guarantee.
insert into email_styles (name, voice_instructions, is_default) values
  ('Concise (default)',
   'You write short, human-sounding B2B cold emails. One clear idea. 90 words or fewer. '
   || 'Lead with the specific dossier fact, not a greeting. '
   || 'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"), '
   || 'not the booking link. Only offer the booking link if it is clearly the natural next step — '
   || 'it is an optional extra, never the default ask.',
   true),
  ('Formal introduction',
   'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect. '
   || 'Structure the body around these ideas. Weave dossier facts into the sentences that need them — '
   || 'never isolate a fact into its own flat sentence like "Company X has done Y since Z"; that reads '
   || 'like a database record, not a personal email. Spread what you know about the recipient across '
   || 'multiple paragraphs below instead of stacking it all into one: '
   || '1. Greeting: "Dear [Recipient first name]," using the recipient''s first name from the Recipient '
   || 'line below; if no name is given, use "Dear," alone. '
   || '2. Self-introduction: one sentence giving the sender name and company name exactly as given in '
   || '"Sender name" / "Our company name" below, plus the company''s home base and years of experience — '
   || 'only the ones you have evidence for in "About our company"; drop whichever you don''t have '
   || 'rather than guessing. One sentence, no added claims about the sender. '
   || '3. Capabilities: what the company manufactures or does, grounded in the value proposition and '
   || '"About our company" below. Fold in the recipient''s industry, sector, or location where it fits '
   || 'naturally (e.g. "...for police and corrections agencies like yours in Wyoming" or "...for '
   || 'supermarket chains operating in humid climates") instead of listing capabilities generically. '
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
   false);

alter table clients add column email_style_id uuid references email_styles(id) on delete set null;

-- Explicit backfill (not left null) so every existing client's resolved
-- voice is pinned to its current wording — it can never silently change if
-- an operator later re-points is_default at a different style.
update clients set email_style_id = (select id from email_styles where name = 'Concise (default)')
  where email_style = 'concise';
update clients set email_style_id = (select id from email_styles where name = 'Formal introduction')
  where email_style = 'formal_intro';

alter table clients drop column email_style;
drop type email_style;

-- Atomically swaps which row is_default = true. Needed because the partial
-- unique index above forbids two rows being true at once, so "unset old,
-- set new" cannot safely be two independent supabase-js calls — a crash
-- between them would leave zero defaults. Wrapping both updates in one
-- function makes them atomic relative to the calling statement, matching
-- the security-definer RPC pattern already used by claim_mailbox_send
-- (migration 0012).
create or replace function public.set_default_email_style(p_id uuid)
returns setof public.email_styles
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from email_styles where id = p_id) then
    raise exception 'email_style % not found', p_id using errcode = 'P0002';
  end if;
  update email_styles set is_default = false where is_default = true and id <> p_id;
  update email_styles set is_default = true, updated_at = now() where id = p_id;
  return query select * from email_styles where id = p_id;
end;
$$;
