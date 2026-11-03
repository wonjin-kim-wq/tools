-- 익명 리뷰 + 별점(5점 만점), 사용 횟수 집계, 인기 순위 일별 기록. 참코딩 전용 tools_ 범위만 변경한다.
begin;
-- 회원이 아니어도 리뷰를 남길 수 있다. 회원 리뷰는 앱마다 1개(member_id 고유), 비회원 리뷰는 member_id 없이 저장한다.
alter table public.tools_reviews alter column member_id drop not null;
alter table public.tools_reviews add column if not exists rating smallint check (rating between 1 and 5);

-- 사용 횟수만 바뀐 경우에는 '업데이트' 날짜와 검토 버전을 올리지 않는다.
create or replace function public.tools_touch_app()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if (to_jsonb(new) - 'uses' - 'updated_at' - 'version') = (to_jsonb(old) - 'uses' - 'updated_at' - 'version') then
    return new;
  end if;
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$;
revoke all on function public.tools_touch_app() from public,anon,authenticated;

create or replace function public.tools_use_app(p_app uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
begin
  update public.tools_apps set uses = uses + 1 where id = p_app and status = 'approved';
end;
$$;
revoke all on function public.tools_use_app(uuid) from public,anon,authenticated;
grant execute on function public.tools_use_app(uuid) to service_role;

create table if not exists public.tools_rank_daily (
  day date not null,
  app_id uuid not null references public.tools_apps(id) on delete cascade,
  rank integer not null check (rank > 0),
  primary key (day, app_id)
);
alter table public.tools_rank_daily enable row level security;
revoke all on public.tools_rank_daily from public,anon,authenticated;
grant all on public.tools_rank_daily to service_role;

-- 오늘(한국 시간) 처음 불릴 때 현재 순위를 기록하고, 앱마다 현재 순위와 직전 기록일의 순위를 돌려준다.
create or replace function public.tools_rank_snapshot()
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare
  v_day date := (statement_timestamp() at time zone 'Asia/Seoul')::date;
  v_prev date;
  v_result jsonb;
begin
  insert into public.tools_rank_daily(day, app_id, rank)
    select v_day, id, row_number() over (order by uses desc, created_at asc, id)
    from public.tools_apps where status = 'approved'
  on conflict do nothing;
  select max(day) into v_prev from public.tools_rank_daily where day < v_day;
  with cur as (
    select id, row_number() over (order by uses desc, created_at asc, id) as rk
    from public.tools_apps where status = 'approved'
  )
  select coalesce(jsonb_object_agg(cur.id, jsonb_build_object('rank', cur.rk, 'prev', p.rank)), '{}'::jsonb) into v_result
  from cur left join public.tools_rank_daily p on p.day = v_prev and p.app_id = cur.id;
  return v_result;
end;
$$;
revoke all on function public.tools_rank_snapshot() from public,anon,authenticated;
grant execute on function public.tools_rank_snapshot() to service_role;
delete from public.tools_rank_daily where day < (statement_timestamp() at time zone 'Asia/Seoul')::date - 60;
commit;
