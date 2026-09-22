import { Hono } from "hono";
import { afterEach, assert, test, vi } from "vitest";
import { createProxyHandler } from "@/proxy/index.js";
import { hasValidProxySecret, parseProxyRoute } from "@/proxy/route.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

test("enables PDF caching by default and accepts nocache", () => {
    const prefix = "/proxy/test-secret/";
    const upstream =
        "/generativelanguage.googleapis.com/v1beta/models/gemini:generateContent";

    assert.isTrue(parseProxyRoute(`${prefix}maximum${upstream}`).cachePdf);
    assert.isFalse(
        parseProxyRoute(`${prefix}maximum,nocache${upstream}`).cachePdf
    );
});

test("accepts any proxy secret from a comma-separated environment value", () => {
    const pathname = "/proxy/backup-secret/maximum/example.com/v1/models";

    assert.isTrue(
        hasValidProxySecret(
            pathname,
            "primary-secret, backup-secret, third-secret"
        )
    );
    assert.isFalse(
        hasValidProxySecret(pathname, "primary-secret,other-secret")
    );
    assert.isFalse(hasValidProxySecret(pathname, ", ,"));
});

test("rejects an oversized Gemini body before forwarding", async () => {
    const upstreamFetch = vi.fn<() => undefined>();
    vi.stubGlobal("fetch", upstreamFetch);
    vi.stubEnv("PROXY_SECRET", "test-secret");
    vi.stubEnv("MAX_REQUEST_BYTES", "4");
    const app = new Hono().all("/*", createProxyHandler());

    const response = await app.request(
        "/proxy/test-secret/maximum/generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        { method: "POST", body: '{"contents":[]}' }
    );

    assert.equal(response.status, 413);
    assert.equal(upstreamFetch.mock.calls.length, 0);
});

test("rejects malformed Gemini JSON without contacting the upstream", async () => {
    const upstreamFetch = vi.fn<() => undefined>();
    vi.stubGlobal("fetch", upstreamFetch);
    vi.stubEnv("PROXY_SECRET", "test-secret");
    const app = new Hono().all("/*", createProxyHandler());

    const response = await app.request(
        "/proxy/test-secret/maximum/generativelanguage.googleapis.com/v1beta/models/gemini:generateContent",
        { method: "POST", body: "not json" }
    );

    assert.equal(response.status, 400);
    assert.equal(upstreamFetch.mock.calls.length, 0);
});

test("relays SSE bodies without buffering or replacing upstream headers", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
        "fetch",
        vi.fn(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode("data: first\n\n"));
                    controller.enqueue(encoder.encode("data: second\n\n"));
                    controller.close();
                },
            });
            return new Response(body, {
                headers: {
                    "cache-control": "no-cache",
                    "content-encoding": "gzip",
                    "content-length": "999",
                    "content-type": "text/event-stream",
                    "x-upstream": "preserved",
                },
            });
        })
    );
    vi.stubEnv("PROXY_SECRET", "test-secret");
    const app = new Hono().all("/*", createProxyHandler());

    const response = await app.request(
        "/proxy/test-secret/maximum/example.com/v1/events"
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-cache");
    assert.equal(response.headers.get("x-upstream"), "preserved");
    assert.isNull(response.headers.get("content-encoding"));
    assert.isNull(response.headers.get("content-length"));
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
});
