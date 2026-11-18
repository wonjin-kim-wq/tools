-- [기존 quiz-games 프로젝트에서 실행] 참코딩 회원(app_metadata.chamcoding_member=true)과 로그인 수단을 JSON 한 칸으로 내보낸다.
-- 비밀번호는 Supabase가 저장한 해시 그대로 옮기므로 회원은 같은 비밀번호로 로그인한다. 결과를 채팅이나 파일에 남기지 않는다.
with u as (select * from auth.users where raw_app_meta_data->>'chamcoding_member' = 'true'),
     i as (select i.* from auth.identities i join u on u.id = i.user_id)
select json_build_object(
  'users', coalesce((select json_agg(to_jsonb(u)) from u), '[]'),
  'identities', coalesce((select json_agg(to_jsonb(i)) from i), '[]')
)::text as chamcoding_members;
