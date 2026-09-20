import { isGeminiGenerate, transformGemini } from "@/transform/index.js";
import type { ProxyRoute } from "./route.js";

export class RequestTooLargeError extends Error {}
export class InvalidRequestError extends Error {}

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

    const bytes = await readBodyWithLimit(request, maxTransformBytes);
    if (method !== "POST" || !isGeminiGenerate(route.upstream.pathname))
        return { body: bytes, transformed: false };

    try {
        const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
        const output = await transformGemini(
            input,
            route.mode,
            route.fontSize,
            route.cachePdf
        );
        return { body: JSON.stringify(output), transformed: true };
    } catch (error) {
        throw new InvalidRequestError(
            error instanceof Error ? error.message : "Invalid request body"
        );
    }
}

async function readBodyWithLimit(
    request: Request,
    maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes)
        throw new RequestTooLargeError("Request too large");
    if (!request.body) return new Uint8Array();

    const reader = request.body.getReader();
    const chunks: Uint8Array<ArrayBufferLike>[] = [];
    let totalBytes = 0;
    while (true) {
        const result = await reader.read();
        if (result.done) break;
        totalBytes += result.value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new RequestTooLargeError("Request too large");
        }
        chunks.push(result.value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}
