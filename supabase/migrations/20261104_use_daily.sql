-- 인기순 일별·주별·월별: 사용 횟수를 한국 날짜별로도 쌓는다. 참코딩 전용 tools_ 범위만 변경한다.
begin;
create table if not exists public.tools_use_daily (
  day date not null,
  app_id uuid not null references public.tools_apps(id) on delete cascade,
  count integer not null default 0 check (count >= 0),
  primary key (day, app_id)
);
alter table public.tools_use_daily enable row level security;
revoke all on public.tools_use_daily from public,anon,authenticated;
grant all on public.tools_use_daily to service_role;

create or replace function public.tools_use_app(p_app uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  update public.tools_apps set uses = uses + 1 where id = p_app and status = 'approved';
  if found then
    insert into public.tools_use_daily(day, app_id, count)
      values ((statement_timestamp() at time zone 'Asia/Seoul')::date, p_app, 1)
      on conflict (day, app_id) do update set count = tools_use_daily.count + 1;
  end if;
end;
$$;
revoke all on function public.tools_use_app(uuid) from public,anon,authenticated;
grant execute on function public.tools_use_app(uuid) to service_role;
commit;
