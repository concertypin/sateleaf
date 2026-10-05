import { afterEach, assert, expect, test, vi } from "vitest";
import { createUpstreamBody, InvalidRequestError } from "@/proxy/request.js";
import { parseProxyRoute } from "@/proxy/route.js";
import { transformGemini } from "@/transform/index.js";
import type * as TransformModule from "@/transform/index.js";

vi.mock("@/transform/index.js", async (importOriginal) => ({
    ...(await importOriginal<typeof TransformModule>()),
    transformGemini: vi.fn<typeof transformGemini>(),
}));

const route = parseProxyRoute(
    "/proxy/test-secret/maximum/example.com/v1beta/models/gemini:generateContent"
);

afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
});

test("does not read or transform an already aborted request", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    controller.abort(reason);
    const request = new Request("https://proxy.example", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
    });

    await expect(createUpstreamBody(request, route, 1024)).rejects.toBe(reason);
    assert.isFalse(request.bodyUsed);
    assert.equal(vi.mocked(transformGemini).mock.calls.length, 0);
});

test("cancels a pending body read and removes the abort listener", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    const cancel = vi.fn<(reason?: unknown) => void>();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const request = new Request("https://proxy.example", {
        method: "POST",
        body,
        signal: controller.signal,
        duplex: "half",
    } as RequestInit);
    const removeListener = vi.spyOn(request.signal, "removeEventListener");
    const result = createUpstreamBody(request, route, 1024);
    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
    assert.strictEqual(cancel.mock.calls[0]?.[0], reason);
    assert.isFalse(body.locked);
    assert.equal(removeListener.mock.calls[0]?.[0], "abort");
    assert.equal(vi.mocked(transformGemini).mock.calls.length, 0);
});

test("preserves the abort reason when disconnection happens during transformation", async () => {
    const controller = new AbortController();
    const reason = new Error("client disconnected");
    vi.mocked(transformGemini).mockImplementationOnce(() => {
        controller.abort(reason);
        return Promise.resolve({});
    });
    const request = new Request("https://proxy.example", {
        method: "POST",
        body: "{}",
        signal: controller.signal,
    });

    try {
        await createUpstreamBody(request, route, 1024);
        assert.fail("Expected cancellation");
    } catch (error) {
        assert.strictEqual(error, reason);
        assert.notInstanceOf(error, InvalidRequestError);
    }
});

test("removes the body listener and releases its lock after a successful read", async () => {
    const request = new Request("https://proxy.example", {
        method: "PUT",
        body: "hello",
    });
    const removeListener = vi.spyOn(request.signal, "removeEventListener");
    const result = await createUpstreamBody(request, route, 1024);

    assert.isFalse(result.transformed);
    assert.isFalse(request.body?.locked);
    assert.equal(removeListener.mock.calls[0]?.[0], "abort");
});
