-- Client contact/signature info for outbound email — an optional
-- deterministic signature block appended (in code, not by the AI) to
-- first-touch and follow-up emails once a phone number is on file. See
-- docs/superpowers/specs/2026-08-07-client-contact-signature-design.md

alter table clients
  add column phone text,
  add column address text,
  add column signature_name text,
  add column signature_title text;
