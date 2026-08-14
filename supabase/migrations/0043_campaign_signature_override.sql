-- Per-campaign override of the client-level contact signature (see
-- 0031_client_contact_signature.sql and src/lib/pipeline/signature.ts). Each
-- field is nullable and independent, mirroring the existing discover_time /
-- discover_timezone override convention already on this table: null means
-- "inherit the client's value", set means "use this instead" — an operator
-- can override just the phone number for one campaign while name/title/
-- address still fall back to the client.
alter table campaigns
  add column signature_name text,
  add column signature_title text,
  add column phone text,
  add column address text;
