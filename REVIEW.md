# REVIEW.md

퍼블리시 전 전체 리뷰. 대상: `init`(0f377d3) 기준 워킹 트리 전체.
리뷰 방법: 소스/설정/CI/문서 전수 정독 + 실제 실행 검증(단위 테스트, 빌드 산출물 기동, 실제 HTTP 호출, 변환기 직접 실행).

상태 표기:

- **APPLIED** — 이번 리뷰에서 이미 워킹 트리에 반영됨(게이트 통과 확인).
- **OPEN** — 미수정. 나중에 하나씩 처리.

---

## P0 — 퍼블리시 차단

### 1. `pnpm install` 자체가 실패한다 (APPLIED)

`package.json:14`의 `postinstall`이 `pnpm run cf-typegen && simple-git-hooks`였다. `cf-typegen` 스크립트는 존재하지 않는다.

```text
$ pnpm run cf-typegen
ERR_PNPM_NO_SCRIPT  Missing script: cf-typegen
```

`postinstall` 실패는 설치 실패로 이어진다. 즉 문서에 적힌 설치 절차가 아예 동작하지 않았다.

수정: `postinstall`을 `simple-git-hooks`만 남김.

### 2. 저장소 정체성이 템플릿 그대로였다 (APPLIED)

`AGENTS.md`가 스스로를 "Hono backend server template for Cloudflare Workers"라고 소개했고, 존재하지 않는 `wrangler.jsonc`, `src/utils/cors.ts`, "Zod validation", "Cloudflare worker pool"을 언급했다. `README.md`/`src/docs.md`의 설치는 `npm install`이었지만 이 프로젝트는 pnpm 전용(`pnpm-lock.yaml`, `packageManager` 미지정)이라 lockfile이 무시된다.

수정:

- `AGENTS.md`: 프록시 프로젝트 설명으로 교체, 템플릿 복제 안내 및 Cloudflare 절 삭제, 런타임 계약(`PROXY_SECRET`, `MAX_REQUEST_BYTES`, `nocache`, SSE) 명시.
- `README.md` / `src/docs.md`: `corepack enable && pnpm install --frozen-lockfile && pnpm check`로 교체.
- `package.json`: `description`, `license`, `private`, `packageManager: pnpm@10.33.2` 추가.

---

## P1 — 정확성/보안

### 3. `marked` / `marked_combined`가 원본 턴 하나를 content 두 개로 쪼갠다 (APPLIED)

위치: `src/transform/index.ts:208-228`

원본 `contents` 한 개가 결과에서 **두 개의 content**로 갈라진다.

- `payload.native`가 그 턴의 텍스트를 `user` content로 재방출한다. 마커 자리에는 `[Use attached PDF section ... here.]` 플레이스홀더가 들어 있다(`211-214`).
- 같은 원본 턴의 비텍스트 파트가 별도 `user` content로 다시 push된다(`215-222`).

여기서 세 가지가 동시에 어긋난다.

- **(a) 턴 중복.** 한 원본 턴이 두 개의 같은 role content가 된다.
- **(b) PDF가 엉뚱한 턴에 붙는다.** `223-228`의 병합은 마지막 content만 대상으로 하므로, PDF는 플레이스홀더가 가리키는 턴이 아니라 그 뒤에 새로 생긴 미디어 content에 달린다. 플레이스홀더 문구와 실제 첨부 위치가 불일치한다.
- **(c) 순서 소실.** `215-222`는 원본 순서를 따르지 않고 미디어 턴을 전부 뒤로 민다. 원본이 `[텍스트, 이미지, 텍스트]`여도 이미지는 맨 뒤로 간다.

재현 (임시 vitest로 직접 실행, 검증 후 파일 삭제):

```text
입력: marked, contents=[{role:"user",parts:[{text:"look <pdf>text</pdf>"},{inlineData:{mimeType:"image/png",...}}]}]
결과: {"roles":["user","user"],"alternating":false,"hasPdf":true,"keepsImage":true}
```

(a)~(c)는 모두 위 실행에서 관찰한 구조적 사실이다. Gemini가 연속 동일 role을 `400 Please ensure that multiturn requests alternate between user and model`로 거부한다는 서술은 **이번 리뷰에서 실제 API 호출로 확인하지 않았으므로 [추론]으로 표기한다.** 다만 턴 중복과 PDF 부착 위치 오류는 업스트림 규칙과 무관하게 그 자체로 잘못이다.

수정: **원본 턴 하나 = content 하나**를 불변식으로 삼았다. `Message`와 PDF 문서에 원본 인덱스(`sourceIndex`)를 실어 보내고, `contents`를 원본 `source` 순서대로 **한 번의 패스**로 만들면서 같은 턴의 native 텍스트·보존 파트·PDF를 한 content에 합친다. 이로써 (a)의 중복, (b)의 PDF 첨부 위치, (c)의 순서를 함께 해결했다. 멀티턴 입력에서 마커가 첫 번째 user 턴이고 뒤에 model/user 턴이 오는 회귀 테스트도 추가했다.

