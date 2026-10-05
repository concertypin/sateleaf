import { afterEach, assert, expect, test, vi } from "vitest";
import { createKeepaliveResponse } from "@/proxy/stream.js";

afterEach(() => vi.useRealTimers());

function fixture(contentType = "text/event-stream") {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn<(reason: unknown) => void>();
    const abort = new AbortController();
    const upstream = new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                source = controller;
            },
            cancel,
        }),
        {
            status: 201,
            headers: {
                "content-type": contentType,
                "content-length": "123",
                "content-encoding": "gzip",
                "x-upstream": "yes",
            },
        }
    );
    const response = createKeepaliveResponse(upstream, abort, 100);
    const reader = response.body!.getReader();
    const send = (value: string) =>
        source.enqueue(new TextEncoder().encode(value));
    return { source, cancel, abort, response, reader, send };
}

test("keeps idle SSE alive and preserves upstream response metadata", async () => {
    vi.useFakeTimers();
    const f = fixture("text/event-stream; charset=utf-8");
    const pending = f.reader.read();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(
        new TextDecoder().decode((await pending).value),
        ": keepalive\n\n"
    );
    assert.equal(f.response.status, 201);
    assert.equal(f.response.headers.get("x-upstream"), "yes");
    assert.isNull(f.response.headers.get("content-length"));
    assert.isNull(f.response.headers.get("content-encoding"));
    f.source.close();
    assert.isTrue((await f.reader.read()).done);
    assert.equal(vi.getTimerCount(), 0);
});

test("does not splice comments into partial events or split CRLF", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.send("data: hello\r\n\r");
    await f.reader.read();
    const pending = f.reader.read();
    const received =
        vi.fn<(result: ReadableStreamReadResult<Uint8Array>) => void>();
    void pending.then(received);
    await vi.advanceTimersByTimeAsync(300);
    assert.equal(received.mock.calls.length, 0);
    f.send("\n");
    assert.equal(new TextDecoder().decode((await pending).value), "\n");
    const heartbeat = f.reader.read();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(
        new TextDecoder().decode((await heartbeat).value),
        ": keepalive\n\n"
    );
    await f.reader.cancel();
    assert.isTrue(f.abort.signal.aborted);
    assert.equal(vi.getTimerCount(), 0);
});

test("forwards non-SSE bytes without heartbeat and cancels upstream", async () => {
    vi.useFakeTimers();
    const f = fixture("application/json");
    f.send("{}");
    assert.equal(new TextDecoder().decode((await f.reader.read()).value), "{}");
    assert.equal(vi.getTimerCount(), 0);
    await f.reader.cancel("disconnected");
    assert.equal(f.abort.signal.reason, "disconnected");
    assert.equal(f.cancel.mock.calls[0]?.[0], "disconnected");
});

test("abort errors pending reads and releases upstream and timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const reason = new Error("disconnected");
    const pending = f.reader.read();
    f.abort.abort(reason);
    await expect(pending).rejects.toThrow("disconnected");
    assert.equal(f.cancel.mock.calls[0]?.[0], reason);
    assert.equal(vi.getTimerCount(), 0);
});

test("upstream failure errors relay and clears timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = f.reader.read();
    f.source.error(new Error("upstream failed"));
    await expect(pending).rejects.toThrow("upstream failed");
    assert.equal(vi.getTimerCount(), 0);
});

test("idle heartbeat buffering stays bounded without downstream reads", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await vi.advanceTimersByTimeAsync(10_000);
    assert.equal(
        new TextDecoder().decode((await f.reader.read()).value),
        ": keepalive\n\n"
    );
    const received =
        vi.fn<(result: ReadableStreamReadResult<Uint8Array>) => void>();
    const pending = f.reader.read();
    void pending.then(received);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(received.mock.calls.length, 0);
    f.source.close();
    assert.isTrue((await pending).done);
});

test("partial data stays intact across chunks and resumes heartbeat at blank line", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.send("data: hel");
    await f.reader.read();
    const pending = f.reader.read();
    const received =
        vi.fn<(result: ReadableStreamReadResult<Uint8Array>) => void>();
    void pending.then(received);
    await vi.advanceTimersByTimeAsync(300);
    assert.equal(received.mock.calls.length, 0);
    f.send("lo\n\n");
    assert.equal(new TextDecoder().decode((await pending).value), "lo\n\n");
    const heartbeat = f.reader.read();
    await vi.advanceTimersByTimeAsync(100);
    assert.equal(
        new TextDecoder().decode((await heartbeat).value),
        ": keepalive\n\n"
    );
    await f.reader.cancel();
});

test("finish callback runs once when completed and for bodyless responses", async () => {
    const finish = vi.fn<() => void>();
    const response = createKeepaliveResponse(
        new Response("data: complete\n\n", {
            headers: { "content-type": "text/event-stream" },
        }),
        new AbortController(),
        100,
        finish
    );
    assert.equal(await response.text(), "data: complete\n\n");
    assert.equal(finish.mock.calls.length, 1);
    const bodylessFinish = vi.fn<() => void>();
    const bodyless = createKeepaliveResponse(
        new Response(null, { status: 204 }),
        new AbortController(),
        100,
        bodylessFinish
    );
    assert.equal(bodyless.status, 204);
    assert.equal(bodylessFinish.mock.calls.length, 1);
});
