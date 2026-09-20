# Sateleaf

Hono/Node reverse proxy inspired by PageFold. The upstream is selected per URL, so changing providers does not require a redeploy.

Usage documentation is also served as Markdown at `/docs`.

## URL format

```text
https://your-server.example/proxy/{proxy-secret}/{settings}/{upstream-host-and-path}
```

Example:

```text
https://your-server.example/proxy/my-secret/mode_maximum,fontsize_1/generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
```

`settings` is a readable comma-separated list. It must not contain a dot. The compact form is `mode_maximum,fontsize_1` (also `mode_balanced`, `mode_marked`, and `mode_marked_combined`). The `mode=...` / `fontSize=...` spelling is also accepted.

### Choosing a mode

- `maximum`: Put the complete system instruction and conversation into one PDF. Use this when reducing the prompt's native text size is the priority.
- `balanced`: Put the conversation into a PDF while keeping the system instruction as native Gemini text. Use this as the general-purpose compromise.
- `marked`: Put only text inside `<pdf>...</pdf>` markers into PDFs; text outside the markers remains native. Use this when you need precise per-section control.
- `marked_combined`: Like `marked`, but force every marked section into separate `root / PART n` PDF attachments, ignoring any `name=` attribute.

In every mode, non-text parts such as images are preserved and generated PDFs are attached to the originating user turn. A source turn remains one Gemini content entry rather than being split into separate consecutive user entries.

#### 모드 쉽게 고르기

- `maximum`: 전체 대화와 시스템 지시를 PDF 하나로 접습니다. 네이티브 텍스트를 최대한 줄이고 싶을 때 사용합니다.
- `balanced`: 대화는 PDF로 접고 시스템 지시는 네이티브 텍스트로 남깁니다. 일반적인 사용에 적합한 절충 모드입니다.
- `marked`: `<pdf>...</pdf>` 안의 텍스트만 PDF로 접습니다. 필요한 부분만 선택하고 싶을 때 사용합니다.
- `marked_combined`: `marked`와 같지만 각 marker를 별도의 `root / PART n` PDF 첨부파일로 만들고 `name=` 속성은 무시합니다.

이미지 같은 미디어 파트는 모든 모드에서 유지되며, 생성된 PDF는 원래 user turn에 함께 첨부됩니다.

The endpoint is always HTTPS and omits the `https://` prefix. Its query string is supplied normally after the endpoint, for example `?alt=sse`. The incoming `Authorization: Bearer ...` is passed to the upstream unchanged. Gemini API-key clients can send `x-goog-api-key` instead; request headers are forwarded to the selected upstream.

For Gemini PDF-context verification, use a unique sentinel in the source text and ask the model to repeat it. A successful answer alone is useful, but `usageMetadata.promptTokensDetails` should also contain an `IMAGE` entry to confirm that Gemini processed the generated PDF modality.

Supported transformed requests:

- Gemini native `POST .../models/:model:generateContent`
- Gemini native streaming `POST .../models/:model:streamGenerateContent?alt=sse`

Other paths and methods are transparent pass-throughs.

## Caching and retention

Sateleaf generates deterministic PDFs and tries to preserve stable request prefixes so the upstream Gemini service can reuse its implicit prompt cache, but upstream cache hits are not guaranteed.

Generated PDFs are reused from an LRU cache in the operating system's temporary directory, bounded to 64 entries, 32 MiB total, 8 MiB per entry, and a 10-minute TTL. Cache filenames are SHA-256 digests and do not contain prompt text, but cached PDF files retain the transformed content until eviction. Add `nocache` to the settings segment, for example `mode_maximum,fontsize_1,nocache`, to skip all cache filesystem access for that request.

## CORS

The proxy handles preflight itself. For a request with `Origin`, it reflects that origin, reflects requested headers, allows credentials, exposes all response headers, and adds `Vary: Origin`. Requests without an `Origin` header receive no CORS headers.

## Heroku Eco

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
heroku create your-sateleaf
heroku config:set PROXY_SECRET="a-long-readable-secret"
git push heroku main
```

For a client that only supports base URL plus Bearer authorization, configure the base URL as the fixed `/proxy/.../` prefix and use the provider key as its Bearer token. The proxy secret remains in the URL, while the Bearer value passes through to the selected provider.

Do not put a dot in the settings segment. Dots are reserved for the upstream endpoint segment.
