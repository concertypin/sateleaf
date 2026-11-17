import type { CanonicalRequest } from "ai-compatibles";
import { createTransformStream, ProviderRequestError } from "ai-compatibles";
import {
    createGeminiGenerateContentAdapter,
    geminiModelUrl,
    normalizeGeminiError,
} from "ai-compatibles/adapters/gemini-generate-content";
import {
    createOpenAIChatAdapter,
    encodeOpenAIChatError,
    encodeOpenAIChatResponse,
    parseOpenAIChatRequest,
} from "ai-compatibles/adapters/openai-chat";
import { transformGemini } from "@/transform/index.js";
import { InvalidRequestError } from "./request.js";
import type { ProxyRoute } from "./route.js";

const OPENAI_CHAT_SUFFIX = /\/openai\/chat\/completions\/?$/u;
const BEARER = /^Bearer\s+(.+)$/iu;

const gemini = createGeminiGenerateContentAdapter();
const openaiChat = createOpenAIChatAdapter();

/**
 * Returns the native Gemini base path for an OpenAI-compatible chat path
 * (`…/openai/chat/completions` → `…`), or null for other paths.
 */
export function openAIChatBasePath(pathname: string): string | null {
    return OPENAI_CHAT_SUFFIX.test(pathname)
        ? pathname.replace(OPENAI_CHAT_SUFFIX, "")
        : null;
}

/** A decoded OpenAI chat request ready to be forwarded to Gemini. */
export interface OpenAIChatCall {
    canonical: CanonicalRequest;
    /** Native Gemini body, built before any response is committed */
    native: unknown;
    stream: boolean;
    /** Native `…/models/{model}:(stream)GenerateContent` URL */
    upstream: URL;
}

/**
 * Decodes an OpenAI chat body and resolves the native Gemini URL. Throws
 * ai-compatibles request errors, which `openAIErrorResponse` renders.
 */
export function decodeOpenAIChat(
    bytes: Uint8Array,
    route: ProxyRoute,
    basePath: string
): OpenAIChatCall {
    let body: unknown;
    try {
        body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        body = undefined;
    }
    const canonical = parseOpenAIChatRequest(body);
    // Built here so mapping errors get a real 400 before early keepalive
    // commits a 200.
    const native = gemini.buildRequest(canonical);
    const stream = canonical.stream === true;
    const upstream = new URL(
        geminiModelUrl(
            `${route.upstream.protocol}//${route.upstream.host}${basePath}`,
            canonical.model,
            stream
        )
    );
    // Keep caller query parameters (e.g. `key`) next to the method's own.
    for (const [name, value] of route.upstream.searchParams) {
        if (name !== "alt") upstream.searchParams.append(name, value);
    }
    return { canonical, native, stream, upstream };
}

/** Builds the PDF-folded native Gemini body for a decoded call. */
export async function createOpenAIUpstreamBody(
    call: OpenAIChatCall,
    route: ProxyRoute
): Promise<{ body: string; transformMs: number }> {
    const started = performance.now();
    let output;
    try {
        output = await transformGemini(
            call.native,
            route.mode,
            route.fontSize,
            route.cachePdf
        );
    } catch (error) {
        throw new InvalidRequestError(
            error instanceof Error ? error.message : "Invalid request body"
        );
    }
    return {
        body: JSON.stringify(output),
        transformMs: performance.now() - started,
    };
}

/** Client headers that mean something to Google; OpenAI SDK headers do not. */
const FORWARDED_HEADERS = [
    "x-goog-api-key",
    "x-goog-user-project",
    "user-agent",
];

/**
 * Builds the headers for the native Gemini call from an OpenAI client's
 * headers: an OpenAI-style `Authorization: Bearer <key>` becomes
 * `x-goog-api-key` (unless one was sent already), except on Vertex
 * project paths, where the bearer is an OAuth token and is kept.
 */
