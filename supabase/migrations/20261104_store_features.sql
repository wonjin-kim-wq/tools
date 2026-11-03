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
