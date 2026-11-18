-- MCP registration uses the existing private screenshot bucket and app queue.
begin;

create table if not exists public.tools_api_tokens (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  prefix text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists tools_api_tokens_member_created
  on public.tools_api_tokens(member_id, created_at desc);
alter table public.tools_api_tokens enable row level security;
revoke all on public.tools_api_tokens from public, anon, authenticated;
grant select, insert, update on public.tools_api_tokens to service_role;

alter table public.tools_apps
  add column if not exists member_id uuid references auth.users(id) on delete set null,
  add column if not exists source text not null default 'web' check (source in ('web', 'mcp')),
  add column if not exists mcp_member_name text,
  add column if not exists own_work_confirmed_at timestamptz;
-- PostgreSQL permits multiple null member IDs, so web uploads retain their behavior.
create unique index if not exists tools_apps_member_web_url
  on public.tools_apps(member_id, web_url);

create or replace function public.tools_issue_api_token(
  p_member_id uuid, p_name text, p_token_hash text, p_prefix text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare issued public.tools_api_tokens%rowtype;
begin
  -- Serialize issuance for one account across all Vercel instances.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tools_api_tokens:' || p_member_id::text, 0));
  if (select count(*) from public.tools_api_tokens
      where member_id = p_member_id and revoked_at is null) >= 3 then
    return null;
  end if;

  insert into public.tools_api_tokens(member_id, name, token_hash, prefix)
  values (p_member_id, p_name, p_token_hash, p_prefix)
  returning * into issued;
  return pg_catalog.to_jsonb(issued) - 'token_hash' - 'member_id';
end;
$$;
revoke all on function public.tools_issue_api_token(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.tools_issue_api_token(uuid, text, text, text) to service_role;

notify pgrst, 'reload schema';
commit;
