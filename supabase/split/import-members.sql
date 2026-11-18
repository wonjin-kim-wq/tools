-- [새 참코딩 프로젝트에서 실행] export-members.sql 결과(JSON)를 아래 __MEMBERS_JSON__ 자리에 넣고 실행한다.
-- 같은 id·이메일·비밀번호 해시·메타데이터로 회원을 만든다. 이미 있는 회원(id 기준)은 건드리지 않으므로 여러 번 실행해도 된다.
-- 두 프로젝트의 auth 스키마 버전이 달라도 되도록 새 프로젝트에 있는 일반 칸만 골라 넣는다(생성 칸 제외).
do $do$
declare
  data jsonb := $members$__MEMBERS_JSON__$members$::jsonb;
  ucols text;
  icols text;
begin
  if jsonb_array_length(data->'users') = 0 then raise notice 'no members'; return; end if;
  select string_agg(quote_ident(column_name), ',') into ucols from information_schema.columns
   where table_schema = 'auth' and table_name = 'users' and is_generated = 'NEVER'
     and column_name in (select jsonb_object_keys(data->'users'->0));
  execute format('insert into auth.users (%s) select %s from jsonb_populate_recordset(null::auth.users, $1) on conflict (id) do nothing', ucols, ucols)
    using data->'users';
  if jsonb_array_length(data->'identities') > 0 then
    select string_agg(quote_ident(column_name), ',') into icols from information_schema.columns
     where table_schema = 'auth' and table_name = 'identities' and is_generated = 'NEVER'
       and column_name in (select jsonb_object_keys(data->'identities'->0));
    execute format('insert into auth.identities (%s) select %s from jsonb_populate_recordset(null::auth.identities, $1) on conflict do nothing', icols, icols)
      using data->'identities';
  end if;
end
$do$;
select count(*) filter (where raw_app_meta_data->>'chamcoding_member' = 'true') as members,
       (select count(*) from auth.identities) as identities
from auth.users;
