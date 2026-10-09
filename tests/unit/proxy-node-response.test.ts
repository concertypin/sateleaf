import { once } from "node:events";
import { get } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, assert, test, vi } from "vitest";
import { corsMiddleware } from "@/middleware/cors.js";
import { createProxyHandler } from "@/proxy/index.js";

afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

test("relays immutable fetch headers with the production Node response override", async () => {
    const nativeFetch = globalThis.fetch;
    const nativeRequest = globalThis.Request;
    const nativeResponse = globalThis.Response;
    const upstream = await nativeFetch("data:text/plain,upstream-body");
    assert.throws(() => upstream.headers.set("x-test", "value"), /immutable/u);
    vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.resolve(upstream))
    );
    vi.stubEnv("PROXY_SECRET", "test-secret");
    const app = new Hono()
        .use("*", corsMiddleware)
        .all("/*", createProxyHandler());
    // Keep the default override enabled, matching src/index.ts in production.
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("Expected a TCP listening address");
        const result = await new Promise<{
            status: number | undefined;
            body: string;
            timing: string | string[] | undefined;
            origin: string | string[] | undefined;
        }>((resolve, reject) => {
            const client = get(
                `http://127.0.0.1:${address.port}/proxy/test-secret/maximum/example.com/`,
                { headers: { origin: "https://client.example" } },
                (response) => {
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", (chunk: string) => {
                        body += chunk;
                    });
                    response.on("error", reject);
                    response.on("end", () =>
                        resolve({
                            status: response.statusCode,
                            body,
                            timing: response.headers["server-timing"],
                            origin: response.headers[
                                "access-control-allow-origin"
                            ],
                        })
                    );
                }
            );
            client.on("error", reject);
        });
        assert.equal(result.status, 200);
        assert.equal(result.body, "upstream-body");
        assert.include(result.timing, "upstream_headers;dur=");
        assert.equal(result.origin, "https://client.example");
    } finally {
        globalThis.Request = nativeRequest;
        globalThis.Response = nativeResponse;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
        });
    }
});
