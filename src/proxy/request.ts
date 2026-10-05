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
    transformMs?: number;
}

export async function createUpstreamBody(
    request: Request,
    route: ProxyRoute,
    maxTransformBytes: number,
    signal: AbortSignal = request.signal
): Promise<UpstreamBody> {
    signal.throwIfAborted();
    const method = request.method.toUpperCase();
    if (method === "GET" || method === "HEAD")
        return { body: null, transformed: false };

    const bytes = await readBodyWithLimit(request, maxTransformBytes, signal);
    signal.throwIfAborted();
    if (method !== "POST" || !isGeminiGenerate(route.upstream.pathname))
        return { body: bytes, transformed: false };

    try {
        const input: unknown = JSON.parse(new TextDecoder().decode(bytes));
        signal.throwIfAborted();
        const transformStarted = performance.now();
        const output = await transformGemini(
            input,
            route.mode,
            route.fontSize,
            route.cachePdf
        );
        signal.throwIfAborted();
        return {
            body: JSON.stringify(output),
            transformed: true,
            transformMs: performance.now() - transformStarted,
        };
    } catch (error) {
        signal.throwIfAborted();
        throw new InvalidRequestError(
            error instanceof Error ? error.message : "Invalid request body"
        );
    }
}

async function readBodyWithLimit(
    request: Request,
    maxBytes: number,
    signal: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes)
        throw new RequestTooLargeError("Request too large");
    if (!request.body) return new Uint8Array();

    const reader = request.body.getReader();
    const onAbort = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const chunks: Uint8Array<ArrayBufferLike>[] = [];
    let totalBytes = 0;
    try {
        signal.throwIfAborted();
        while (true) {
            const result = await reader.read();
            signal.throwIfAborted();
            if (result.done) break;
            totalBytes += result.value.byteLength;
            if (totalBytes > maxBytes) {
                await reader.cancel();
                throw new RequestTooLargeError("Request too large");
            }
            chunks.push(result.value);
        }
    } catch (error) {
        signal.throwIfAborted();
        throw error;
    } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}
