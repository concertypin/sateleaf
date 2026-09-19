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

The endpoint is always HTTPS and omits the `https://` prefix. Its query string is supplied normally after the endpoint, for example `?alt=sse`. The incoming `Authorization: Bearer ...` is passed to the upstream unchanged.

Supported transformed requests:

- Gemini native `POST .../models/:model:generateContent`
- Gemini native streaming `POST .../models/:model:streamGenerateContent?alt=sse`

Other paths and methods are transparent pass-throughs.

## Caching and retention

Sateleaf generates deterministic PDFs and tries to preserve stable request prefixes so the upstream Gemini service can reuse its implicit prompt cache, but upstream cache hits are not guaranteed.

Generated PDFs are reused from an LRU cache in the operating system's temporary directory, bounded to 64 entries, 32 MiB total, 8 MiB per entry, and a 10-minute TTL. Cache filenames are SHA-256 digests and do not contain prompt text, but cached PDF files retain the transformed content until eviction. Add `nocache` to the settings segment, for example `mode_maximum,fontsize_1,nocache`, to skip all cache filesystem access for that request.

## CORS

The proxy handles preflight itself. For a request with `Origin`, it reflects that origin, reflects requested headers, allows credentials, exposes all response headers, and adds `Vary: Origin`. Requests without an Origin receive `Access-Control-Allow-Origin: *`.

## Heroku Eco

```sh
npm install
npm run check
heroku create your-sateleaf
heroku config:set PROXY_SECRET="a-long-readable-secret"
git push heroku main
```

For a client that only supports base URL plus Bearer authorization, configure the base URL as the fixed `/proxy/.../` prefix and use the provider key as its Bearer token. The proxy secret remains in the URL, while the Bearer value passes through to the selected provider.

Do not put a dot in the settings segment. Dots are reserved for the upstream endpoint segment.
