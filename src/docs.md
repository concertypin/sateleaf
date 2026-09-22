# Sateleaf

Sateleaf is a PageFold-inspired dynamic HTTPS reverse proxy that folds long text prompts into PDF attachments before sending them to a native Gemini endpoint.

## Request URL

/proxy/{proxy-secret}/{settings}/{upstream-host-and-path}

Example:

```text
/proxy/authtoken/mode_maximum,fontsize_10/generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
```

The server prepends https:// to the upstream part. Do not include https:// in the URL. Query parameters belong after the endpoint, for example ?alt=sse for Gemini streaming.

The proxy-secret must equal one of the comma-separated values in the server's PROXY_SECRET environment variable. Whitespace around values is ignored. The settings segment must not contain a dot; dots are reserved for the upstream endpoint portion.

## Settings

Settings are readable comma-separated values:

- mode_maximum: fold the complete system instruction and conversation into one PDF. Choose this when minimizing native prompt text matters most.
- mode_balanced: fold the conversation into a PDF but keep the system instruction as native Gemini text. This is the general-purpose compromise.
- mode_marked: fold only text inside `<pdf>...</pdf>` markers; text outside remains native. Choose this for precise per-section control.
- mode_marked_combined: like `mode_marked`, but emit separate `root / PART n` PDF attachments for each marked section and ignore any `name=` attribute.
- fontsize_1: PDF font size. Any positive value up to 12 is accepted.

Non-text parts such as images are preserved in every mode, and generated PDFs are attached to the originating user turn. A source turn remains one Gemini content entry.

### 모드 선택 가이드

- `maximum`: 전체 대화와 시스템 지시를 PDF 하나로 변환합니다. 네이티브 텍스트를 가장 많이 줄이는 모드입니다.
- `balanced`: 대화만 PDF로 변환하고 시스템 지시는 네이티브 텍스트로 유지합니다. 기본 절충안으로 사용하기 좋습니다.
- `marked`: `<pdf>...</pdf>` 내부만 PDF로 변환합니다. 특정 구간만 변환할 때 사용합니다.
- `marked_combined`: 각 marker 구간을 별도의 `root / PART n` PDF 첨부파일로 만들고 `name=` 속성은 무시합니다.

이미지 등 미디어 파트는 모든 모드에서 유지되고 PDF는 원래 user turn에 병합됩니다.

The equals spelling (mode=maximum,fontSize=1) is accepted too, but the underscore spelling is intended for base-URL-only clients. Add `nocache` to bypass the local PDF cache for a request.

## Caching and retention

Sateleaf generates deterministic PDFs and tries to preserve stable request prefixes so the upstream Gemini service can reuse its implicit prompt cache, but upstream cache hits are not guaranteed.

Generated PDFs are reused from an LRU cache in the operating system's temporary directory, bounded to 64 entries, 32 MiB total, 8 MiB per entry, and a 10-minute TTL. Cache filenames are SHA-256 digests and contain no prompt text. Cached PDF files retain transformed content until eviction. Use settings such as `mode_maximum,fontsize_1,nocache` when that retention is not acceptable; `nocache` performs no cache filesystem access.

## Authentication and headers

All incoming headers are passed through opaquely, including:

- Authorization: Bearer ...
- X-Goog-API-Key: ...
- provider-specific API-key or routing headers

The proxy does not need to know which provider header is being used. It removes only request-framing or hop-by-hop headers that must be regenerated: Host, Content-Length, Connection, and Transfer-Encoding.

## Transformed endpoints

- Gemini: POST .../models/:model:generateContent
- Gemini streaming: POST .../models/:model:streamGenerateContent?alt=sse

Other methods and paths are passed through without PDF transformation. Upstream response status, headers, body, and streaming data are returned unchanged except for hop-by-hop framing headers and added CORS headers.

## CORS

OPTIONS is answered locally with a preflight response. When an Origin header is present, it is reflected in Access-Control-Allow-Origin; requested headers are reflected, credentials are allowed, and Vary: Origin is added. Requests without an Origin header receive no CORS headers.

## Environment

```sh
PROXY_SECRET=authtoken
# Multiple values are supported, for example:
# PROXY_SECRET=primary-secret, backup-secret
MAX_REQUEST_BYTES=26214400
```

PORT is supplied by Heroku automatically. The app has no fixed upstream environment variable; the upstream is selected by each request URL.

## Heroku

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
heroku create your-sateleaf
heroku config:set PROXY_SECRET="a-long-readable-secret"
git push heroku main
```
