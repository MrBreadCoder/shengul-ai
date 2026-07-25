-- Dev/staging fake data + a login user, for exercising the UI end to end.
--
-- Loaded automatically by `supabase db reset` (see supabase/config.toml
-- [db.seed] sql_paths = ["./seed.sql"]) against a LOCAL Supabase instance.
--
-- Against the HOSTED project in .env.local, run it manually instead:
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2)" -f supabase/seed.sql
-- or paste the whole file into the Supabase Studio SQL editor.
--
-- Safe to re-run: every row uses a fixed UUID and every insert is
-- ON CONFLICT (id) DO NOTHING, so re-running this file is a no-op once the
-- data exists. To start over, delete rows first (see scripts/seed-dev.ts
-- --reset for the app's own equivalent, which uses the Admin API instead of
-- raw SQL — prefer that for anything beyond local/manual testing).
--
-- LOGIN
--   email:    owner@aib2b.dev
--   password: DevPassword123!
--   role:     operator (client_id null -> sees every client, incl. /campaigns)
--
-- Inserting directly into auth.users/auth.identities is not an officially
-- supported Supabase workflow (it bypasses GoTrue), but it is a common local
-- dev pattern: the bcrypt hash below is produced with pgcrypto's crypt(),
-- which GoTrue's password check also uses, and the identities row mirrors
-- what GoTrue writes for an email/password signup.

begin;

-- ---------- auth user ----------
-- This project carries a leftover on_auth_user_created trigger (from the
-- dashboard's default quickstart, predating this app's own app_users-based
-- schema) that fires on every auth.users insert and writes into a
-- public.users table this app never created or queries. The SQL editor role
-- can INSERT into auth.users but does not own it, so ALTER TABLE ... DISABLE
-- TRIGGER is rejected ("must be owner of table users") — we cannot silence
-- the trigger. Instead we create the minimal public.users shape the trigger
-- expects, so its insert succeeds as a harmless no-op; nothing in this app
-- reads from it.
create table if not exists public.users (
  id    uuid primary key references auth.users(id) on delete cascade,
  email text,
  name  text,
  role  text not null default 'client'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  is_super_admin, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000',
  'a0000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'owner@aib2b.dev',
  crypt('DevPassword123!', gen_salt('bf')),
  now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
  false, now(), now(),
  '', '', '', '',
  false, false
)
on conflict (id) do nothing;

insert into auth.identities (
  id, provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) values (
  'a0000000-0000-4000-8000-0000000000f1',
  'a0000000-0000-4000-8000-000000000001',
  'a0000000-0000-4000-8000-000000000001',
  '{"sub":"a0000000-0000-4000-8000-000000000001","email":"owner@aib2b.dev"}'::jsonb,
  'email', now(), now(), now()
)
on conflict (id) do nothing;

insert into public.app_users (id, role, client_id) values
  ('a0000000-0000-4000-8000-000000000001', 'operator', null)
on conflict (id) do nothing;

-- ---------- clients ----------
insert into public.clients (id, name, status, settings, created_at, updated_at) values
  ('c1000000-0000-4000-8000-000000000001', 'Acme Robotics', 'active',
   '{"valueProp":"Autonomous inspection robots that cut manual QA costs by 40%","bookingLink":"https://cal.com/acme-robotics/intro"}'::jsonb,
   now() - interval '30 days', now() - interval '2 days'),
  ('c1000000-0000-4000-8000-000000000002', 'Border Foods Co', 'active',
   '{"valueProp":"Cold-chain logistics software that cuts spoilage losses by 25%","bookingLink":"https://cal.com/borderfoods/intro"}'::jsonb,
   now() - interval '20 days', now() - interval '1 day')
on conflict (id) do nothing;

