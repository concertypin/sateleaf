import { setImmediate } from "node:timers/promises";

const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

type StreamTiming = {
    firstByteMs: number | null;
    streamMs: number;
    completed: boolean;
};

type RelayOptions = {
    keepalive?: boolean;
    onFirstByte?: ((ms: number) => void) | undefined;
    immediateKeepalive?: boolean;
};

/** Relays bytes with bounded buffering and propagates downstream cancellation. */
export function createKeepaliveResponse(
    upstream: Response,
    abortController: AbortController,
    intervalMs = 15_000,
    onFinish?: (timing: StreamTiming) => void,
    options: RelayOptions = {}
): Response {
    const headers = new Headers(upstream.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const init = {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
    };
    if (!upstream.body) {
        onFinish?.({ firstByteMs: null, streamMs: 0, completed: true });
        return new Response(null, init);
    }

    const isSse =
        headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
        "text/event-stream";
    return new Response(
        createRelay(
            upstream.body.getReader(),
            abortController,
            intervalMs,
            onFinish,
            {
                ...options,
                keepalive: isSse && options.keepalive !== false,
                immediateKeepalive:
                    isSse &&
                    options.keepalive !== false &&
                    options.immediateKeepalive === true,
            }
        ),
        init
    );
}

/** Commits SSE headers before preparing or fetching the upstream response. */
export function createEarlyKeepaliveResponse(
    load: (signal: AbortSignal) => Promise<Response>,
    abortController: AbortController,
    intervalMs = 15_000,
    onFinish?: (timing: StreamTiming) => void,
    onFirstByte?: (ms: number) => void
): Response {
    // Give the Node adapter an I/O turn to flush the initial comment before CPU work.
    const reader = setImmediate(undefined, { signal: abortController.signal })
        .catch(() => {})
        .then(async () => {
            if (abortController.signal.aborted) return null;
            let upstream: Response;
            try {
                upstream = await load(abortController.signal);
            } catch {
                if (abortController.signal.aborted) return null;
                return errorReader(
                    "UPSTREAM_REQUEST_FAILED",
                    "Upstream request failed"
                );
            }
            if (abortController.signal.aborted) {
                await upstream.body
                    ?.cancel(abortController.signal.reason)
                    .catch(() => {});
                return null;
            }
            const isSse =
                upstream.headers
                    .get("content-type")
                    ?.split(";", 1)[0]
                    ?.trim()
                    .toLowerCase() === "text/event-stream";
            if (!upstream.ok) {
                const metadata = await readErrorBody(
                    upstream,
                    abortController.signal
                );
                if (abortController.signal.aborted) return null;
                return errorReader(
                    "UPSTREAM_HTTP_ERROR",
                    "Upstream returned an error",
                    upstream.status,
                    metadata
                );
            }
            if (!isSse) {
                await upstream.body?.cancel().catch(() => {});
                return errorReader(
                    "UPSTREAM_NOT_SSE",
                    "Upstream did not return an SSE response",
                    upstream.status
                );
            }
            return upstream.body?.getReader() ?? null;
        });
    return new Response(
        createRelay(reader, abortController, intervalMs, onFinish, {
            immediateKeepalive: true,
            onFirstByte,
        }),
        {
            headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
            },
        }
    );
}

const syntheticReaders = new WeakSet<ReadableStreamDefaultReader<Uint8Array>>();

type ErrorBodyMetadata = {
    upstreamBody: unknown;
    contentType: string | null;
    bodyTruncated?: boolean;
    bodyReadFailed?: boolean;
};

/** Read diagnostics only, with a fixed retained-byte budget and abortable reader. */
async function readErrorBody(
    upstream: Response,
    signal: AbortSignal
): Promise<ErrorBodyMetadata> {
    const metadata: ErrorBodyMetadata = {
        upstreamBody: "",
        contentType: upstream.headers.get("content-type"),
    };
    if (!upstream.body) return metadata;
    const reader = upstream.body.getReader();
    const limit = 1024 * 1024;
    const bytes = new Uint8Array(limit);
    let size = 0;
    const onAbort = () => {
        void reader.cancel(signal.reason).catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
        while (!signal.aborted) {
            const result = await reader.read();
            if (result.done || signal.aborted) break;
            const retained = Math.min(result.value.byteLength, limit - size);
            bytes.set(result.value.subarray(0, retained), size);
            size += retained;
            if (retained < result.value.byteLength) {
                metadata.bodyTruncated = true;
                void reader.cancel("Error body limit exceeded").catch(() => {});
                break;
            }
        }
    } catch {
        if (!signal.aborted) {
            metadata.bodyReadFailed = true;
            metadata.bodyTruncated = true;
            void reader.cancel().catch(() => {});
        }
    } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
    }
    const text = new TextDecoder().decode(bytes.subarray(0, size));
    metadata.upstreamBody = text;
    if (!metadata.bodyTruncated && text.length > 0) {
        try {
            metadata.upstreamBody = JSON.parse(text) as unknown;
        } catch {
            /* Preserve the original non-JSON text. */
        }
    }
    return metadata;
}

