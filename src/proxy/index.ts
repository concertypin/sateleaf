import type { Handler } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { InvalidRequestError as LibraryRequestError } from "ai-compatibles";
import { UnsupportedFeatureError } from "ai-compatibles";
import { fetchGeminiWithContinuation } from "ai-compatibles/adapters/gemini-generate-content";
import { isGeminiGenerate } from "@/transform/index.js";
import {
    createOpenAIUpstreamBody,
    decodeOpenAIChat,
    openAIChatBasePath,
    openAIErrorResponse,
    openAIProxyError,
    toGeminiHeaders,
    toOpenAIJsonError,
    toOpenAIResponse,
    toOpenAIStreamError,
    type OpenAIChatCall,
} from "./openai.js";
import {
    createUpstreamBody,
    InvalidRequestError,
    readBodyWithLimit,
    RequestTooLargeError,
    type UpstreamBody,
} from "./request.js";
import {
    hasValidProxySecret,
    isGemini4OrLater,
    nativeModel,
    parseProxyRoute,
} from "./route.js";
import {
    createEarlyJsonResponse,
    createEarlyKeepaliveResponse,
    createKeepaliveResponse,
} from "./stream.js";

const DEFAULT_MAX_REQUEST_BYTES = 26_214_400;

/** Creates the catch-all handler that validates and forwards proxy requests. */
export function createProxyHandler(): Handler {
    const maxRequestBytes = configuredMaxRequestBytes();
    return async (context) => {
        if (context.req.method.toUpperCase() === "OPTIONS")
            return new Response(null, { status: 204 });
        if (!context.req.path.startsWith("/proxy/"))
            return errorResponse(404, "Not found");
        if (!hasValidProxySecret(context.req.path, process.env.PROXY_SECRET))
            return errorResponse(401, "Invalid proxy secret");

        let route;
        try {
            route = parseProxyRoute(context.req.path);
        } catch (error) {
            return errorResponse(
                400,
                error instanceof Error ? error.message : "Invalid proxy route"
            );
        }

        route.upstream.search = new URL(context.req.url).search;

        // OpenAI-compatible chat: decode up front so request errors get a
        // real status before any (early keepalive) headers are committed.
        const openAIBase = openAIChatBasePath(route.upstream.pathname);
        const fail = openAIBase === null ? errorResponse : openAIProxyError;
        let openAICall: OpenAIChatCall | undefined;
        if (openAIBase !== null) {
            if (context.req.method.toUpperCase() !== "POST")
                return openAIProxyError(405, "Chat completions require POST");
            try {
                const bytes = await readBodyWithLimit(
                    context.req.raw,
                    maxRequestBytes,
                    context.req.raw.signal
                );
                openAICall = decodeOpenAIChat(bytes, route, openAIBase);
            } catch (error) {
                if (context.req.raw.signal.aborted)
                    return openAIProxyError(499, "Client disconnected");
                if (error instanceof RequestTooLargeError)
                    return openAIProxyError(413, error.message);
                return openAIErrorResponse(error);
            }
        }

        const model =
            openAICall?.canonical.model ??
            (isGeminiGenerate(route.upstream.pathname)
                ? nativeModel(route.upstream.pathname)
                : undefined);
        if (
            model !== undefined &&
            !route.allowGemini4 &&
            isGemini4OrLater(model)
        )
            return fail(
                400,
                `${model} is Gemini 4 or later, where PDF folding no longer saves tokens; add the allowgemini4 setting to proxy it anyway`
            );

        // OpenAI calls without `stream` get JSON-whitespace keepalives instead.
        if (
            route.earlyKeepalive &&
            !openAICall &&
            !isSseRequest(context.req.raw, route.upstream)
        )
            return fail(
                400,
                "earlykeepalive requires an SSE request (alt=sse or Accept: text/event-stream), excluding HEAD"
            );
        const headers = openAICall
            ? toGeminiHeaders(
                  createUpstreamHeaders(context.req.raw.headers),
                  openAICall.upstream
              )
            : createUpstreamHeaders(context.req.raw.headers);
        const abortController = new AbortController();
        const requestSignal = context.req.raw.signal;
        const abort = () => abortController.abort(requestSignal.reason);
        requestSignal.addEventListener("abort", abort, { once: true });
        if (requestSignal.aborted) abort();
        const started = performance.now();
        let phase = "preparation";
        let phaseStarted = started;
        let receivedAt: number | undefined;
        let serverTiming = "";
        let requestToFirstByteMs: number | undefined;
        let upstreamBodyWaitMs: number | undefined;
        const outgoing = (context.env as Partial<HttpBindings> | undefined)
            ?.outgoing;
        let trailersEnabled = route.earlyKeepalive && !!outgoing;
        const onFirstByte = () => {
            const now = performance.now();
            requestToFirstByteMs = now - started;
            upstreamBodyWaitMs =
                receivedAt === undefined ? undefined : now - receivedAt;
            console.info(
                JSON.stringify({
                    event: "proxy_first_upstream_byte",
                    requestToFirstByteMs: Math.round(requestToFirstByteMs),
                    upstreamBodyWaitMs:
                        upstreamBodyWaitMs === undefined
                            ? undefined
                            : Math.round(upstreamBodyWaitMs),
                })
            );
        };
        const finish = (timing: { streamMs: number; completed: boolean }) => {
            requestSignal.removeEventListener("abort", abort);
            if (
                !trailersEnabled ||
                !outgoing ||
                !timing.completed ||
                outgoing.destroyed ||
                outgoing.writableEnded ||
                context.req.method === "HEAD"
            )
                return;
            outgoing.addTrailers({
                "Server-Timing": `${route.earlyKeepalive && serverTiming ? `${serverTiming}, ` : ""}stream;dur=${timing.streamMs.toFixed(2)}${upstreamBodyWaitMs === undefined ? "" : `, upstream_body_wait;dur=${upstreamBodyWaitMs.toFixed(2)}`}${requestToFirstByteMs === undefined ? "" : `, first_upstream_byte;dur=${requestToFirstByteMs.toFixed(2)}`}`,
            });
        };
        const load = async (): Promise<Response> => {
            try {
                abortController.signal.throwIfAborted();
                const nativeBody = openAICall
                    ? await createOpenAIUpstreamBody(openAICall, route)
                    : undefined;
                const upstreamBody: UpstreamBody = nativeBody
                    ? { ...nativeBody, transformed: true }
                    : await createUpstreamBody(
                          context.req.raw,
                          route,
                          maxRequestBytes,
                          abortController.signal
                      );
                abortController.signal.throwIfAborted();
                const prepared = performance.now();
                phase = "upstream_headers";
                phaseStarted = prepared;
                if (upstreamBody.transformed)
                    headers.set("content-type", "application/json");

                // OpenAI clients cannot follow Gemini long decode, so the
                // proxy continues CONTINUATION hops itself; native Gemini
                // clients get each hop as-is and continue on their own.
                const fetched =
                    openAICall && nativeBody
                        ? await fetchGeminiWithContinuation({
                              url: openAICall.upstream,
                              body: nativeBody.body,
                              headers,
                              redirect: "manual",
                              signal: abortController.signal,
                          })
                        : await fetch(route.upstream, {
                              method: context.req.method,
                              headers,
                              body: upstreamBody.body,
                              redirect: "manual",
                              signal: abortController.signal,
                          });
                const upstreamResponse = openAICall
                    ? await toOpenAIResponse(fetched, openAICall)
                    : fetched;
                const received = performance.now();
                receivedAt = received;
                const response = new Response(upstreamResponse.body, {
                    status: upstreamResponse.status,
                    statusText: upstreamResponse.statusText,
                    // The Node adapter retains Headers instances, including fetch's immutable guard.
                    headers: new Headers(upstreamResponse.headers),
                });
                serverTiming = `prepare;dur=${(prepared - started).toFixed(2)}, upstream_headers;dur=${(received - prepared).toFixed(2)}${upstreamBody.transformMs === undefined ? "" : `, transform;dur=${upstreamBody.transformMs.toFixed(2)}`}`;
                response.headers.append("server-timing", serverTiming);
                const hasTrailers =
                    !!outgoing &&
                    !!response.body &&
                    context.req.method !== "HEAD";
                trailersEnabled = route.earlyKeepalive
                    ? !!outgoing
                    : hasTrailers;
                if (hasTrailers) {
                    response.headers.set("trailer", "Server-Timing");
                    // Prevent the Node adapter from inferring fixed-length framing.
                    if (outgoing && !("stream" in outgoing))
                        response.headers.set("transfer-encoding", "chunked");
                }
                console.info(
                    JSON.stringify({
                        event: "proxy_timing",
                        preparationMs: Math.round(prepared - started),
                        upstreamHeadersMs: Math.round(received - prepared),
                        status: response.status,
                    })
                );
                return response;
            } catch (error) {
                requestSignal.removeEventListener("abort", abort);
                console.info(
                    JSON.stringify({
                        event: "proxy_interrupted",
                        phase,
                        phaseMs: Math.round(performance.now() - phaseStarted),
                        aborted: abortController.signal.aborted,
                    })
                );
                if (abortController.signal.aborted)
                    return fail(499, "Client disconnected");
                if (error instanceof RequestTooLargeError)
                    return fail(413, error.message);
                if (error instanceof InvalidRequestError)
                    return fail(400, error.message);
                if (
                    openAICall &&
                    (error instanceof LibraryRequestError ||
                        error instanceof UnsupportedFeatureError)
                )
                    return openAIErrorResponse(error);
                console.error(error);
                return fail(
                    502,
                    !route.earlyKeepalive && error instanceof Error
                        ? error.message
                        : "Upstream request failed"
                );
            }
        };
        if (route.earlyKeepalive && openAICall && !openAICall.stream) {
            const response = createEarlyJsonResponse(
                async () => toOpenAIJsonError(await load()),
                abortController,
                15_000,
                finish
            );
            if (outgoing) response.headers.set("trailer", "Server-Timing");
            if (outgoing && !("stream" in outgoing))
                response.headers.set("transfer-encoding", "chunked");
            return response;
        }
        if (route.earlyKeepalive) {
            const response = createEarlyKeepaliveResponse(
                openAICall
                    ? async () => toOpenAIStreamError(await load())
                    : load,
                abortController,
                15_000,
                finish,
                onFirstByte
            );
            if (outgoing) response.headers.set("trailer", "Server-Timing");
            if (outgoing && !("stream" in outgoing))
                response.headers.set("transfer-encoding", "chunked");
            return response;
        }
        const response = await load();
        if (receivedAt === undefined) {
            requestSignal.removeEventListener("abort", abort);
            return response;
        }
        return createKeepaliveResponse(
            response,
            abortController,
            15_000,
            finish,
            {
                keepalive: route.keepalive,
                onFirstByte,
                immediateKeepalive: route.keepalive,
            }
        );
    };
}

function isSseRequest(request: Request, upstream: URL): boolean {
    if (request.method.toUpperCase() === "HEAD") return false;
    if (upstream.searchParams.get("alt") === "sse") return true;
    return (
        request.headers
            .get("accept")
            ?.split(",")
            .some(
                (entry) =>
                    entry.split(";", 1)[0]?.trim().toLowerCase() ===
                    "text/event-stream"
            ) ?? false
    );
}

function configuredMaxRequestBytes(): number {
    const raw = process.env.MAX_REQUEST_BYTES;
    if (raw === undefined) return DEFAULT_MAX_REQUEST_BYTES;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error("MAX_REQUEST_BYTES must be a positive integer");
    return value;
}

function createUpstreamHeaders(source: Headers): Headers {
    const headers = new Headers(source);
    for (const name of [
        "host",
        "content-length",
        "connection",
        "transfer-encoding",
    ])
        headers.delete(name);
    return headers;
}

function errorResponse(status: number, message: string): Response {
    return Response.json(
        { error: message },
        {
            status,
            headers: { "content-type": "application/json; charset=utf-8" },
        }
    );
}