-- ---------- mailboxes ----------
insert into public.mailboxes (
  id, client_id, provider, email_address, display_name, oauth,
  daily_cap, sent_today, warmup_profile, warmup_started_at, health, inbound_cursor, created_at, updated_at
) values
  ('b0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'gmail',
   'ops@acmerobotics.com', 'Acme Robotics Outreach',
   '{"seeded":true,"access_token":"seed-placeholder-access-token","refresh_token":"seed-placeholder-refresh-token","expires_at":"1970-01-01T00:00:00.000Z"}'::jsonb,
   40, 12, 'none', null, 'ok',
   'seed-history-id-104822', now() - interval '30 days', now() - interval '1 hour'),
  ('b0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'outlook',
   'sales@acmerobotics.com', 'Acme Robotics Sales',
   '{"seeded":true,"access_token":"seed-placeholder-access-token","refresh_token":"seed-placeholder-refresh-token","expires_at":"1970-01-01T00:00:00.000Z"}'::jsonb,
   30, 28, 'standard', now() - interval '7 days', 'warning',
   'seed-delta-token', now() - interval '7 days', now() - interval '1 hour'),
  ('b0000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000002', 'gmail',
   'growth@borderfoods.co', 'Border Foods Growth',
   '{"seeded":true,"access_token":"seed-placeholder-access-token","refresh_token":"seed-placeholder-refresh-token","expires_at":"1970-01-01T00:00:00.000Z"}'::jsonb,
   25, 5, 'none', null, 'ok',
   'seed-history-id-990211', now() - interval '20 days', now() - interval '1 hour')
on conflict (id) do nothing;

-- ---------- campaigns ----------
insert into public.campaigns (
  id, client_id, name, status, icp, value_prop, booking_link,
  reply_mode, price_handoff_mode, mailbox_ids, daily_target, created_at, updated_at
) values
  ('ca000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001',
   'VP Engineering Outreach — Robotics', 'active',
   '{"titles":["VP Engineering","Director of Operations"],"employeeRange":[50,500],"industries":["Robotics","Industrial Automation"],"geos":["United States","Canada"]}'::jsonb,
   'Autonomous inspection robots that cut manual QA costs by 40%', 'https://cal.com/acme-robotics/intro',
   'human_approve', 'book_call_and_notify',
   array['b0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002']::uuid[],
   25, now() - interval '30 days', now() - interval '2 days'),
  ('ca000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001',
   'Founder Outreach — Series A Robotics Startups', 'paused',
   '{"titles":["Founder","CEO"],"employeeRange":[10,50],"industries":["Robotics"],"geos":["United States"]}'::jsonb,
   'Autonomous inspection robots that cut manual QA costs by 40%', 'https://cal.com/acme-robotics/intro',
   'auto_send', 'notify_only',
   array['b0000000-0000-4000-8000-000000000001']::uuid[],
   15, now() - interval '25 days', now() - interval '10 days'),
  ('ca000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000002',
   'Ops Director Outreach — Cold Chain', 'active',
   '{"titles":["Director of Operations","VP Supply Chain"],"employeeRange":[100,1000],"industries":["Food Distribution","Logistics"],"geos":["United States"]}'::jsonb,
   'Cold-chain logistics software that cuts spoilage losses by 25%', 'https://cal.com/borderfoods/intro',
   'hybrid', 'configurable',
   array['b0000000-0000-4000-8000-000000000003']::uuid[],
   20, now() - interval '20 days', now() - interval '1 day')
on conflict (id) do nothing;

-- ---------- cases ----------
-- company_key (added by 0004_cases_company_key.sql) is NOT NULL with a unique
-- (campaign_id, company_key) index; using the lowercased domain, matching the
-- app's own grouping convention in src/lib/pipeline/group-lead.ts.
insert into public.cases (
  id, client_id, campaign_id, company_name, company_domain, company_key, status, summary, created_at, updated_at
) values
  ('ce000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Nimbus Fabrication', 'nimbusfab.com', 'nimbusfab.com', 'new', null, now() - interval '2 days', now() - interval '2 days'),
  ('ce000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Redline Manufacturing', 'redlinemfg.com', 'redlinemfg.com', 'researching', null, now() - interval '3 days', now() - interval '1 day'),
  ('ce000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Alloy Dynamics', 'alloydynamics.io', 'alloydynamics.io', 'ready',
   'Series B robotics arm manufacturer scaling QA headcount; VP Eng is actively hiring inspection leads.',
   now() - interval '6 days', now() - interval '1 day'),
  ('ce000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Torque Industrial', 'torqueindustrial.com', 'torqueindustrial.com', 'contacted',
   'First-touch sent to VP Engineering; no reply yet.',
   now() - interval '8 days', now() - interval '5 days'),
  ('ce000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Vertex Automation Group', 'vertexautomation.com', 'vertexautomation.com', 'in_conversation',
   'Replied asking for case studies; a follow-up is drafted awaiting approval.',
   now() - interval '10 days', now() - interval '1 day'),
  ('ce000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'Ironclad Robotics', 'ironcladrobotics.com', 'ironcladrobotics.com', 'hot_handoff',
   'Asked for pricing and a live demo slot — flagged for human handoff.',
   now() - interval '9 days', now() - interval '12 hours'),
  ('ce000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'Fastlane Robotics', 'fastlanerobotics.com', 'fastlanerobotics.com', 'won',
   'Closed — signed a paid pilot agreement.',
   now() - interval '18 days', now() - interval '3 days'),
  ('ce000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'Origin Mechatronics', 'originmechatronics.com', 'originmechatronics.com', 'lost',
   'Went with an in-house solution.',
   now() - interval '17 days', now() - interval '6 days'),
  ('ce000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000003',
   'Harborline Distribution', 'harborline.com', 'harborline.com', 'dead',
   'Hard bounce on the only known contact; no alternate email found.',
   now() - interval '14 days', now() - interval '13 days'),
  ('ce000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000003',
   'Polar Freight Co', 'polarfreight.com', 'polarfreight.com', 'new', null,
   now() - interval '1 day', now() - interval '1 day')