부수적으로 `maximum`/`balanced`에서도 같은 이유로 미디어 턴이 PDF 턴보다 앞에 온다. 순서 보존은 같은 수정으로 해결된다.

### 4. 잘못된 클라이언트 본문이 502(업스트림 장애)로 보고됐다 (APPLIED)

위치: `src/proxy/index.ts:51-63` (수정 전)

JSON 파싱 실패나 `contents` 스키마 오류가 전부 `502 Upstream request failed`로 나갔다. 업스트림을 호출조차 하지 않았는데 게이트웨이 장애로 위장되므로 클라이언트는 재시도해야 할지 판단할 수 없다.

수정: `InvalidRequestError` 도입(`src/proxy/request.ts:5`) 후 `400`으로 매핑. `413`(용량 초과)과 구분된다. 실제 서버에서 확인:

```json
{
    "malformed": {
        "status": 400,
        "body": {
            "error": "Unexpected token 'o', \"not json\" is not valid JSON"
        }
    }
}
```

### 5. 비-Gemini 패스스루 본문이 무제한으로 버퍼링됐다 (APPLIED)

위치: `src/proxy/request.ts:25-26` (수정 전)

`GET`/`HEAD`가 아니고 Gemini 변환 대상도 아니면 곧바로 `await request.arrayBuffer()`였다. `MAX_REQUEST_BYTES` 검사는 변환 경로에만 적용됐으므로, 시크릿을 아는 호출자가 임의 크기 본문을 메모리에 적재할 수 있었다.

수정: 분기 이전에 `readBodyWithLimit`(`src/proxy/request.ts:46-76`)을 통과시킨다. `content-length` 선검사 후 스트리밍으로 누적 바이트를 세고, 초과 시 `reader.cancel()` 후 `413`. 실제 서버 확인: 30 MB 본문 → `413 {"error":"Request too large"}`.

### 6. `MAX_REQUEST_BYTES`가 검증 없이 매 요청 파싱됐다 (APPLIED)

위치: `src/proxy/index.ts:30-32` (수정 전)

`Number(process.env.MAX_REQUEST_BYTES ?? default)`는 `"abc"` → `NaN`, `"-1"` → `-1`이 된다. `contentLength > NaN`은 항상 `false`이므로 제한이 조용히 사라진다.

수정: 핸들러 생성 시점에 `configuredMaxRequestBytes()`(`src/proxy/index.ts:67-74`)로 한 번만 검증하고, 잘못된 값이면 기동 실패시킨다.

### 7. 캐시 축출이 `ENOENT`로 통째로 실패했다 (APPLIED)

위치: `src/pdf/cache.ts:121-140` (수정 전 `93-105`)

`readdir` 결과를 `Promise.all`로 `stat`하는데, 동시 요청이 그 사이 파일을 지우면 `stat`이 `ENOENT`를 던지고 `Promise.all` 전체가 reject된다. 그러면 `evictEntries`가 실패해 **새 PDF 저장까지 통째로 포기**한다.

수정: 항목별로 `ENOENT`만 무시하는 타입 가드(`isMissingFileError`, `src/pdf/cache.ts:138-142`)를 두고 나머지 오류는 전파.

### 8. 캐시 상한이 검사-후-쓰기라 동시성에서 초과됐다 (APPLIED)

위치: `src/pdf/cache.ts:57-71`, `123-136`

`evictEntries`가 상한을 확인한 뒤 쓰기 전에 다른 요청이 끼어들 수 있었다. 또한 `.tmp` 파일은 `endsWith(".pdf")` 필터에서 빠져 축출 대상이 아니었다.

수정: 모듈 레벨 `cacheMutationQueue`로 축출+쓰기+rename을 직렬화(`queueCacheWrite`, `src/pdf/cache.ts:123-136`). 임시 파일은 `finally`에서 항상 제거한다. 남은 한계는 프로세스 단위 직렬화라는 점(멀티 프로세스 배포 시 상한 초과 가능)이나, 현재 Procfile은 단일 web dyno를 전제한다.

### 9. 잘린/빈 캐시 파일이 정상 PDF로 반환됐다 (APPLIED)

위치: `src/pdf/cache.ts:105-121` (수정 전 `79-89`)

`stat` 후 크기를 검사하지 않았다. 빈 파일이면 `readFile`이 `Buffer.alloc(0)`을 주고, 이는 truthy라 그대로 `""` base64가 되어 업스트림 400을 유발한다.

