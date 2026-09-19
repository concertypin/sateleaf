import type { Handler } from "hono";
import { createUpstreamBody, RequestTooLargeError } from "./request.js";
import { hasValidProxySecret, parseProxyRoute } from "./route.js";

const DEFAULT_MAX_REQUEST_BYTES = 26_214_400;

/** Creates the catch-all handler that validates and forwards proxy requests. */
export function createProxyHandler(): Handler {
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
        const headers = createUpstreamHeaders(context.req.raw.headers);
        try {
            const maxBytes = Number(
                process.env.MAX_REQUEST_BYTES ?? DEFAULT_MAX_REQUEST_BYTES
            );
            const upstreamBody = await createUpstreamBody(
                context.req.raw,
                route,
                maxBytes
            );
            if (upstreamBody.transformed)
                headers.set("content-type", "application/json");

            const response = await fetch(route.upstream, {
                method: context.req.method,
                headers,
                body: upstreamBody.body,
                redirect: "manual",
                signal: context.req.raw.signal,
            });
            return createProxyResponse(response);
        } catch (error) {
            if (error instanceof RequestTooLargeError)
                return errorResponse(413, error.message);
            console.error(error);
            return errorResponse(
                502,
                error instanceof Error
                    ? error.message
                    : "Upstream request failed"
            );
        }
    };
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

/**
 * Relays the upstream body as-is, including SSE streams. Only representation
 * headers invalidated by Fetch decompression or re-streaming are removed.
 */
function createProxyResponse(upstream: Response): Response {
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    });
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
