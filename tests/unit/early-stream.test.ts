import { setImmediate } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import {
    createEarlyKeepaliveResponse,
    createKeepaliveResponse,
} from "@/proxy/stream.js";

afterEach(() => vi.useRealTimers());
const decode = (bytes: Uint8Array | undefined) =>
    new TextDecoder().decode(bytes);

test("sends initial comment and heartbeats while upstream headers are pending", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const first = vi.fn<(ms: number) => void>();
    const response = createEarlyKeepaliveResponse(
        () =>
            new Promise((done) => {
                resolve = done;
            }),
        new AbortController(),
        100,
        undefined,
        first
    );
    const reader = response.body!.getReader();
    expect(response.status).toBe(200);
    expect(decode((await reader.read()).value)).toBe(": keepalive\n\n");
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(100);
    expect(decode((await pending).value)).toBe(": keepalive\n\n");
    expect(first).not.toHaveBeenCalled();
    resolve(
        new Response("data: hello\n\n", {
            headers: { "content-type": "text/event-stream" },
        })
    );
    expect(decode((await reader.read()).value)).toBe("data: hello\n\n");
    expect(first).toHaveBeenCalledTimes(1);
    expect((await reader.read()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
});

test.each([
    [() => Promise.reject(new Error("secret")), "UPSTREAM_REQUEST_FAILED"],
    [
        () => Promise.resolve(new Response("secret", { status: 429 })),
        "UPSTREAM_HTTP_ERROR",
    ],
    [() => Promise.resolve(new Response("secret")), "UPSTREAM_NOT_SSE"],
])("encodes early failure as a sanitized SSE error", async (load, code) => {
    const first = vi.fn<(ms: number) => void>();
    const finish = vi.fn<(timing: unknown) => void>();
    const response = createEarlyKeepaliveResponse(
        load,
        new AbortController(),
        100,
        finish,
        first
    );
    const text = await response.text();
    expect(text).toContain("event: error\n");
    expect(text).toContain(code);
    expect(text.includes("secret")).toBe(code === "UPSTREAM_HTTP_ERROR");
    expect(first).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledWith(
        expect.objectContaining({ firstByteMs: null, completed: true })
    );
});

test("cancel during header wait aborts immediately and cancels a late body", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const abort = new AbortController();
    const response = createEarlyKeepaliveResponse(
        () =>
            new Promise((done) => {
                resolve = done;
            }),
        abort,
        100
    );
    const reader = response.body!.getReader();
    await reader.read();
    await setImmediate();
    await reader.cancel("gone");
    expect(abort.signal.reason).toBe("gone");
    expect(vi.getTimerCount()).toBe(0);
    const cancel = vi.fn<(reason: unknown) => void>();
    resolve(
        new Response(new ReadableStream({ cancel }), {
            headers: { "content-type": "text/event-stream" },
        })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledWith("gone");
});

test("already aborted requests never start preparation", async () => {
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    const load = vi.fn<() => Promise<Response>>();
    const response = createEarlyKeepaliveResponse(load, abort);
    await expect(response.text()).rejects.toThrow("gone");
    expect(load).not.toHaveBeenCalled();
});

test("initial comment is consumed before preparation starts", async () => {
    const load = vi.fn<() => Promise<Response>>().mockResolvedValue(
        new Response("data: done\n\n", {
            headers: { "content-type": "text/event-stream" },
        })
    );
    const response = createEarlyKeepaliveResponse(load, new AbortController());
    const reader = response.body!.getReader();
    expect(decode((await reader.read()).value)).toBe(": keepalive\n\n");
    expect(load).not.toHaveBeenCalled();
    await setImmediate();
    expect(load).toHaveBeenCalledTimes(1);
    await reader.cancel();
});

test("cancelling before the preparation I/O turn prevents load", async () => {
    const load = vi.fn<() => Promise<Response>>();
    const abort = new AbortController();
    const response = createEarlyKeepaliveResponse(load, abort);
    await response.body!.cancel("gone");
    expect(abort.signal.reason).toBe("gone");
    expect(load).not.toHaveBeenCalled();
});

test("early relay preserves partial SSE frames and suppresses heartbeat inside them", async () => {
    vi.useFakeTimers();
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const response = createEarlyKeepaliveResponse(
        () =>
            Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            source = controller;
                        },
                    }),
                    { headers: { "content-type": "text/event-stream" } }
                )
            ),
        new AbortController(),
        100
    );
    const reader = response.body!.getReader();
    await reader.read();
    await setImmediate();
    source.enqueue(new TextEncoder().encode("data: hel"));
    expect(decode((await reader.read()).value)).toBe("data: hel");
    const received =
        vi.fn<(result: ReadableStreamReadResult<Uint8Array>) => void>();
    const pending = reader.read();
    void pending.then(received);
    await vi.advanceTimersByTimeAsync(300);
    expect(received).not.toHaveBeenCalled();
    source.enqueue(new TextEncoder().encode("lo\n\n"));
    expect(decode((await pending).value)).toBe("lo\n\n");
    await reader.cancel();
});

test("keepalive opt-out creates no timer and first-byte ignores empty chunks", async () => {
    vi.useFakeTimers();
    const first = vi.fn<(ms: number) => void>();
    const response = createKeepaliveResponse(
        new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(new Uint8Array());
                    controller.enqueue(
                        new TextEncoder().encode("data: done\n\n")
                    );
                    controller.close();
                },
            }),
            { headers: { "content-type": "text/event-stream" } }
        ),
        new AbortController(),
        100,
        undefined,
        { keepalive: false, onFirstByte: first }
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(await response.text()).toBe("data: done\n\n");
    expect(first).toHaveBeenCalledTimes(1);
});
