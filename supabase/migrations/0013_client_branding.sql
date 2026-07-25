-- Client branding: a per-client logo (uploaded or auto-fetched from their
-- website's favicon) and website domain, shown in the client dashboard
-- sidebar in place of the default "Beacon" mark and used on /clients.

alter table clients add column domain   text;
alter table clients add column logo_url text;

-- Public bucket: logos are non-sensitive brand assets rendered directly via
-- <img>/next/image, same trust level as the favicon fetched from a client's
-- own website. Writes are operator-only, enforced at the API route layer
-- (service-role client), matching every other client-mutating route — this
-- codebase does not use storage RLS policies elsewhere, so none are added
-- here either.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-logos',
  'client-logos',
  true,
  2097152, -- 2MB
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
)
on conflict (id) do nothing;
