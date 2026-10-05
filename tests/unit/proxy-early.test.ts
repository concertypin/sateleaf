import { Hono } from "hono";
import { once } from "node:events";
import {
    get,
    request,
    type IncomingMessage,
    type ServerResponse,
} from "node:http";
import { serve } from "@hono/node-server";
import type { HttpBindings } from "@hono/node-server";
import { afterEach, assert, beforeEach, test, vi } from "vitest";
import { createProxyHandler } from "@/proxy/index.js";
import { transformGemini } from "@/transform/index.js";
import type * as Transform from "@/transform/index.js";

vi.mock("@/transform/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof Transform>()),
    transformGemini: vi.fn<typeof transformGemini>(),
}));

const path =
    "/proxy/test-secret/earlykeepalive/example.com/v1/models/model:streamGenerateContent?alt=sse";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}
function app() {
    return new Hono().all("/*", createProxyHandler());
}

beforeEach(() => {
    vi.stubEnv("PROXY_SECRET", "test-secret");
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.mocked(transformGemini).mockReset();
});

test("returns an initial heartbeat while PDF transformation is pending", async () => {
    const transformed = deferred<Awaited<ReturnType<typeof transformGemini>>>();
    vi.mocked(transformGemini).mockReturnValue(transformed.promise);
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(
            new Response("data: done\n\n", {
                headers: { "content-type": "text/event-stream" },
            })
        )
    );
    vi.stubGlobal("fetch", fetch);
    const response = await app().request(path, {
        method: "POST",
        body: '{"contents":[]}',
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.equal(
        decoder.decode((await reader.read()).value),
        ": keepalive\n\n"
    );
    assert.equal(fetch.mock.calls.length, 0);
    transformed.resolve({ contents: [] });
    assert.equal(decoder.decode((await reader.read()).value), "data: done\n\n");
    assert.isTrue((await reader.read()).done);
});

test("returns an initial heartbeat before upstream headers and logs only upstream bytes", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise)
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await app().request(path);
    const reader = response.body!.getReader();
    assert.equal(
        decoder.decode((await reader.read()).value),
        ": keepalive\n\n"
    );
    assert.isFalse(
        info.mock.calls.some(([message]) =>
            String(message).includes("proxy_first_upstream_byte")
        )
    );
    pending.resolve(
        new Response("data: first\n\n", {
            headers: { "content-type": "text/event-stream" },
        })
    );
    assert.equal(
        decoder.decode((await reader.read()).value),
        "data: first\n\n"
    );
    assert.isTrue((await reader.read()).done);
    assert.equal(
        info.mock.calls.filter(([message]) =>
            String(message).includes("proxy_first_upstream_byte")
        ).length,
        1
    );
});

test.each([
    ["/proxy/wrong/earlykeepalive/example.com/events?alt=sse", "GET", 401],
    ["/proxy/test-secret/unknown/example.com/events?alt=sse", "GET", 400],
    ["/proxy/test-secret/earlykeepalive/example.com/events", "GET", 400],
    [path, "HEAD", 400],
])(
    "rejects invalid early requests before fetch: %s %s",
    async (url, method, status) => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        vi.stubGlobal("fetch", fetch);
        assert.equal((await app().request(url, { method })).status, status);
        assert.equal(fetch.mock.calls.length, 0);
    }
);

test.each([
    ["{", undefined, 400],
    ["too large", "2", 413],
])(
    "reports body errors through SSE after committing 200",
    async (body, limit, status) => {
        if (limit) vi.stubEnv("MAX_REQUEST_BYTES", limit);
        const fetch = vi.fn<typeof globalThis.fetch>();
        vi.stubGlobal("fetch", fetch);
        const response = await app().request(path, { method: "POST", body });
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.include(text, "event: error\n");
        assert.include(text, String(status));
        assert.equal(fetch.mock.calls.length, 0);
    }
);

test("preserves Gemini error details after committing an early HTTP 200", async () => {
    const upstreamBody = {
        error: {
            code: 429,
            message: "Quota exceeded",
            status: "RESOURCE_EXHAUSTED",
            details: [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "10s",
                },
            ],
        },
    };
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve(Response.json(upstreamBody, { status: 429 }))
        )
    );
    const response = await app().request(path);
    assert.equal(response.status, 200);
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    assert.isDefined(data);
    const payload: unknown = JSON.parse(data.slice(6));
    assert.deepEqual(payload, {
        error: {
            code: "UPSTREAM_HTTP_ERROR",
            message: "Upstream returned an error",
            status: 429,
        },
        upstreamBody,
        contentType: "application/json",
    });
});

test("does not expose local fetch exception details in the preserved error body", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("secret-provider-key")))
    );
    const response = await app().request(path);
    const text = await response.text();
    assert.include(text, "event: error\n");
    assert.include(text, "Upstream request failed");
    assert.notInclude(text, "secret-provider-key");
});

test("nokeepalive leaves an idle SSE body untouched across heartbeat intervals", async () => {
    vi.useFakeTimers();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(value) {
                            controller = value;
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } }
                )
            )
        )
    );
    const response = await app().request(
        "/proxy/test-secret/nokeepalive/example.com/events"
    );
    const reader = response.body!.getReader();
    let settled = false;
    const read = reader.read().then((value) => {
        settled = true;
        return value;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    assert.isFalse(settled);
    controller.enqueue(encoder.encode("data: actual\n\n"));
    assert.equal(decoder.decode((await read).value), "data: actual\n\n");
    controller.close();
    assert.isTrue((await reader.read()).done);
});

