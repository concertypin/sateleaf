import { createMiddleware } from "hono/factory";

/**
 * Copies the caller's CORS preflight metadata onto a response.
 * The proxy intentionally reflects origins and requested headers because access
 * control is enforced by the secret embedded in the proxy URL.
 */
export function applyCorsHeaders(response: Headers, request: Headers): void {
    const origin = request.get("origin");
    if (!origin) return;

    response.set("access-control-allow-origin", origin);
    response.set("access-control-allow-credentials", "true");

    const method = request.get("access-control-request-method");
    if (method) response.set("access-control-allow-methods", method);

    const requestedHeaders = request.get("access-control-request-headers");
    if (requestedHeaders) {
        response.set("access-control-allow-headers", requestedHeaders);
        response.set("access-control-expose-headers", requestedHeaders);
    }
    response.append(
        "vary",
        "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    );
}

/** Applies the proxy's reflected CORS policy to every Hono response. */
export const corsMiddleware = createMiddleware(async (context, next) => {
    await next();
    applyCorsHeaders(context.res.headers, context.req.raw.headers);
});
