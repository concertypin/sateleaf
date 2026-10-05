/// <reference types="node" />
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { get } from "node:http";
import type { IncomingMessage } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, assert, test, vi } from "vitest";
import { createProxyHandler } from "@/proxy/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

test("preserves upstream timing and publishes preparation timing before body completion", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
        "fetch",
        vi.fn(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            bodyController = controller;
                        },
                    }),
                    {
                        headers: {
                            "content-type": "text/event-stream",
                            "server-timing": "model;dur=123",
                        },
                    }
                )
        )
    );
    vi.stubEnv("PROXY_SECRET", "test-secret");
    const app = new Hono().all("/*", createProxyHandler());
    const response = await app.request(
        "/proxy/test-secret/nokeepalive/example.com/events"
    );
    assert.match(
        response.headers.get("server-timing") ?? "",
        /^model;dur=123, prepare;dur=\d+\.\d{2}, upstream_headers;dur=\d+\.\d{2}$/
    );
    assert.isNull(response.headers.get("trailer"));
    bodyController?.enqueue(new TextEncoder().encode("data: done\n\n"));
    bodyController?.close();
    assert.equal(await response.text(), "data: done\n\n");
});

test("sends stream timing in actual Node HTTP trailers after early headers and body bytes", async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    vi.stubGlobal(
        "fetch",
        vi.fn(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            bodyController = controller;
                            controller.enqueue(
                                new TextEncoder().encode("data: first\n\n")
                            );
                        },
                    }),
                    {
                        headers: {
                            "content-type": "text/event-stream",
                            "server-timing": "model;dur=123",
                        },
                    }
                )
        )
    );
    vi.stubEnv("PROXY_SECRET", "test-secret");
    const app = new Hono().all("/*", createProxyHandler());
    const server = serve({
        fetch: app.fetch,
        hostname: "127.0.0.1",
        port: 0,
        overrideGlobalObjects: false,
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("Expected TCP address");
    const client = get(
        `http://127.0.0.1:${address.port}/proxy/test-secret/nokeepalive/example.com/events`
    );
    try {
        const response = await new Promise<IncomingMessage>(
            (resolve, reject) => {
                client.once("response", resolve);
                client.once("error", reject);
            }
        );
        assert.match(
            String(response.headers["server-timing"] ?? ""),
            /^model;dur=123, prepare;dur=\d+\.\d{2}, upstream_headers;dur=\d+\.\d{2}$/
        );
        assert.equal(response.headers.trailer, "Server-Timing");
        assert.equal(response.headers["transfer-encoding"], "chunked");
        assert.isFalse(response.complete);
        assert.deepEqual(response.trailers, {});
        const first = await new Promise<Buffer>((resolve, reject) => {
            response.once("data", resolve);
            response.once("error", reject);
        });
        assert.equal(first.toString(), "data: first\n\n");
        const end = once(response, "end");
        bodyController?.close();
        response.resume();
        await end;
        assert.match(
            response.trailers["server-timing"] ?? "",
            /^stream;dur=\d+\.\d{2}, upstream_body_wait;dur=\d+\.\d{2}, first_upstream_byte;dur=\d+\.\d{2}$/
        );
    } finally {
        client.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
    }
});

test.each([
    ["maximum", 200, "application/json", '{"ok":true}'],
    ["maximum", 429, "application/json", '{"error":"rate limited"}'],
    ["nokeepalive", 200, "text/event-stream", "data: done\n\n"],
])(
    "preserves completed HTTP response and trailers: %s %i %s",
    async (settings, status, contentType, body) => {
        vi.stubEnv("PROXY_SECRET", "test-secret");
        vi.stubGlobal(
            "fetch",
            vi.fn(() =>
                Promise.resolve(
                    new Response(body, {
                        status,
                        headers: {
                            "content-type": contentType,
                            "content-length": String(Buffer.byteLength(body)),
                        },
                    })
                )
            )
        );
        const app = new Hono().all("/*", createProxyHandler());
        const server = serve({
            fetch: app.fetch,
            hostname: "127.0.0.1",
            port: 0,
            overrideGlobalObjects: false,
        });
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Expected TCP address");
        const client = get(
            `http://127.0.0.1:${address.port}/proxy/test-secret/${settings}/example.com/events`
        );
        const requestErrors: Error[] = [];
        const recordRequestError = (error: Error) => requestErrors.push(error);
        client.on("error", recordRequestError);
        try {
            const response = await new Promise<IncomingMessage>(
                (resolve, reject) => {
                    client.once("response", resolve);
                    client.once("error", reject);
                }
            );
            const actual = await new Promise<string>((resolve, reject) => {
                let collected = "";
                response.on("data", (chunk: Buffer) => {
                    collected += chunk.toString();
                });
                response.once("end", () => resolve(collected));
                response.once("error", reject);
                response.once("aborted", () =>
                    reject(new Error("HTTP response aborted before completion"))
                );
            });
            assert.equal(response.statusCode, status);
            assert.equal(actual, body);
            await setImmediate();
            assert.isTrue(response.complete);
            assert.deepEqual(requestErrors, []);
            assert.equal(response.headers["transfer-encoding"], "chunked");
            assert.isUndefined(response.headers["content-length"]);
            assert.equal(response.headers.trailer, "Server-Timing");
            assert.match(
                response.trailers["server-timing"] ?? "",
                /stream;dur=\d+\.\d{2}/
            );
        } finally {
            client.destroy();
            await new Promise<void>((resolve, reject) =>
                server.close((error) => (error ? reject(error) : resolve()))
            );
            client.removeListener("error", recordRequestError);
        }
    }
);
