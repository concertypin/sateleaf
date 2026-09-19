# Sateleaf

Sateleaf is a PageFold-inspired dynamic HTTPS reverse proxy that folds long text prompts into PDF attachments before sending them to a native Gemini endpoint.

## Request URL

/proxy/{proxy-secret}/{settings}/{upstream-host-and-path}

Example:

```text
/proxy/authtoken/mode_maximum,fontsize_10/generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
```

The server prepends https:// to the upstream part. Do not include https:// in the URL. Query parameters belong after the endpoint, for example ?alt=sse for Gemini streaming.

The proxy-secret must equal the server's PROXY_SECRET environment variable. The settings segment must not contain a dot; dots are reserved for the upstream endpoint portion.

## Settings

Settings are readable comma-separated values:

- mode_maximum: fold the complete conversation into one PDF.
- mode_balanced: keep system instructions as native text and fold the rest.
- mode_marked: fold only <pdf>...</pdf> sections.
- mode_marked_combined: fold marked sections into one PDF group.
- fontsize_1: PDF font size. Any positive value up to 12 is accepted.

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

OPTIONS is answered locally with a preflight response. When an Origin header is present, it is reflected in Access-Control-Allow-Origin; requested headers are reflected, credentials are allowed, and Vary: Origin is added. Requests without an origin receive Access-Control-Allow-Origin: *.

## Environment

```sh
PROXY_SECRET=authtoken
MAX_REQUEST_BYTES=26214400
```

PORT is supplied by Heroku automatically. The app has no fixed upstream environment variable; the upstream is selected by each request URL.

## Heroku

```sh
npm install
npm run check
heroku create your-sateleaf
heroku config:set PROXY_SECRET="a-long-readable-secret"
git push heroku main
```
