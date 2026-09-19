import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createProxyHandler } from "./proxy/index.js";
import { corsMiddleware } from "./middleware/cors.js";
import DOCS from "./docs.md?raw";

const app = new Hono()
    .use("*", corsMiddleware)
    .get("/", (c) => c.json({ name: "sateleaf", status: "ok" }))
    .get("/health", (c) => c.json({ status: "ok" }))
    .get("/docs", (c) =>
        c.text(DOCS, 200, { "Content-Type": "text/markdown; charset=utf-8" })
    )
    .all("/*", createProxyHandler());
if (!import.meta.env.DEV)
    serve(
        {
            fetch: app.fetch,
            port: Number.parseInt(process.env.PORT || "3000", 10),
        },
        (info) => {
            console.log(`Sateleaf proxy listening on :${info.port}`);
        }
    );

export default app;
