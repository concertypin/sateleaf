# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.
All agents, such as Claude Code, should keep `**/AGENTS.md` in mind.

## Project Type

This is a **Hono/Node HTTPS reverse proxy** that converts native Gemini text context into PDF attachments before forwarding requests. It includes:

- Dynamic HTTPS upstream routing protected by `PROXY_SECRET`
- Deterministic PDF generation with an OS temporary-file cache
- Vitest running in the Node environment

## Development Commands

```bash
# Start development server (Vite)
pnpm dev

# Build the Node server for production
pnpm build

# Format code
pnpm format

# Lint code
pnpm lint

# Run tests
pnpm test
```

## Runtime Contracts

- `PROXY_SECRET` is required; requests are rejected when it is absent.
- `MAX_REQUEST_BYTES` limits native Gemini request bodies transformed into PDFs.
- `PORT` defaults to `3000` in production.
- `nocache` must bypass all PDF-cache filesystem access.
- Proxy responses may be SSE streams and must not be buffered.

## Coding Standards

See `docs/rules/` for TypeScript, testing, and tooling guidelines.

## TypeScript Configuration

- Path alias: `@/*` maps to `src/*` (configured in `tsconfig.base.json`)

## Package Manager

This project uses pnpm.