test("cancelling the early response aborts fetch while headers are pending", async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal(
        "fetch",
        vi.fn(
            (_url: URL, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    const signal = init.signal!;
                    started.resolve(signal);
                    signal.addEventListener(
                        "abort",
                        () => reject(new Error("Fetch aborted")),
                        { once: true }
                    );
                })
        )
    );
    const response = await app().request(
        new Request(`http://localhost${path}`)
    );
    const signal = await started.promise;
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    assert.isTrue(signal.aborted);
});

test("cancelling the early response cancels a pending request body read", async () => {
    const reading = deferred<void>();
    const cancelled = vi.fn<(reason: unknown) => void>();
    const original = new AbortController();
    const body = new ReadableStream<Uint8Array>({
        pull() {
            reading.resolve();
        },
        cancel: cancelled,
    });
    const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        body,
        duplex: "half",
        signal: original.signal,
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const response = await app().request(
        new Request(`http://localhost${path}`, init)
    );
    await reading.promise;
    await vi.waitFor(() => assert.isTrue(body.locked));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => assert.equal(cancelled.mock.calls.length, 1));
    assert.isFalse(original.signal.aborted);
    assert.equal(fetch.mock.calls.length, 0);
});

test("cancelling during PDF transformation prevents fetch after transformation resolves", async () => {
    const transformed = deferred<Awaited<ReturnType<typeof transformGemini>>>();
    const transforming = deferred<void>();
    vi.mocked(transformGemini).mockImplementation(() => {
        transforming.resolve();
        return transformed.promise;
    });
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const response = await app().request(path, {
        method: "POST",
        body: '{"contents":[]}',
    });
    await transforming.promise;
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    transformed.resolve({ contents: [] });
    await vi.waitFor(() =>
        assert.isTrue(
            info.mock.calls.some(([message]) =>
                String(message).includes("proxy_interrupted")
            )
        )
    );
    assert.equal(fetch.mock.calls.length, 0);
});

test("publishes HTTP headers and heartbeat before upstream headers resolve", async () => {
    const pending = deferred<Response>();
    vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise)
    );
    const server = serve({
        fetch: app().fetch,
        hostname: "127.0.0.1",
        port: 0,
        overrideGlobalObjects: false,
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected TCP address");
    const client = get(`http://127.0.0.1:${address.port}${path}`);
    try {
        const response = await new Promise<IncomingMessage>(
            (resolve, reject) => {
                client.once("response", resolve);
                client.once("error", reject);
            }
        );
        assert.equal(response.statusCode, 200);
        assert.include(
            String(response.headers["content-type"]),
            "text/event-stream"
        );
        const first = await new Promise<Buffer>((resolve, reject) => {
            response.once("data", resolve);
            response.once("error", reject);
        });
        assert.equal(first.toString(), ": keepalive\n\n");
        const ended = once(response, "end");
        pending.resolve(
            new Response("data: done\n\n", {
                headers: { "content-type": "text/event-stream" },
            })
        );
        response.resume();
        await ended;
        assert.match(
            response.trailers["server-timing"] ?? "",
            /first_upstream_byte;dur=\d+\.\d{2}/
        );
    } finally {
        client.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
    }
});

test("writes HTTP headers and heartbeat before synchronous PDF preparation begins", async () => {
    let outgoing: ServerResponse | undefined;
    let headersSentAtTransform = false;
    let bytesWrittenAtTransform = 0;
    vi.mocked(transformGemini).mockImplementation(() => {
        headersSentAtTransform = outgoing?.headersSent ?? false;
        bytesWrittenAtTransform = outgoing?.socket?.bytesWritten ?? 0;
        const until = performance.now() + 20;
        while (performance.now() < until) {
            /* Simulate synchronous PDF work. */
        }
        return Promise.resolve({ contents: [] });
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve(
                new Response("data: done\n\n", {
                    headers: { "content-type": "text/event-stream" },
                })
            )
        )
    );
    const handler = createProxyHandler();
    const application = new Hono<{ Bindings: HttpBindings }>().all(
        "/*",
        (context, next) => {
            outgoing = context.env.outgoing;
            return handler(context, next) as Response | Promise<Response>;
        }
    );
    const server = serve({
        fetch: application.fetch,
        hostname: "127.0.0.1",
        port: 0,
        overrideGlobalObjects: false,
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected TCP address");
    const client = request(`http://127.0.0.1:${address.port}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
    });
    try {
        const received = new Promise<IncomingMessage>((resolve, reject) => {
            client.once("response", resolve);
            client.once("error", reject);
        });
        client.end('{"contents":[]}');
        const response = await received;
        let body = "";
        response.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        await once(response, "end");
        assert.equal(response.statusCode, 200);
        assert.isTrue(headersSentAtTransform);
        assert.isAbove(bytesWrittenAtTransform, 0);
        assert.equal(body, ": keepalive\n\ndata: done\n\n");
    } finally {
        client.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
    }
});