export function toGeminiHeaders(headers: Headers, upstream: URL): Headers {
    const result = new Headers({ "content-type": "application/json" });
    for (const name of FORWARDED_HEADERS) {
        const value = headers.get(name);
        if (value !== null) result.set(name, value);
    }
    const authorization = headers.get("authorization");
    if (authorization === null) return result;
    if (upstream.pathname.includes("/projects/")) {
        result.set("authorization", authorization);
        return result;
    }
    const key = BEARER.exec(authorization)?.[1]?.trim();
    if (key && !result.has("x-goog-api-key")) result.set("x-goog-api-key", key);
    return result;
}

/** Translates a Gemini response into the OpenAI chat dialect. */
export async function toOpenAIResponse(
    upstream: Response,
    call: OpenAIChatCall
): Promise<Response> {
    if (!upstream.ok) {
        const text = await upstream.text();
        let parsed: unknown = text;
        try {
            parsed = JSON.parse(text);
        } catch {
            /* keep the raw text */
        }
        const response = openAIErrorResponse(
            new ProviderRequestError(
                normalizeGeminiError(parsed, upstream.status)
            )
        );
        // OpenAI SDKs back off on 429/503 using this header.
        const retryAfter = upstream.headers.get("retry-after");
        if (retryAfter !== null)
            response.headers.set("retry-after", retryAfter);
        return response;
    }
    if (call.stream) {
        const body =
            upstream.body?.pipeThrough(
                createTransformStream({ from: gemini, to: openaiChat })
            ) ?? null;
        return new Response(body, {
            status: 200,
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
            },
        });
    }
    let normalized;
    try {
        normalized = gemini.normalizeResponse(await upstream.json());
    } catch (error) {
        // Failed generations (malformed function call, …) become API errors.
        if (error instanceof ProviderRequestError)
            return openAIErrorResponse(error);
        throw error;
    }
    const message = Array.isArray(normalized) ? normalized[0] : normalized;
    if (message === undefined)
        return openAIErrorResponse(new Error("Gemini returned no candidates"));
    return Response.json(
        encodeOpenAIChatResponse(message, {
            model: message.model ?? call.canonical.model,
        })
    );
}

/** Renders any error as an OpenAI error body with its HTTP status. */
export function openAIErrorResponse(error: unknown, status?: number): Response {
    const encoded = encodeOpenAIChatError(error);
    return Response.json(encoded.body, { status: status ?? encoded.status });
}

/** OpenAI error body for a plain proxy failure (route, size, network…). */
export function openAIProxyError(status: number, message: string): Response {
    return openAIErrorResponse(
        { statusCode: status, message, provider: "sateleaf" },
        status
    );
}

/**
 * The OpenAI error object of an error response, with the HTTP status it
 * would have had added as `status` (early keepalive already sent a 200).
 */
async function committedError(
    response: Response
): Promise<{ error: Record<string, unknown> }> {
    let body: unknown;
    try {
        body = await response.json();
    } catch {
        body = undefined;
    }
    const error =
        typeof body === "object" &&
        body !== null &&
        "error" in body &&
        typeof body.error === "object" &&
        body.error !== null
            ? body.error
            : { message: "Upstream request failed" };
    return { error: { ...error, status: response.status } };
}

/**
 * For early keepalive on a non-streaming call, where a 200 JSON status is
 * already committed: the error goes into the JSON body.
 */
export async function toOpenAIJsonError(response: Response): Promise<Response> {
    if (response.ok) return response;
    return Response.json(await committedError(response));
}

/**
 * For early keepalive, where the 200 SSE status is already committed:
 * turns an error response into an OpenAI in-stream error event followed by
 * `[DONE]`, so OpenAI SDKs surface it as an API error.
 */
export async function toOpenAIStreamError(
    response: Response
): Promise<Response> {
    if (response.ok) return response;
    return new Response(
        `data: ${JSON.stringify(await committedError(response))}\n\ndata: [DONE]\n\n`,
        {
            status: 200,
            headers: {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
            },
        }
    );
}
