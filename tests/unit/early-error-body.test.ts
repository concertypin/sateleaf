import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { createEarlyKeepaliveResponse } from "@/proxy/stream.js";

type ErrorPayload = {
    error: { code: string; message: string; status: number };
    upstreamBody: unknown;
    contentType: string | null;
    bodyTruncated?: boolean;
    bodyReadFailed?: boolean;
};
function parseError(text: string): ErrorPayload {
    const line = text.split("\n").find((value) => value.startsWith("data: "));
    return JSON.parse(line!.slice(6)) as ErrorPayload;
}
function relay(upstream: Response) {
    return createEarlyKeepaliveResponse(
        () => Promise.resolve(upstream),
        new AbortController()
    );
}

test.concurrent("preserves Gemini JSON error details and retryInfo without forwarding response headers", async () => {
    const body = {
        error: {
            code: 429,
            status: "RESOURCE_EXHAUSTED",
            message: "Quota exceeded",
            details: [
                {
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    retryDelay: "42s",
                },
                {
                    reason: "RATE_LIMIT_EXCEEDED",
                    metadata: { quotaMetric: "generate_content" },
                },
            ],
        },
    };
    const response = relay(
        new Response(JSON.stringify(body), {
            status: 429,
            headers: {
                "content-type": "application/json; charset=utf-8",
                "x-upstream-secret": "credential",
            },
        })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-secret")).toBeNull();
    const payload = parseError(await response.text());
    expect(payload.error).toMatchObject({
        code: "UPSTREAM_HTTP_ERROR",
        status: 429,
    });
    expect(payload).toMatchObject({
        upstreamBody: body,
        contentType: "application/json; charset=utf-8",
    });
});

test.concurrent("preserves multiline non-JSON text safely in a single SSE data line", async () => {
    const text = "Service overloaded\r\nPlease retry later\n한글";
    const result = await relay(
        new Response(text, {
            status: 503,
            headers: { "content-type": "text/plain" },
        })
    ).text();
    expect(
        result.split("\n").filter((line) => line.startsWith("data: "))
    ).toHaveLength(1);
    expect(parseError(result)).toMatchObject({
        upstreamBody: text,
        contentType: "text/plain",
        error: { status: 503 },
    });
});

test.concurrent("preserves empty error body and absent content type", async () => {
    const result = parseError(
        await relay(new Response(null, { status: 500 })).text()
    );
    expect(result).toMatchObject({
        upstreamBody: "",
        contentType: null,
        error: { status: 500 },
    });
    expect(result.bodyTruncated).not.toBe(true);
});

test.concurrent("HTTP error diagnostics never count as the first upstream SSE byte", async () => {
    const first = vi.fn<(ms: number) => void>();
    const finish = vi.fn<(timing: { firstByteMs: number | null }) => void>();
    const response = createEarlyKeepaliveResponse(
        () =>
            Promise.resolve(
                new Response('{"error":{"message":"busy"}}', { status: 503 })
            ),
        new AbortController(),
        15_000,
        finish,
        first
    );
    expect(parseError(await response.text()).upstreamBody).toEqual({
        error: { message: "busy" },
    });
    expect(first).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ firstByteMs: null, completed: true })
    );
});

test.concurrent("an exactly 1MiB completed error body is not marked truncated", async () => {
    const payload = parseError(
        await relay(
            new Response("x".repeat(1024 * 1024), { status: 502 })
        ).text()
    );
    expect((payload.upstreamBody as string).length).toBe(1024 * 1024);
    expect(payload.bodyTruncated).toBeUndefined();
});

test.concurrent("decodes UTF-8 text split across upstream chunks", async () => {
    const bytes = new TextEncoder().encode("오류\nretry");
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes.subarray(0, 2));
            controller.enqueue(bytes.subarray(2));
            controller.close();
        },
    });
    const payload = parseError(
        await relay(new Response(body, { status: 502 })).text()
    );
    expect(payload.upstreamBody).toBe("오류\nretry");
});

test.concurrent("limits error body to 1MiB and cancels the oversized source", async () => {
    const cancel = vi.fn<(reason: unknown) => void>();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(
                new TextEncoder().encode("x".repeat(1024 * 1024 + 100))
            );
        },
        cancel,
    });
    const payload = parseError(
        await relay(new Response(body, { status: 502 })).text()
    );
    expect(typeof payload.upstreamBody).toBe("string");
    expect((payload.upstreamBody as string).length).toBe(1024 * 1024);
    expect((payload.upstreamBody as string).replaceAll("x", "")).toBe("");
    expect(payload.bodyTruncated).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
});

test.concurrent("reader failure preserves available prefix without exposing internal exception", async () => {
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (reads++ === 0)
                controller.enqueue(
                    new TextEncoder().encode("partial diagnostic")
                );
            else controller.error(new Error("internal credential"));
        },
    });
    const text = await relay(new Response(body, { status: 502 })).text();
    expect(parseError(text)).toMatchObject({
        upstreamBody: "partial diagnostic",
        bodyTruncated: true,
        bodyReadFailed: true,
    });
    expect(text).not.toContain("internal credential");
});

test.concurrent("cancellation interrupts a pending upstream error-body read", async () => {
    const cancel = vi.fn<(reason: unknown) => void>();
    const abort = new AbortController();
    const upstream = new Response(new ReadableStream<Uint8Array>({ cancel }), {
        status: 429,
    });
    const response = createEarlyKeepaliveResponse(
        () => Promise.resolve(upstream),
        abort
    );
    const reader = response.body!.getReader();
    await reader.read();
    await setImmediate();
    expect(cancel).not.toHaveBeenCalled();
    await reader.cancel("disconnected");
    expect(abort.signal.reason).toBe("disconnected");
    expect(cancel).toHaveBeenCalledWith("disconnected");
});

test.concurrent("keepalive continues while the HTTP error body remains pending", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const upstream = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                source = controller;
            },
        }),
        { status: 503 }
    );
    const response = createEarlyKeepaliveResponse(
        () => Promise.resolve(upstream),
        new AbortController(),
        10
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        ": keepalive\n\n"
    );
    await setImmediate();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        ": keepalive\n\n"
    );
    source.enqueue(new TextEncoder().encode("busy"));
    source.close();
    let result = "";
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        result += new TextDecoder().decode(chunk.value);
    }
    expect(parseError(result).upstreamBody).toBe("busy");
});
