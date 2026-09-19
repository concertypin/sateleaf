import { isGeminiGenerate, transformGemini } from "@/transform/index.js";
import type { ProxyRoute } from "./route.js";

export class RequestTooLargeError extends Error {}

/**
 * Reads and, when necessary, transforms the request body for its upstream API.
 * Native Gemini JSON payloads become PDF-backed payloads; all other bodies pass
 * through unchanged.
 */
export interface UpstreamBody {
    body: BodyInit | null;
    transformed: boolean;
}

export async function createUpstreamBody(
    request: Request,
    route: ProxyRoute,
    maxTransformBytes: number
): Promise<UpstreamBody> {
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD")
        return { body: null, transformed: false };

    if (method !== "POST" || !isGeminiGenerate(route.upstream.pathname))
        return { body: await request.arrayBuffer(), transformed: false };

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length > maxTransformBytes)
        throw new RequestTooLargeError("Request too large");

    const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const output = await transformGemini(
        input,
        route.mode,
        route.fontSize,
        route.cachePdf
    );
    return { body: JSON.stringify(output), transformed: true };
}
