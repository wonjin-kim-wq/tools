begin;
alter table public.tools_apps drop constraint if exists tools_apps_category_check;
alter table public.tools_apps add constraint tools_apps_category_check
  check (category in ('교과 교육','계기 교육','아침활동','교실놀이','기타'));
commit;