on conflict (id) do nothing;

-- ---------- leads ----------
insert into public.leads (
  id, client_id, campaign_id, case_id, full_name, title, company_name, company_domain,
  linkedin_url, source, raw, email, email_status, email_verified_at, status, created_at, updated_at
) values
  ('1e000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000001', 'Priya Chandran', 'Director of Quality Engineering', 'Nimbus Fabrication', 'nimbusfab.com',
   'https://linkedin.com/in/priyachandran', 'apollo', '{}'::jsonb, 'priya.chandran@nimbusfab.com', 'unverified', null,
   'new', now() - interval '2 days', now() - interval '2 days'),
  ('1e000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000002', 'Marcus Webb', 'VP Operations', 'Redline Manufacturing', 'redlinemfg.com',
   'https://linkedin.com/in/marcuswebb', 'apollo', '{}'::jsonb, 'marcus.webb@redlinemfg.com', 'verified', now() - interval '3 days',
   'new', now() - interval '3 days', now() - interval '1 day'),
  ('1e000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000003', 'Elena Kowalski', 'VP Engineering', 'Alloy Dynamics', 'alloydynamics.io',
   'https://linkedin.com/in/elenakowalski', 'apollo', '{}'::jsonb, 'elena.kowalski@alloydynamics.io', 'verified', now() - interval '6 days',
   'active', now() - interval '6 days', now() - interval '1 day'),
  ('1e000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000003', 'Sam Osei', 'Director of QA', 'Alloy Dynamics', 'alloydynamics.io',
   'https://linkedin.com/in/samosei', 'apollo', '{}'::jsonb, 'sam.osei@alloydynamics.io', 'verified', now() - interval '6 days',
   'parked', now() - interval '6 days', now() - interval '6 days'),
  ('1e000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000004', 'Derek Lin', 'VP Engineering', 'Torque Industrial', 'torqueindustrial.com',
   'https://linkedin.com/in/derek-lin', 'apollo', '{}'::jsonb, 'derek.lin@torqueindustrial.com', 'verified', now() - interval '8 days',
   'active', now() - interval '8 days', now() - interval '5 days'),
  ('1e000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000005', 'Ana Torres', 'Head of Operations', 'Vertex Automation Group', 'vertexautomation.com',
   'https://linkedin.com/in/ana-torres', 'apollo', '{}'::jsonb, 'ana.torres@vertexautomation.com', 'verified', now() - interval '10 days',
   'active', now() - interval '10 days', now() - interval '1 day'),
  ('1e000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001',
   'ce000000-0000-4000-8000-000000000006', 'Jon Whitfield', 'VP Engineering', 'Ironclad Robotics', 'ironcladrobotics.com',
   'https://linkedin.com/in/jon-whitfield', 'apollo', '{}'::jsonb, 'jon.whitfield@ironcladrobotics.com', 'verified', now() - interval '9 days',
   'active', now() - interval '9 days', now() - interval '12 hours'),
  ('1e000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'ce000000-0000-4000-8000-000000000007', 'Grace Mbeki', 'Founder & CEO', 'Fastlane Robotics', 'fastlanerobotics.com',
   'https://linkedin.com/in/grace-mbeki', 'apollo', '{}'::jsonb, 'grace.mbeki@fastlanerobotics.com', 'verified', now() - interval '18 days',
   'active', now() - interval '18 days', now() - interval '3 days'),
  ('1e000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000002',
   'ce000000-0000-4000-8000-000000000008', 'Tomas Reyes', 'Founder', 'Origin Mechatronics', 'originmechatronics.com',
   'https://linkedin.com/in/tomas-reyes', 'apollo', '{}'::jsonb, 'tomas.reyes@originmechatronics.com', 'verified', now() - interval '17 days',
   'active', now() - interval '17 days', now() - interval '6 days'),
  ('1e00000a-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000003',
   'ce000000-0000-4000-8000-000000000009', 'Helen Ostrowski', 'Director of Operations', 'Harborline Distribution', 'harborline.com',
   'https://linkedin.com/in/helen-ostrowski', 'apollo', '{}'::jsonb, 'helen.ostrowski@harborline.com', 'invalid', now() - interval '14 days',
   'parked', now() - interval '14 days', now() - interval '13 days'),
  ('1e00000b-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000003',
   'ce000000-0000-4000-8000-00000000000a', 'Marcus Doyle', 'VP Supply Chain', 'Polar Freight Co', 'polarfreight.com',
   'https://linkedin.com/in/marcus-doyle', 'apollo', '{}'::jsonb, 'marcus.doyle@polarfreight.com', 'unverified', null,
   'new', now() - interval '1 day', now() - interval '1 day'),
  ('1e00000c-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000003',
   'ce000000-0000-4000-8000-00000000000a', 'Nadia Farouk', 'Director of Logistics', 'Polar Freight Co', 'polarfreight.com',
   'https://linkedin.com/in/nadia-farouk', 'apollo', '{}'::jsonb, 'nadia.farouk@polarfreight.com', 'risky', now() - interval '1 day',
   'new', now() - interval '1 day', now() - interval '1 day')
