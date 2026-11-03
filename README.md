# 참코딩

기존 카드·검색·분류 화면과 업로드 요청, 대기 목록, 관리자 검토를 제공하는 Vercel 정적 사이트 + Node API입니다. 데이터와 이미지는 Supabase에 보관합니다.

최근 변경 사항과 카드·캐릭터의 현재 동작 설정은 [작업 기록](WORK_LOG.md)에 정리했습니다.

## 실행과 검사

```sh
npm test
npm run build
npm run dev
```

`npm run dev`는 `http://127.0.0.1:8741`에서 실행합니다. 실제 API는 아래 환경 변수가 필요합니다. 로컬에 계정을 생성하지 않고 브라우저 검증하려면 `node tests/ui-server.js`를 사용합니다. 이 격리된 메모리 서버는 8742 포트에서 실행하며 테스트용 관리자 `local-admin` / `local-admin-test-only`, 업로더 비밀번호 `local-upload-test-only`를 제공합니다. 테스트 서버와 자격 증명은 배포되지 않습니다.

## Supabase

`supabase/schema.sql`은 `tools_` 전용 테이블 4개와 `chamcoding-screenshots` 비공개 버킷을 만듭니다. `supabase/seed.sql`은 기존 예시 앱 10개를 추가하며 같은 ID가 있으면 기존 내용을 보존합니다. 기존 프로젝트의 다른 테이블과 인증 설정은 변경하지 않습니다.

환경 변수는 Vercel **서버 비밀 변수**로 설정합니다. 클라이언트에 키를 넣거나 `NEXT_PUBLIC_` 같은 공개 접두사를 붙이지 않습니다.

| 변수 | 용도 |
| --- | --- |
| `SUPABASE_URL` | Supabase 프로젝트 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 API 키 |
| `SESSION_SECRET` | 충분히 긴 무작위 세션 서명 키 |
| `UPLOAD_PASSWORD` | 연구회 업로더 공통 비밀번호 |
| `ADMIN_SETUP_TOKEN` | 최초 관리자 등록용 무작위 일회성 토큰 |

`tools_admins`에 등록한 사이트 관리자는 Supabase 대시보드 계정과 별개입니다. 최초 등록은 소유자에게 전달하는 `/#setup=…` 링크에서만 가능합니다. 첫 계정이 생성되면 추가 등록은 서버에서 차단됩니다. 관리자 비밀번호는 scrypt와 개별 salt로 해시하며, 로그인 세션은 HttpOnly·Secure·SameSite=Strict 쿠키를 사용합니다. 설정 토큰은 URL fragment에서 읽은 직후 주소 표시줄에서 제거됩니다. 등록이 끝나면 Vercel의 `ADMIN_SETUP_TOKEN`을 제거할 수 있습니다.

## 요청과 검토

- 업로더는 공통 비밀번호로 요청 폼과 전체 요청 상태 목록에 접근합니다. 연락 이메일은 관리자에게만 표시합니다.
- 스크린샷은 1~6장, 클라이언트에서 최대 1800px로 조정하고 서버에서 파일당 2MB와 실제 파일 형식을 검증합니다. 비공개 저장소의 1시간 서명 URL을 통해 보여줍니다.
- 요청은 항상 `pending`으로 저장합니다. 업로더가 승인 상태나 사용 횟수를 보내도 무시합니다.
- 관리자는 앱 정보·스크린샷·설명을 수정하고 승인, 수정 요청, 반려, 공개 중지를 처리합니다. 승인된 앱만 공개 API가 반환합니다.
- 검토 버전이 바뀐 요청은 덮어쓰지 않고 다시 불러오도록 안내합니다.
- 업로드하지 못하고 남은 스크린샷은 비공개 버킷에 남을 수 있습니다. 운영 중 정리할 때 `tools_apps.screenshots`에 참조되지 않는 오래된 `tools_uploads` 경로만 선별합니다.

`npm test`에는 권한 분리, 세션 변조·만료, URL·이미지 검증, 검토 수정과 승인 후 공개, 동시 수정 충돌 테스트가 포함됩니다. 실제 관리자 계정은 테스트 과정에서 생성하지 않습니다.

## 일반 회원 로그인

일반 회원은 Supabase Auth의 이메일·비밀번호 가입과 인증을 사용합니다. 기존 업로더·관리자 쿠키와 분리한 `chamcoding_member` HttpOnly 쿠키를 사용하며 세션 유효시간은 최대 1시간입니다. 비밀번호와 Supabase 토큰은 프런트엔드 응답이나 로컬 저장소에 보관하지 않습니다.

서버가 가입 시 `app_metadata.chamcoding_member`, `app_metadata.chamcoding_content_access`를 설정합니다. 사용자 수정이 가능한 `user_metadata`는 접근 권한으로 사용하지 않습니다. `/api/tools?action=member-content`는 실제 Supabase 사용자 검증과 회원 권한 확인 후 응답합니다. 현재 콘텐츠 목록은 비어 있으며 향후 전용 콘텐츠 API에도 같은 검사를 적용합니다. `chamcoding_content_access=false`로 이용 권한을 중지할 수 있습니다. 일반 회원 자격은 업로드 승인·관리자 권한을 부여하지 않습니다.

Supabase의 이메일 인증 설정과 SMTP 발송 제한을 적용합니다. 운영용 회원가입에는 Supabase의 발송 설정을 확인해야 합니다. 기존 mono 앱의 인증 설정을 일괄 변경하지 않습니다.

대표 썸네일은 업로드한 첫 번째 이미지이며 기존 JSON 스크린샷 구조를 그대로 사용합니다. 대표 사진 교체와 순서 변경은 관리자 수정 화면에서 처리할 수 있습니다.

## 관리자 화면에서 업로드 비밀번호 변경

관리자 로그인 후 **업로드 비밀번호** 메뉴에서 현재 관리자 비밀번호와 새 업로드 비밀번호(8자 이상), 확인을 입력합니다. `supabase/migrations/20261103_upload_password.sql`을 먼저 적용해야 합니다.

새 업로드 비밀번호는 `tools_admins`의 별도 scrypt 해시·salt로 저장합니다. 첫 변경 전에는 기존 `UPLOAD_PASSWORD` 환경 변수 값을 사용하며, 첫 변경 후에는 DB에 저장된 해시를 사용합니다. 기존 비밀번호는 화면이나 API에서 조회할 수 없습니다. 변경 즉시 기존 업로더 세션을 무효화하며 관리자·일반 회원의 세션에는 영향을 주지 않습니다. 재배포가 필요하지 않고, 이후 배포에서도 DB 설정이 유지됩니다.
