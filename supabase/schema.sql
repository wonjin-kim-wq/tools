-- 참코딩 전용 테이블. 기존 프로젝트의 다른 테이블, 사용자, 버킷은 변경하지 않는다.
begin;
create table if not exists public.tools_apps (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  web_url text not null default '',
  demo_url text not null default '',
  short text not null,
  description text not null,
  category text not null check (category in ('교과 교육','계기 교육','아침활동','교실놀이','기타')),
  grade text not null,
  icon text not null default '🧩',
  color text not null default '#ffd23f' check (color ~ '^#[0-9a-fA-F]{6}$'),
  notes jsonb not null default '[]'::jsonb check (jsonb_typeof(notes) = 'array'),
  screenshots jsonb not null default '[]'::jsonb check (jsonb_typeof(screenshots) = 'array'),
  author_name text not null,
  contact_email text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected','changes_requested','archived')),
  review_note text not null default '',
  uses bigint not null default 0,
  is_example boolean not null default false,
  submitted_session uuid,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tools_apps_status_created on public.tools_apps(status,created_at desc);
create table if not exists public.tools_admins (
  id integer primary key check (id = 1),
  username text not null unique,
  password_hash text not null,
  salt text not null,
  upload_password_hash text,
  upload_password_salt text,
  upload_password_changed_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists public.tools_uploads (
  path text primary key,
  session_id uuid not null,
  created_at timestamptz not null default now()
);
create table if not exists public.tools_rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count integer not null default 1
);
alter table public.tools_apps enable row level security;
alter table public.tools_admins enable row level security;
alter table public.tools_uploads enable row level security;
alter table public.tools_rate_limits enable row level security;
-- Browser clients cannot read requests, passwords, upload paths, or modify approvals.
revoke all on public.tools_apps,public.tools_admins,public.tools_uploads,public.tools_rate_limits from public,anon,authenticated;
grant all on public.tools_apps,public.tools_admins,public.tools_uploads,public.tools_rate_limits to service_role;
create or replace function public.tools_touch_app()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at = now();
  new.version = old.version + 1;
  return new;
end;
$$;
drop trigger if exists tools_apps_updated on public.tools_apps;
create trigger tools_apps_updated before update on public.tools_apps for each row execute function public.tools_touch_app();
revoke all on function public.tools_touch_app() from public,anon,authenticated;

create or replace function public.tools_check_rate(p_key text,p_limit integer,p_seconds integer)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare current_count integer;
begin
  if p_limit < 1 or p_seconds < 1 or p_seconds > 86400 then return false; end if;
  insert into public.tools_rate_limits(key,window_start,count) values(p_key,now(),1)
  on conflict(key) do update set
    count = case when tools_rate_limits.window_start < now() - make_interval(secs => p_seconds) then 1 else tools_rate_limits.count + 1 end,
    window_start = case when tools_rate_limits.window_start < now() - make_interval(secs => p_seconds) then now() else tools_rate_limits.window_start end
  returning count into current_count;
  delete from public.tools_rate_limits where window_start < now() - interval '2 days';
  return current_count <= p_limit;
end;
$$;
revoke all on function public.tools_check_rate(text,integer,integer) from public,anon,authenticated;
grant execute on function public.tools_check_rate(text,integer,integer) to service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('chamcoding-screenshots','chamcoding-screenshots',false,2097152,array['image/png','image/jpeg','image/webp'])
on conflict(id) do nothing;
commit;

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

-- 소개 영상, 홍보 배너, 앱 개발 요청, 회원 리뷰. 참코딩 전용 tools_ 범위만 변경한다.
begin;
alter table public.tools_apps add column if not exists video_url text not null default '';
alter table public.tools_apps add column if not exists featured boolean not null default false;

create table if not exists public.tools_dev_requests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  requester_name text not null,
  contact_email text not null,
  category text not null check (category in ('교과 교육','계기 교육','아침활동','교실놀이','기타')),
  grade text not null,
  purpose text not null,
  features text not null,
  reference_url text not null default '',
  wanted_by text not null default '',
  status text not null default 'pending' check (status in ('pending','reviewing','in_progress','done','rejected')),
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tools_dev_requests_created on public.tools_dev_requests(created_at desc);

create table if not exists public.tools_reviews (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.tools_apps(id) on delete cascade,
  member_id uuid not null,
  member_name text not null,
  body text not null check (char_length(body) between 1 and 1000),
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(app_id, member_id)
);
create index if not exists tools_reviews_app on public.tools_reviews(app_id, updated_at desc);

alter table public.tools_dev_requests enable row level security;
alter table public.tools_reviews enable row level security;
-- 브라우저는 직접 읽거나 쓰지 못하고, 서버 API(service_role)만 접근한다.
revoke all on public.tools_dev_requests,public.tools_reviews from public,anon,authenticated;
grant all on public.tools_dev_requests,public.tools_reviews to service_role;

create or replace function public.tools_touch_row()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function public.tools_touch_row() from public,anon,authenticated;
drop trigger if exists tools_dev_requests_updated on public.tools_dev_requests;
create trigger tools_dev_requests_updated before update on public.tools_dev_requests for each row execute function public.tools_touch_row();
drop trigger if exists tools_reviews_updated on public.tools_reviews;
create trigger tools_reviews_updated before update on public.tools_reviews for each row execute function public.tools_touch_row();
commit;

-- 웹앱 교과(여러 개 선택). 참코딩 전용 tools_apps만 변경한다.
begin;
alter table public.tools_apps add column if not exists subjects jsonb not null default '[]'::jsonb;
alter table public.tools_apps drop constraint if exists tools_apps_subjects_check;
alter table public.tools_apps add constraint tools_apps_subjects_check check (jsonb_typeof(subjects) = 'array');
commit;

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

-- 기타 문의. 참코딩 전용 tools_ 범위만 변경한다.
begin;
create table if not exists public.tools_inquiries (
  id uuid primary key default gen_random_uuid(),
  name text not null default '',
  contact_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending','answered','closed')),
  admin_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tools_inquiries_created on public.tools_inquiries(created_at desc);
alter table public.tools_inquiries enable row level security;
-- 브라우저는 직접 읽거나 쓰지 못하고, 서버 API(service_role)만 접근한다.
revoke all on public.tools_inquiries from public,anon,authenticated;
grant all on public.tools_inquiries to service_role;
drop trigger if exists tools_inquiries_updated on public.tools_inquiries;
create trigger tools_inquiries_updated before update on public.tools_inquiries for each row execute function public.tools_touch_row();
commit;

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