on conflict (id) do nothing;

-- ---------- case_knowledge ----------
insert into public.case_knowledge (id, client_id, case_id, kind, content, source_url, citation, created_by, created_at) values
  ('cc000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003',
   'company', 'Alloy Dynamics raised a $42M Series B in March 2026 led by Anchorpoint Ventures to scale robotic arm production.',
   'https://techcrunch.com/2026/03/alloy-dynamics-series-b', 'TechCrunch, Mar 2026', 'agent', now() - interval '6 days'),
  ('cc000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003',
   'pain_point', 'Job postings show 4 open "Quality Engineer" roles — manual inspection is a stated bottleneck in their scale-up plan.',
   'https://alloydynamics.io/careers', 'Alloy Dynamics careers page', 'agent', now() - interval '6 days'),
  ('cc000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005',
   'person', 'Ana Torres joined Vertex Automation Group as Head of Operations in 2025 after 6 years running plant ops at a Tier 1 automotive supplier.',
   'https://linkedin.com/in/ana-torres', 'LinkedIn profile', 'agent', now() - interval '10 days'),
  ('cc000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006',
   'answer', 'Confirmed with the client: standard pilot pricing is $4.5k/mo for up to 3 inspection stations, discountable to $3.8k/mo on an annual term.',
   null, null, 'human', now() - interval '11 hours')
on conflict (id) do nothing;

