/// <reference types="node" />
import { once } from "node:events";
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

async function startProxy() {
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
        throw new Error("Expected a TCP listening address");
    return {
        server,
        url: `http://127.0.0.1:${address.port}/proxy/test-secret/maximum,nokeepalive/example.com/events`,
    };
}

test("aborts upstream header wait when the actual HTTP client disconnects", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
        "fetch",
        vi.fn((_input: unknown, init: RequestInit) => {
            signal = init.signal ?? undefined;
            return new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener(
                    "abort",
                    () => reject(new Error("Aborted")),
                    {
                        once: true,
                    }
                );
            });
        })
    );
    const { server, url } = await startProxy();
    const client = get(url);
    client.on("error", () => {});
    try {
        await vi.waitFor(() => assert.isDefined(signal));
        assert.isFalse(signal?.aborted);
        client.destroy();
        await vi.waitFor(() => assert.isTrue(signal?.aborted));
    } finally {
        client.destroy();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});

test("aborts upstream and cancels its body after an HTTP streaming disconnect", async () => {
    let signal: AbortSignal | undefined;
    const cancel = vi.fn<() => void>();
    vi.stubGlobal(
        "fetch",
        vi.fn((_input: unknown, init: RequestInit) => {
            signal = init.signal ?? undefined;
            return Promise.resolve(
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode("data: first\n\n")
                            );
                        },
                        cancel,
                    }),
                    { headers: { "content-type": "text/event-stream" } }
                )
            );
        })
    );
    const { server, url } = await startProxy();
    const client = get(url);
    client.on("error", () => {});
    try {
        const response = await new Promise<IncomingMessage>(
            (resolve, reject) => {
                client.once("response", resolve);
                client.once("error", reject);
            }
        );
        const chunk = await new Promise<Buffer>((resolve, reject) => {
            response.once("data", resolve);
            response.once("error", reject);
        });
        assert.equal(chunk.toString(), "data: first\n\n");
        assert.isFalse(signal?.aborted);
        response.destroy();
        await vi.waitFor(() => {
            assert.isTrue(signal?.aborted);
            assert.equal(cancel.mock.calls.length, 1);
        });
    } finally {
        client.destroy();
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
