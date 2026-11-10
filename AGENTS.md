# 참코딩 — 작업 전 GitHub·배포 확인

- GitHub: [wonjin-kim-wq/tools](https://github.com/wonjin-kim-wq/tools) · 운영 브랜치: `main`
- Vercel: `tools` 프로젝트 · `main` 푸시 시 자동 배포
- 운영: [www.chamssaem.kr](https://www.chamssaem.kr/)

## 매 작업 시작 전

1. 저장소 루트에서 `git status --short --branch`와 `git remote -v`를 확인한다. 기존 수정과 브랜치를 보존한다.
2. `main`에서는 파일을 수정하기 전에 `git pull --ff-only origin main`을 실행한다. `git rev-parse HEAD origin/main`으로 양쪽 SHA가 같은지 확인하고, pull로 이 문서가 바뀌었으면 다시 읽는다. 다른 브랜치에서 작업 중이면 `git fetch origin main`으로 최신 `origin/main`을 확인하고, 동기화가 필요하면 별도 `main` 작업 트리에서 pull한다. 작업 브랜치에 `main`을 자동으로 합치지 않는다. 기존 수정과 겹치거나 로컬 커밋 때문에 fast-forward가 불가능하면 원인을 알리고 작업물을 보존한다.
3. 아래 절차로 최신 `origin/main` 커밋의 Vercel 상태와 운영 응답을 확인한다. 원격 조회에 실패하면 마지막으로 확인된 SHA와 현재 확인하지 못한 항목을 구분해 기록한다.
4. 로컬에 `AGENTS.local.md`가 있으면 이어서 읽는다. 이 파일은 비공개 인계 문서이므로 커밋하지 않는다.

## Vercel 배포 확인

저장소 루트에서 실행한다. GitHub에서 현재 `origin/main`의 정확한 SHA에 연결된 Vercel 상태를 가져온다.

```sh
sha="$(git rev-parse origin/main)" &&
  curl -fsS --max-time 15 "https://api.github.com/repos/wonjin-kim-wq/tools/commits/$sha/status" |
  node -e 'const d = JSON.parse(require("node:fs").readFileSync(0, "utf8")); const v = d.statuses.find(s => s.context === "Vercel"); console.log(JSON.stringify({sha:d.sha, state:v?.state ?? "missing", details:v?.target_url}, null, 2));'
```

- `success`면 같은 SHA의 Production 배포도 확인한다. 위에서 정한 `$sha`로 아래 URL을 조회하고, 최신 항목의 `statuses_url`을 열어 최근 상태가 `success`인지 본다.

```sh
curl -fsS --max-time 15 "https://api.github.com/repos/wonjin-kim-wq/tools/deployments?sha=$sha&environment=Production"
```

- GitHub API를 읽을 수 없으면 [GitHub main 커밋 목록](https://github.com/wonjin-kim-wq/tools/commits/main/)의 해당 커밋 상태 또는 Vercel 프로젝트의 Deployments에서 같은 SHA를 찾는다. `pending`은 진행 중, `failure`·`error`는 실패다. 상태가 없거나 권한이 없으면 미확인으로 남긴다.
- 운영 홈과 읽기 전용 공개 목록 API가 200을 반환하는지 확인한다. 200은 사이트 응답을 뜻하므로, 최신 커밋의 반영 여부는 위 배포 상태와 화면 또는 파일이 바뀌었다면 해당 결과로 확인한다.

```sh
curl -fsSL --max-time 15 -o /dev/null -w '운영 홈: %{http_code}\n' 'https://www.chamssaem.kr/'
curl -fsSL --max-time 15 -o /dev/null -w '공개 목록: %{http_code}\n' 'https://www.chamssaem.kr/api/tools?action=apps'
```

푸시를 요청받은 작업은 푸시한 SHA가 GitHub `main`에 있는지 확인하고, 같은 SHA의 Vercel 상태와 운영 응답을 다시 확인한다. 보고할 때는 GitHub SHA, Vercel 상태, 운영 확인 결과를 구분한다.
