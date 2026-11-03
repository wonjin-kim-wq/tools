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