-- ---------- emails ----------
insert into public.emails (
  id, client_id, case_id, lead_id, thread_id, provider_message_id, direction, subject, body,
  status, sequence_step, mailbox_id, sent_at, created_at, in_reply_to_email_id
) values
  -- Torque Industrial: contacted, no reply yet
  ('e1000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000004',
   '1e000000-0000-4000-8000-000000000005', 'thread-torque-001', 'seed-msg-0001', 'outbound',
   'Cutting manual QA time at Torque Industrial', 'Hi Derek, noticed Torque is scaling inspection headcount...',
   'sent', 0, 'b0000000-0000-4000-8000-000000000001', now() - interval '8 days', now() - interval '8 days', null),

  -- Vertex Automation Group: outbound -> inbound reply -> drafted follow-up (human_approve)
  ('e1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005',
   '1e000000-0000-4000-8000-000000000006', 'thread-vertex-001', 'seed-msg-0002', 'outbound',
   'Quick question for Vertex Automation Group', 'Hi Ana, autonomous inspection could cut your QA cycle time...',
   'sent', 0, 'b0000000-0000-4000-8000-000000000001', now() - interval '10 days', now() - interval '10 days', null),
  ('e1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005',
   '1e000000-0000-4000-8000-000000000006', 'thread-vertex-001', 'seed-msg-0003', 'inbound',
   'Re: Quick question for Vertex Automation Group', 'Interesting — do you have case studies from similar robotics manufacturers?',
   'delivered', null, 'b0000000-0000-4000-8000-000000000001', null, now() - interval '9 days', null),
  ('e1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005',
   '1e000000-0000-4000-8000-000000000006', 'thread-vertex-001', null, 'outbound',
   'Re: Quick question for Vertex Automation Group', 'Hi Ana, absolutely — attaching two case studies from comparable robotics QA lines...',
   'draft', 1, 'b0000000-0000-4000-8000-000000000001', null, now() - interval '1 day', 'e1000000-0000-4000-8000-000000000003'),

  -- Ironclad Robotics: outbound -> inbound pricing ask (hot handoff)
  ('e1000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006',
   '1e000000-0000-4000-8000-000000000007', 'thread-ironclad-001', 'seed-msg-0005', 'outbound',
   'Autonomous inspection for Ironclad Robotics', 'Hi Jon, cutting manual QA overhead by 40% is realistic for a line like yours...',
   'sent', 0, 'b0000000-0000-4000-8000-000000000002', now() - interval '9 days', now() - interval '9 days', null),
  ('e1000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006',
   '1e000000-0000-4000-8000-000000000007', 'thread-ironclad-001', 'seed-msg-0006', 'inbound',
   'Re: Autonomous inspection for Ironclad Robotics', 'This looks promising. What are your pricing tiers, and can we get a live demo this week?',
   'delivered', null, 'b0000000-0000-4000-8000-000000000002', null, now() - interval '12 hours', null),

  -- Fastlane Robotics: won, full thread
  ('e1000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007',
   '1e000000-0000-4000-8000-000000000008', 'thread-fastlane-001', 'seed-msg-0007', 'outbound',
   'Autonomous inspection for Fastlane Robotics', 'Hi Grace, congrats on the recent launch — thought this might help scale QA...',
   'sent', 0, 'b0000000-0000-4000-8000-000000000001', now() - interval '18 days', now() - interval '18 days', null),
  ('e1000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007',
   '1e000000-0000-4000-8000-000000000008', 'thread-fastlane-001', 'seed-msg-0008', 'inbound',
   'Re: Autonomous inspection for Fastlane Robotics', 'Let''s talk. When are you free this week?',
   'delivered', null, 'b0000000-0000-4000-8000-000000000001', null, now() - interval '16 days', null),
  ('e1000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007',
   '1e000000-0000-4000-8000-000000000008', 'thread-fastlane-001', 'seed-msg-0009', 'outbound',
   'Re: Autonomous inspection for Fastlane Robotics', 'Great! Sending a booking link for a 30-minute pilot walkthrough...',
   'sent', 1, 'b0000000-0000-4000-8000-000000000001', now() - interval '15 days', now() - interval '15 days', 'e1000000-0000-4000-8000-000000000008'),
  ('e100000a-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007',
   '1e000000-0000-4000-8000-000000000008', 'thread-fastlane-001', 'seed-msg-000a', 'outbound',
   'Welcome aboard, Fastlane Robotics!', 'Thanks for signing the pilot agreement — kicking off onboarding next Monday.',
   'sent', 2, 'b0000000-0000-4000-8000-000000000001', now() - interval '3 days', now() - interval '3 days', null),

  -- Origin Mechatronics: outbound -> inbound decline (lost)
  ('e100000b-0000-4000-8000-00000000000b', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000008',
   '1e000000-0000-4000-8000-000000000009', 'thread-origin-001', 'seed-msg-000b', 'outbound',
   'Autonomous inspection for Origin Mechatronics', 'Hi Tomas, wanted to flag how this could cut your QA overhead...',
   'sent', 0, 'b0000000-0000-4000-8000-000000000001', now() - interval '17 days', now() - interval '17 days', null),
  ('e100000c-0000-4000-8000-00000000000c', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000008',
   '1e000000-0000-4000-8000-000000000009', 'thread-origin-001', 'seed-msg-000c', 'inbound',
   'Re: Autonomous inspection for Origin Mechatronics', 'Thanks, but we''ve just finished building this in-house. Please remove me from this list.',
   'delivered', null, 'b0000000-0000-4000-8000-000000000001', null, now() - interval '16 days', null),

  -- Harborline Distribution: bounced first touch (dead)
  ('e100000d-0000-4000-8000-00000000000d', 'c1000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000009',
   '1e00000a-0000-4000-8000-00000000000a', 'thread-harborline-001', 'seed-msg-000d', 'outbound',
   'Cold-chain visibility for Harborline Distribution', 'Hi Helen, cutting spoilage losses by 25% is realistic for a network your size...',
   'bounced', 0, 'b0000000-0000-4000-8000-000000000003', now() - interval '14 days', now() - interval '14 days', null)
