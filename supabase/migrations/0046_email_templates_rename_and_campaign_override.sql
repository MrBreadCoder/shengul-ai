-- Renames the "email style" feature to "email template" (operator request,
-- 2026-08-15: Uniforms Fashion hands over literal reference emails per
-- vertical, not abstract voice instructions, and "template" is their own
-- word for it), and adds the per-campaign override this rename was for:
-- every campaign can now carry its own template, falling back to the
-- owning client's template, falling back to whichever template is marked
-- default. Same nullable-override convention as
-- campaigns.signature_name/phone/address (migration 0043) and
-- discover_time/discover_timezone before it: null means "inherit".

alter table email_styles rename to email_templates;
alter table email_templates rename column voice_instructions to template_text;
alter index email_styles_name_key rename to email_templates_name_key;
alter index email_styles_single_default_key rename to email_templates_single_default_key;

alter table clients rename column email_style_id to email_template_id;
alter table clients rename constraint clients_email_style_id_fkey to clients_email_template_id_fkey;

alter table campaigns
  add column email_template_id uuid references email_templates(id) on delete set null;

-- Replaces set_default_email_style — same body, new name, operating on the
-- renamed table. The old function is dropped rather than left dangling.
create or replace function public.set_default_email_template(p_id uuid)
returns setof public.email_templates
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from email_templates where id = p_id) then
    raise exception 'email_template % not found', p_id using errcode = 'P0002';
  end if;
  update email_templates set is_default = false where is_default = true and id <> p_id;
  update email_templates set is_default = true, updated_at = now() where id = p_id;
  return query select * from email_templates where id = p_id;
end;
$$;

drop function if exists public.set_default_email_style(uuid);
