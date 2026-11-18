-- Limit new issuance to one active token without interrupting existing connections.
begin;

create or replace function public.tools_issue_api_token(
  p_member_id uuid, p_name text, p_token_hash text, p_prefix text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare issued public.tools_api_tokens%rowtype;
begin
  -- Serialize issuance for one account across all Vercel instances.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('tools_api_tokens:' || p_member_id::text, 0));
  if exists (select 1 from public.tools_api_tokens
      where member_id = p_member_id and revoked_at is null) then
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

commit;