on conflict (id) do nothing;

-- ---------- sequences ----------
insert into public.sequences (id, client_id, case_id, lead_id, state, current_step, next_action_at, qstash_message_id, created_at, updated_at) values
  ('5e000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000004',
   '1e000000-0000-4000-8000-000000000005', 'active', 0, now() + interval '2 days', 'seed-qstash-msg-1', now() - interval '8 days', now() - interval '5 days'),
  ('5e000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005',
   '1e000000-0000-4000-8000-000000000006', 'active', 1, now() + interval '1 day', 'seed-qstash-msg-2', now() - interval '10 days', now() - interval '1 day'),
  ('5e000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006',
   '1e000000-0000-4000-8000-000000000007', 'paused', 0, null, null, now() - interval '9 days', now() - interval '12 hours'),
  ('5e000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007',
   '1e000000-0000-4000-8000-000000000008', 'completed', 2, null, null, now() - interval '18 days', now() - interval '3 days'),
  ('5e000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000008',
   '1e000000-0000-4000-8000-000000000009', 'stopped', 0, null, null, now() - interval '17 days', now() - interval '16 days')
on conflict (id) do nothing;

-- ---------- knowledge_requests ----------
insert into public.knowledge_requests (id, client_id, case_id, lead_id, email_id, question, status, human_answer, answered_by, answered_at, created_at) values
  ('c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006',
   '1e000000-0000-4000-8000-000000000007', 'e1000000-0000-4000-8000-000000000006',
   'Prospect asked for pricing tiers and a live demo slot this week — need the pricing sheet and demo calendar link.',
   'answered', 'Standard pilot pricing is $4.5k/mo for up to 3 inspection stations, $3.8k/mo on an annual term. Demo link: cal.com/acme-robotics/demo.',
   'a0000000-0000-4000-8000-000000000001', now() - interval '11 hours', now() - interval '12 hours'),
  ('c0000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000005',
   '1e000000-0000-4000-8000-000000000006', 'e1000000-0000-4000-8000-000000000003',
   'Prospect wants two client case studies in the robotics QA space before continuing the conversation.',
   'open', null, null, null, now() - interval '9 days'),
  ('c0000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000003',
   '1e000000-0000-4000-8000-000000000003', null,
   'No public pricing page found for Alloy Dynamics — need confirmation on which tier to lead with before first touch.',
   'open', null, null, null, now() - interval '5 days')
on conflict (id) do nothing;

-- ---------- suppressions ----------
insert into public.suppressions (id, client_id, email, reason, created_at) values
  ('5b000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'tomas.reyes@originmechatronics.com', 'replied', now() - interval '16 days'),
  ('5b000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002', 'helen.ostrowski@harborline.com', 'bounced', now() - interval '14 days')
on conflict (id) do nothing;

-- ---------- events (audit log) ----------
insert into public.events (id, client_id, case_id, actor, type, payload, created_at) values
  ('ee000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', null, 'operator', 'mailbox.connected',
   '{"provider":"gmail","emailAddress":"ops@acmerobotics.com"}'::jsonb, now() - interval '30 days'),
  ('ee000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000001', null, 'operator', 'campaign.created',
   '{"name":"VP Engineering Outreach — Robotics"}'::jsonb, now() - interval '30 days'),
  ('ee000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000002', null, 'operator', 'mailbox.connected',
   '{"provider":"gmail","emailAddress":"growth@borderfoods.co"}'::jsonb, now() - interval '20 days'),
  ('ee000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000007', 'agent', 'case.status_changed',
   '{"from":"in_conversation","to":"won"}'::jsonb, now() - interval '3 days'),
  ('ee000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000008', 'agent', 'case.status_changed',
   '{"from":"in_conversation","to":"lost"}'::jsonb, now() - interval '16 days'),
  ('ee000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006', 'agent', 'case.status_changed',
   '{"from":"in_conversation","to":"hot_handoff"}'::jsonb, now() - interval '12 hours'),
  ('ee000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000002', 'ce000000-0000-4000-8000-000000000009', 'agent', 'case.status_changed',
   '{"from":"contacted","to":"dead"}'::jsonb, now() - interval '13 days'),
  ('ee000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000001', 'ce000000-0000-4000-8000-000000000006', 'agent', 'knowledge_request.created',
   '{"question":"pricing and demo slot"}'::jsonb, now() - interval '12 hours')
on conflict (id) do nothing;

commit;