function errorReader(
    code: string,
    message: string,
    status?: number,
    metadata?: ErrorBodyMetadata
) {
    const reader = new Response(
        `event: error\ndata: ${JSON.stringify({ error: { code, message, ...(status === undefined ? {} : { status }) }, ...metadata })}\n\n`
    ).body!.getReader();
    syntheticReaders.add(reader);
    return reader;
}

function createRelay(
    source:
        | ReadableStreamDefaultReader<Uint8Array>
        | Promise<ReadableStreamDefaultReader<Uint8Array> | null>,
    abortController: AbortController,
    intervalMs: number,
    onFinish: ((timing: StreamTiming) => void) | undefined,
    options: RelayOptions
): ReadableStream<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null =
        source instanceof Promise ? null : source;
    const ready = Promise.resolve(source).then(async (resolved) => {
        reader = resolved;
        if (stopped)
            await reader?.cancel(abortController.signal.reason).catch(() => {});
        return reader;
    });
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lineHasBytes = false;
    let previousCr = false;
    let betweenEvents = true;
    const startedAt = performance.now();
    let firstByte = true;
    let firstByteMs: number | null = null;
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    const cleanup = (completed = false) => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        abortController.signal.removeEventListener("abort", onAbort);
        onFinish?.({
            firstByteMs,
            streamMs: performance.now() - startedAt,
            completed,
        });
    };
    const onAbort = () => {
        if (stopped) return;
        cleanup();
        streamController.error(abortController.signal.reason);
        void reader?.cancel(abortController.signal.reason).catch(() => {});
    };
    const trackBoundary = (chunk: Uint8Array) => {
        for (const byte of chunk) {
            if (byte === 10 && previousCr) {
                previousCr = false;
                continue;
            }
            previousCr = byte === 13;
            if (byte === 10 || byte === 13) {
                betweenEvents = !lineHasBytes;
                lineHasBytes = false;
            } else {
                lineHasBytes = true;
                betweenEvents = false;
            }
        }
    };
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            streamController = controller;
            abortController.signal.addEventListener("abort", onAbort, {
                once: true,
            });
            if (abortController.signal.aborted) {
                onAbort();
                return;
            }
            if (options.immediateKeepalive) controller.enqueue(KEEPALIVE);
            if (options.keepalive !== false)
                timer = setInterval(() => {
                    // Never split an event or a CRLF, or accumulate idle comments.
                    if (
                        !stopped &&
                        betweenEvents &&
                        !previousCr &&
                        (controller.desiredSize ?? 0) > 0
                    )
                        controller.enqueue(KEEPALIVE);
                }, intervalMs);
        },
        async pull(controller) {
            try {
                const currentReader = await ready;
                if (stopped) return;
                const result = currentReader
                    ? await currentReader.read()
                    : { done: true as const, value: undefined };
                if (stopped) return;
                if (result.done) {
                    cleanup(true);
                    controller.close();
                    currentReader?.releaseLock();
                } else {
                    if (
                        firstByte &&
                        result.value.byteLength > 0 &&
                        currentReader &&
                        !syntheticReaders.has(currentReader)
                    ) {
                        firstByte = false;
                        firstByteMs = performance.now() - startedAt;
                        options.onFirstByte?.(firstByteMs);
                        if (!options.onFirstByte)
                            console.info("proxy_first_byte", {
                                upstreamBodyWaitMs: Math.round(firstByteMs),
                            });
                    }
                    if (options.keepalive !== false)
                        trackBoundary(result.value);
                    controller.enqueue(result.value);
                }
            } catch (error) {
                if (stopped) return;
                cleanup();
                controller.error(error);
                void reader?.cancel(error).catch(() => {});
            }
        },
        async cancel(reason) {
            cleanup();
            abortController.abort(reason);
            await reader?.cancel(reason);
        },
    });
    return body;
}
