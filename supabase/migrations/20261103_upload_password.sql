-- Existing private admin table; no changes to other services or public grants.
begin;
alter table public.tools_admins
  add column if not exists upload_password_hash text,
  add column if not exists upload_password_salt text,
  add column if not exists upload_password_changed_at timestamptz;
commit;
