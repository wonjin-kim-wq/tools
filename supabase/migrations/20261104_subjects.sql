-- 웹앱 교과(여러 개 선택). 참코딩 전용 tools_apps만 변경한다.
begin;
alter table public.tools_apps add column if not exists subjects jsonb not null default '[]'::jsonb;
alter table public.tools_apps drop constraint if exists tools_apps_subjects_check;
alter table public.tools_apps add constraint tools_apps_subjects_check check (jsonb_typeof(subjects) = 'array');
commit;
