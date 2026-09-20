import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createProxyHandler } from "./proxy/index.js";
import { corsMiddleware } from "./middleware/cors.js";

import { languageDetector } from "hono/language";
// oxlint-disable-next-line import/no-relative-parent-imports
import readmeEn from "../README.md?raw";
// oxlint-disable-next-line import/no-relative-parent-imports
import readmeKo from "../README.ko.md?raw";

const app = new Hono()
    .use("*", corsMiddleware)
    .get("/", (c) => c.json({ name: "sateleaf", status: "ok" }))
    .get("/health", (c) => c.json({ status: "ok" }))
    .get(
        "/docs",
        languageDetector({
            order: ["querystring", "header"],
            supportedLanguages: ["ko", "en"],
            fallbackLanguage: "en",
            caches: false,
        }),
        (c) =>
            // Serve the README matching the detected language.
            c.text(c.get("language") === "ko" ? readmeKo : readmeEn, 200, {
                "Content-Type": "text/markdown; charset=utf-8",
            })
    )
    .all("/*", createProxyHandler());

// Dev server tries to listen on every refresh, so it should be gated
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