수정: `lstat`으로 `isFile()` / `isSymbolicLink()` / `size > 0` / `size <= MAX_ENTRY_BYTES` / TTL을 모두 검사하고, 어긋나면 삭제 후 미스 처리.

### 10. 캐시 디렉터리를 검증 없이 신뢰했다 (APPLIED)

위치: `src/pdf/cache.ts:75-84`

`tmpdir()` 아래 고정 이름 디렉터리를 그대로 사용했다. 공용 `/tmp`에서 다른 사용자가 같은 이름의 심볼릭 링크나 디렉터리를 선점하면 캐시 읽기/쓰기가 그쪽을 향한다.

수정: `ensureCacheDirectory`가 심볼릭 링크·비디렉터리·타 사용자 소유(`process.getuid()`가 있을 때만)를 거부하고 `chmod 0700`. 캐시 파일은 `wx` + `0600`으로 생성 후 `rename`(원자적 교체).

한계: Windows에서는 `process.getuid`가 없어 소유자 검사가 생략된다. 로컬 개발 환경 한정이며 배포 대상(Linux)에서는 동작한다.

### 11. CORS 문서가 실제 동작과 달랐다 (APPLIED)

`README.md:38`, `src/docs.md:56`이 "Origin이 없으면 `Access-Control-Allow-Origin: *`"라고 했으나, `src/middleware/cors.ts:9-10`은 Origin이 없으면 아무 헤더도 붙이지 않는다. 실제 동작에 맞게 문구 수정.

### 12. 캐시 히트에서 `utimes` 실패가 유효 항목을 버렸다 (APPLIED)

`src/pdf/cache.ts:48-54`. LRU 갱신 실패가 캐시 미스로 승격되어 PDF를 불필요하게 재생성했다. 실패를 격리하고 PDF는 그대로 반환한다.

---

## P2 — 퍼블리시 전에 결정만 해두면 되는 것 (OPEN)

### 13. `hasValidProxySecret`가 비상수 시간 비교

`src/proxy/route.ts:17-22`에서 `===`로 시크릿을 비교한다. 네트워크 경유 타이밍 공격은 현실성이 낮지만, 인증 경계이므로 `crypto.timingSafeEqual`로 바꾸는 편이 방어적으로 낫다.

### 14. 502 응답이 내부 오류 문자열을 그대로 노출

`src/proxy/index.ts:57-62`가 `error.message`를 클라이언트에 반환한다. `fetch` 실패 메시지에는 대상 호스트명이 포함될 수 있다. 내부 문자열은 로그로만 남기고 클라이언트에는 고정 문구를 주는 편이 안전하다.

### 15. CORS가 모든 Origin을 반사하며 credentials를 허용

`src/middleware/cors.ts:12-13`. 시크릿이 URL에 있으므로 설계상 의도된 동작이고 주석에도 명시되어 있다. 다만 시크릿 URL이 유출되면 임의 웹페이지가 응답을 읽을 수 있다는 뜻이므로, 이 위험을 README에 명시적으로 적어두는 편이 좋다.

### 16. 업스트림 호스트가 완전히 임의다 (SSRF 표면)

`src/proxy/route.ts:36-46`은 `https://` 스킴과 userinfo 부재만 검사하고 호스트를 제한하지 않는다. "업스트림을 URL로 선택한다"는 제품 목적상 의도된 설계이고 시크릿 인증 뒤에 있다. 다만 시크릿을 가진 호출자는 내부 HTTPS 주소로도 요청을 보낼 수 있다. 허용 호스트 목록을 두거나, 최소한 이 결정을 문서화해야 한다.

### 17. CI 린트가 자동 수정 모드로 돈다

`.github/workflows/lint.yml:24`가 `pnpm lint`를 실행하는데 `package.json:7`의 `lint`는 `--fix`를 포함한다. CI에서 위반을 고쳐버리고 통과하므로 린트 게이트가 무력화된다. `pnpm lint:check`로 바꿔야 한다.

### 18. 그레이스풀 셧다운 없음

`src/index.ts:15-24`는 `serve()`만 호출한다. Heroku는 배포 시 SIGTERM을 보내는데, 진행 중인 SSE 스트림이 그대로 끊긴다. `server.close()` + 유예 시간 처리를 추가하는 편이 좋다.

### 19. Heroku 빌드에서 pnpm 사용 보장

`Procfile:1`이 `pnpm start`인데 Heroku Node buildpack은 기본적으로 `npm install`을 돌린다. `packageManager` 필드를 추가했으니 corepack 기반 감지가 되겠지만, 실제 배포 전에 한 번 확인이 필요하다.

### 20. 테스트 커버리지 공백

현재 테스트는 7개다. 다음 경로는 자동 검증이 없다.

