# 참코딩

기존 카드·검색·분류 화면과 업로드 요청, 대기 목록, 관리자 검토를 제공하는 Vercel 정적 사이트 + Node API입니다. 데이터와 이미지는 Supabase에 보관합니다.

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
