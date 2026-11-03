-- 참코딩 방문 횟수만 집계한다. 개인 식별 정보는 저장하지 않는다.
begin;
create table if not exists public.tools_visit_total (
  id integer primary key check (id = 1),
  count bigint not null default 0 check (count >= 0)
);
create table if not exists public.tools_visit_daily (
  day date primary key,
  count bigint not null default 0 check (count >= 0)
);
alter table public.tools_visit_total enable row level security;
alter table public.tools_visit_daily enable row level security;
revoke all on public.tools_visit_total,public.tools_visit_daily from public,anon,authenticated;
grant all on public.tools_visit_total,public.tools_visit_daily to service_role;

create or replace function public.tools_visit_counts(p_increment boolean default false)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_day date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
  v_total bigint;
  v_today bigint;
begin
  if p_increment then
    insert into public.tools_visit_total(id,count) values (1,1)
      on conflict(id) do update set count=tools_visit_total.count+1
      returning count into v_total;
    insert into public.tools_visit_daily(day,count) values (v_day,1)
      on conflict(day) do update set count=tools_visit_daily.count+1
      returning count into v_today;
  else
    select count into v_total from public.tools_visit_total where id=1;
    select count into v_today from public.tools_visit_daily where day=v_day;
  end if;
  return jsonb_build_object('total',coalesce(v_total,0),'today',coalesce(v_today,0),'day',v_day);
end;
$$;
revoke all on function public.tools_visit_counts(boolean) from public,anon,authenticated;
grant execute on function public.tools_visit_counts(boolean) to service_role;
commit;