- `401`(시크릿 불일치/부재), 라우트 파싱 실패 `400`
- CORS 반사 동작
- `marked` / `marked_combined` / `balanced` 모드 변환 (3번 결함이 여기서 드러났다)
- 캐시 TTL 만료와 상한 축출
- `src/middleware/cors.ts`, `src/index.ts`는 커버리지 0%

CI 임계값은 20%로 낮게 잡혀 있다(`test.yml:73`).

### 21. `src/index.ts` / `cors.ts`가 테스트에서 전혀 실행되지 않음

`createProxyHandler`를 직접 조립해 테스트하므로 실제 앱(`src/index.ts`)의 라우트 구성·미들웨어 순서는 검증되지 않는다. `app.request`를 실제 앱에 던지는 형태의 스모크 테스트가 하나 있으면 좋다.

### 22. `AGENTS.md`에 남은 끊긴 참조

`AGENTS.md:43`이 "See `docs/rules/` for TypeScript, testing, and tooling guidelines."라고 안내하지만 `docs/` 디렉터리 자체가 저장소에 없다(확인함). 항목 2에서 템플릿 서술을 걷어낼 때 이 줄이 남았다.

같은 파일 `AGENTS.md:47`의 "Path alias: `@/*` maps to `src/*` (configured in `tsconfig.base.json`)"는 실제와 일치한다(`tsconfig.base.json:34-35`). 이쪽은 정상이다.

수정: `docs/rules/` 줄을 삭제하거나, 실제 규칙 문서 위치로 바꾸거나, `docs/rules/`를 만들어야 한다.

### 23. marked PDF가 여러 원본 user 턴에서 마지막 턴에만 붙는다 (OPEN)

재리뷰에서 확인했다. 현재 `src/transform/index.ts:233-237`은 생성된 PDF 파트 전체를 `contents.at(-1)`의 user content에 붙인다. 따라서 PDF 마커가 첫 번째 user 턴에 있고 그 뒤에 또 다른 user 턴이 있으면, 플레이스홀더는 첫 번째 턴에 남지만 PDF는 마지막 user 턴으로 이동한다. 항목 3의 단일 턴+이미지 회귀 테스트는 통과하지만, 여러 user 턴에 걸친 marked 입력은 아직 고정되지 않았다.

권장 수정: PDF 문서와 원본 `sourceIndex`를 함께 보존해 각 문서의 PDF 파트를 해당 원본 user content에 병합한다. 수정 전까지 퍼블리시 차단 수준의 정확성 이슈로 유지한다.

---

## 확인된 정상 동작 (참고)

실제 빌드 산출물(`dist/index.js`)을 기동해 확인했다.

```json
{
    "health": 200,
    "docs": { "status": 200, "type": "text/markdown; charset=utf-8" },
    "noSecret": { "status": 401, "body": { "error": "Invalid proxy secret" } },
    "malformed": { "status": 400 },
    "tooLarge": { "status": 413, "body": { "error": "Request too large" } }
}
```

- SSE 중계: `content-length`/`content-encoding`만 제거하고 `content-type`, `cache-control`, 사용자 정의 헤더, 본문은 그대로 통과(`tests/unit/proxy.test.ts`).
- PDF 캐시: 동일 입력 재사용, `nocache`는 파일시스템 접근 자체를 건너뜀(`tests/unit/pdf-cache.test.ts`).
- 게이트: `oxfmt --check`, `oxlint --type-aware --type-check`, `vitest`, `vite build` 모두 통과.

---

## 이번 리뷰에서 워킹 트리에 반영된 변경

되돌리려면 `git checkout -- <path>`.

| 파일                           | 내용                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `package.json`                 | `postinstall` 수정, 메타데이터 4개 추가                                              |
| `AGENTS.md`                    | 템플릿/Cloudflare 서술 제거, 런타임 계약 명시 (항목 22의 끊긴 참조는 아직 남아 있음) |
| `README.md`, `src/docs.md`     | 설치 절차, CORS 서술, 캐시 보존 정책 정정                                            |
| `src/proxy/index.ts`           | 요청 크기 상한 검증·적용, `400`/`413` 구분                                           |
| `src/proxy/request.ts`         | 전 본문 스트리밍 상한, `InvalidRequestError`                                         |
| `src/pdf/cache.ts`             | 원자적 쓰기, 직렬화, 디렉터리 검증, 손상 항목 거부, `utimes` 격리                    |
| `src/transform/index.ts`       | 원본 턴별 텍스트·미디어·PDF 병합 및 순서 보존                                        |
| `tests/unit/proxy.test.ts`     | `413`, `400` 회귀 테스트                                                             |
| `tests/unit/transform.test.ts` | marked 병합 회귀 테스트                                                              |

`src/transform/index.ts`의 marked 멀티턴 PDF 부착 위치 문제도 해결되었고, 회귀 테스트를 추가했다.
