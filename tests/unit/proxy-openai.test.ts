import { Hono } from "hono";
import { afterEach, assert, beforeEach, test, vi } from "vitest";
import { createProxyHandler, type ProxyHandlerOptions } from "@/proxy/index.js";
import { openAIChatBasePath } from "@/proxy/openai.js";
import {
    isGemini4OrLater,
    nativeModel,
    parseProxyRoute,
} from "@/proxy/route.js";

const VERTEX_CHAT =
    "/proxy/test-secret/maximum/aiplatform.googleapis.com/v1/publishers/google/openai/chat/completions";
const encoder = new TextEncoder();

type FetchCall = { url: string; headers: Headers; body: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stubs fetch with `respond`, recording what the proxy sent upstream. */
function stubUpstream(respond: () => Response): FetchCall[] {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn((input: URL | RequestInfo, init?: RequestInit) => {
            const raw = init?.body;
            calls.push({
                url:
                    input instanceof URL
                        ? input.href
                        : typeof input === "string"
                          ? input
                          : input.url,
                headers: new Headers(init?.headers),
                body: typeof raw === "string" ? JSON.parse(raw) : raw,
            });
            return Promise.resolve(respond());
        })
    );
    return calls;
}

function sse(events: unknown[]): Response {
    return new Response(
        new ReadableStream<Uint8Array>({
            start(controller) {
                for (const event of events)
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`)
                    );
                controller.close();
            },
        }),
        { headers: { "content-type": "text/event-stream" } }
    );
}

/** `data:` payloads of an OpenAI SSE body, `[DONE]` kept as a string. */
function dataEvents(text: string): unknown[] {
    return text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .map((data): unknown => (data === "[DONE]" ? data : JSON.parse(data)));
}

function chat(
    body: Record<string, unknown>,
    path = VERTEX_CHAT,
    options?: ProxyHandlerOptions
) {
    return new Hono().all("/*", createProxyHandler(options)).request(path, {
        method: "POST",
        headers: {
            authorization: "Bearer vertex-key",
            "content-type": "application/json",
        },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    vi.stubEnv("PROXY_SECRET", "test-secret");
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});

test.concurrent("detects OpenAI chat paths and their native base path", () => {
    assert.equal(
        openAIChatBasePath("/v1/publishers/google/openai/chat/completions"),
        "/v1/publishers/google"
    );
    assert.equal(
        openAIChatBasePath("/v1beta/openai/chat/completions"),
        "/v1beta"
    );
    assert.isNull(openAIChatBasePath("/v1beta/models/x:generateContent"));
});

test.concurrent("classifies Gemini 4+ models and reads native model names", () => {
    assert.isTrue(isGemini4OrLater("gemini-4-carbon"));
    assert.isTrue(isGemini4OrLater("models/gemini-5-flash"));
    assert.isFalse(isGemini4OrLater("gemini-3.8-flash"));
    assert.isFalse(isGemini4OrLater("gemini-2.5-pro"));
    assert.isFalse(isGemini4OrLater("gemma-4"));
    assert.equal(
        nativeModel("/v1beta/models/gemini-3.8-flash:generateContent"),
        "gemini-3.8-flash"
    );
    assert.isFalse(
        parseProxyRoute(`/proxy/s/maximum/example.com/x`).allowGemini4
    );
    assert.isTrue(
        parseProxyRoute(`/proxy/s/maximum,allowgemini4/example.com/x`)
            .allowGemini4
    );
});

test("forwards a non-streaming chat request as a folded native Vertex call", async () => {
    const calls = stubUpstream(() =>
        Response.json({
            responseId: "resp-1",
            modelVersion: "gemini-3.8-flash",
            candidates: [
                {
                    content: {
                        role: "model",
                        parts: [
                            { text: "Checking.", thought: true },
                            {
                                functionCall: {
                                    name: "get_weather",
                                    args: { city: "Seoul" },
                                },
                                thoughtSignature: "sig-1",
                            },
                        ],
                    },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 5,
                thoughtsTokenCount: 3,
                totalTokenCount: 18,
            },
        })
    );

    const response = await chat({
        model: "gemini-3.8-flash",
        messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Weather in Seoul?" },
        ],
        tools: [
            {
                type: "function",
                function: {
                    name: "get_weather",
                    parameters: {
                        type: "object",
                        properties: { city: { type: "string" } },
                    },
                },
            },
        ],
        reasoning_effort: "low",
    });

    assert.equal(response.status, 200);
    const [call] = calls;
    assert.isDefined(call);
    assert.equal(
        call.url,
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent"
    );
    assert.equal(call.headers.get("x-goog-api-key"), "vertex-key");
    assert.isNull(call.headers.get("authorization"));
    assert.isTrue(isRecord(call.body));
    const native = JSON.stringify(call.body);
    // Text was folded into a PDF; tool and thinking settings survive.
    assert.include(native, '"mimeType":"application/pdf"');
    assert.notInclude(native, "Weather in Seoul?");
    assert.include(native, '"functionDeclarations"');
    assert.include(native, '"thinkingLevel":"low"');

    const json: unknown = await response.json();
    assert.deepNestedInclude(json, {
        object: "chat.completion",
        model: "gemini-3.8-flash",
        "choices[0].finish_reason": "tool_calls",
        "choices[0].message.reasoning_content": "Checking.",
        "choices[0].message.tool_calls[0].function.name": "get_weather",
        "choices[0].message.tool_calls[0].function.arguments":
            '{"city":"Seoul"}',
        "choices[0].message.tool_calls[0].extra_content.google.thought_signature":
            "sig-1",
        "usage.completion_tokens": 8,
        "usage.completion_tokens_details.reasoning_tokens": 3,
    });
});

test("streams Gemini SSE back as OpenAI chat chunks", async () => {
    const calls = stubUpstream(() =>
        sse([
            {
                candidates: [
                    {
                        content: {
                            role: "model",
                            parts: [{ text: "Hmm", thought: true }],
                        },
                    },
                ],
                modelVersion: "gemini-3.8-flash",
                responseId: "r1",
            },
            {
                candidates: [
                    {
                        content: { role: "model", parts: [{ text: "Hi!" }] },
                        finishReason: "STOP",
                    },
                ],
                usageMetadata: {
                    promptTokenCount: 4,
                    candidatesTokenCount: 2,
                    totalTokenCount: 6,
                },
            },
        ])
    );

    const response = await chat({
        model: "gemini-3.8-flash",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
    });

    assert.equal(response.status, 200);
    assert.match(
        response.headers.get("content-type") ?? "",
        /^text\/event-stream/u
    );
    assert.equal(
        calls[0]?.url,
        "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:streamGenerateContent?alt=sse"
    );
    const events = dataEvents(await response.text());
    assert.equal(events.at(-1), "[DONE]");
    const text = JSON.stringify(events);
    assert.include(text, '"reasoning_content":"Hmm"');
    assert.include(text, '"content":"Hi!"');
    assert.include(text, '"finish_reason":"stop"');
    assert.include(text, '"object":"chat.completion.chunk"');
});

test("carries tool calls, signatures, and tool results into the native body", async () => {
    const calls = stubUpstream(() =>
        Response.json({
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "Sunny." }] },
                    finishReason: "STOP",
                },
            ],
        })
    );

    const response = await chat({
        model: "gemini-3.8-flash",
        messages: [
            { role: "user", content: "Weather in Seoul and Paris?" },
            {
                role: "assistant",
                content: null,
                tool_calls: [
                    {
                        id: "call_a",
                        type: "function",
                        function: {
                            name: "get_weather",
                            arguments: '{"city":"Seoul"}',
                        },
                        extra_content: {
                            google: { thought_signature: "sig-a" },
                        },
                    },
                    {
                        id: "call_b",
                        type: "function",
                        function: {
                            name: "get_weather",
                            arguments: '{"city":"Paris"}',
                        },
                    },
                ],
            },
            { role: "tool", tool_call_id: "call_a", content: '{"c":20}' },
            { role: "tool", tool_call_id: "call_b", content: "18C" },
        ],
    });

    assert.equal(response.status, 200);
    const body = calls[0]?.body;
    assert.isTrue(isRecord(body) && Array.isArray(body.contents));
    const native = JSON.stringify(body);
    assert.include(
        native,
        '{"functionCall":{"name":"get_weather","args":{"city":"Seoul"},"id":"call_a"},"thoughtSignature":"sig-a"}'
    );
    assert.include(
        native,
        '{"functionCall":{"name":"get_weather","args":{"city":"Paris"},"id":"call_b"}}'
    );
    assert.include(
        native,
        '{"functionResponse":{"name":"get_weather","id":"call_a","response":{"c":20}}}'
    );
    assert.include(
        native,
        '{"functionResponse":{"name":"get_weather","id":"call_b","response":{"output":"18C"}}}'
    );
});

test("returns OpenAI errors for malformed requests without calling upstream", async () => {
    const calls = stubUpstream(() => new Response(null));

    const response = await chat({ model: "gemini-3.8-flash", messages: [] });

    assert.equal(response.status, 400);
    assert.deepNestedInclude(await response.json(), {
        "error.type": "invalid_request_error",
        "error.param": "messages",
    });
    assert.lengthOf(calls, 0);
});

test("maps Gemini HTTP errors to OpenAI error bodies", async () => {
    stubUpstream(() =>
        Response.json(
            {
                error: {
                    code: 429,
                    message: "Resource exhausted",
                    status: "RESOURCE_EXHAUSTED",
                },
            },
            { status: 429 }
        )
    );

    const response = await chat({
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
    });

    assert.equal(response.status, 429);
    assert.deepNestedInclude(await response.json(), {
        "error.message": "Resource exhausted",
        "error.type": "rate_limit_error",
        "error.code": "RESOURCE_EXHAUSTED",
    });
});

test("reports upstream errors in-stream when early keepalive committed a 200", async () => {
    stubUpstream(() =>
        Response.json(
            { error: { code: 400, message: "Bad thinking level" } },
            { status: 400 }
        )
    );

    const response = await chat(
        {
            model: "gemini-3.8-flash",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
        },
        VERTEX_CHAT.replace("/maximum/", "/earlykeepalive/")
    );

    assert.equal(response.status, 200);
    const text = await response.text();
    assert.isTrue(text.startsWith(": keepalive\n\n"));
    const events = dataEvents(text);
    assert.deepNestedInclude(events[0], {
        "error.message": "Bad thinking level",
        "error.status": 400,
    });
    assert.equal(events.at(-1), "[DONE]");
});

/** Resolves fetch with `respond()` after `ms`, like a slow upstream. */
function stubSlowUpstream(ms: number, respond: () => Response): void {
    vi.stubGlobal(
        "fetch",
        vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    setTimeout(() => resolve(respond()), ms);
                })
        )
    );
}

const geminiOk = () =>
    Response.json({
        candidates: [
            {
                content: { role: "model", parts: [{ text: "ok" }] },
                finishReason: "STOP",
            },
        ],
    });

const geminiOverloaded = () =>
    Response.json(
        { error: { code: 503, message: "Overloaded", status: "UNAVAILABLE" } },
        { status: 503, headers: { "retry-after": "7" } }
    );

const nonStreaming = {
    model: "gemini-3.8-flash",
    messages: [{ role: "user", content: "hi" }],
};
const EARLY_CHAT = VERTEX_CHAT.replace("/maximum/", "/earlykeepalive/");

test("answers quick non-streaming early keepalive calls as plain JSON", async () => {
    stubUpstream(geminiOk);

    const response = await chat(nonStreaming, EARLY_CHAT);

    assert.equal(response.status, 200);
    const text = await response.text();
    // Answered within the grace period: no keepalive was committed.
    assert.isFalse(text.startsWith("\n"));
    assert.deepNestedInclude(JSON.parse(text), {
        "choices[0].message.content": "ok",
    });
});

test("keeps the real status for quick errors under early keepalive", async () => {
    stubUpstream(geminiOverloaded);

    const response = await chat(nonStreaming, EARLY_CHAT);

    // SDKs only retry and raise on the HTTP status, so it must not be 200.
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "7");
    assert.deepNestedInclude(await response.json(), {
        "error.message": "Overloaded",
        "error.code": "UNAVAILABLE",
    });
});

test("starts whitespace keepalives when the upstream outlasts the grace period", async () => {
    stubSlowUpstream(60, geminiOk);

    const response = await chat(nonStreaming, EARLY_CHAT, {
        earlyJsonGraceMs: 5,
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /json/u);
    const text = await response.text();
    // The committed newline keepalive is insignificant JSON whitespace.
    assert.isTrue(text.startsWith("\n"));
    assert.deepNestedInclude(JSON.parse(text), {
        object: "chat.completion",
        "choices[0].message.content": "ok",
    });
});

test("puts slow errors into the JSON body once a 200 is committed", async () => {
    stubSlowUpstream(60, geminiOverloaded);

    const response = await chat(nonStreaming, EARLY_CHAT, {
        earlyJsonGraceMs: 5,
    });

    assert.equal(response.status, 200);
    assert.deepNestedInclude(JSON.parse(await response.text()), {
        "error.message": "Overloaded",
        "error.code": "UNAVAILABLE",
        "error.status": 503,
    });
});

test("rejects Gemini 4+ models unless allowgemini4 is set", async () => {
    const calls = stubUpstream(() =>
        Response.json({
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "ok" }] },
                    finishReason: "STOP",
                },
            ],
        })
    );
    const body = {
        model: "gemini-4-carbon",
        messages: [{ role: "user", content: "hi" }],
    };

    const rejected = await chat(body);
    assert.equal(rejected.status, 400);
    assert.lengthOf(calls, 0);

    const native = await new Hono()
        .all("/*", createProxyHandler())
        .request(
            "/proxy/test-secret/maximum/generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent",
            { method: "POST", body: '{"contents":[]}' }
        );
    assert.equal(native.status, 400);
    assert.lengthOf(calls, 0);

    const allowed = await chat(
        body,
        VERTEX_CHAT.replace("/maximum/", "/maximum,allowgemini4/")
    );
    assert.equal(allowed.status, 200);
    assert.lengthOf(calls, 1);
});

test("targets the Developer API and keeps OAuth bearers on Vertex project paths", async () => {
    const calls = stubUpstream(() =>
        Response.json({
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "ok" }] },
                    finishReason: "STOP",
                },
            ],
        })
    );
    const body = {
        model: "gemini-3.8-flash",
        messages: [{ role: "user", content: "hi" }],
    };

    await chat(
        body,
        "/proxy/test-secret/maximum/generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    );
    await chat(
        body,
        "/proxy/test-secret/maximum/us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/openai/chat/completions"
    );

    assert.equal(
        calls[0]?.url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    );
    assert.equal(calls[0]?.headers.get("x-goog-api-key"), "vertex-key");
    assert.equal(
        calls[1]?.url,
        "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/gemini-3.8-flash:generateContent"
    );
    assert.equal(calls[1]?.headers.get("authorization"), "Bearer vertex-key");
    assert.isNull(calls[1]?.headers.get("x-goog-api-key"));
});

test("rejects non-POST chat requests", async () => {
    const response = await new Hono()
        .all("/*", createProxyHandler())
        .request(VERTEX_CHAT, { method: "GET" });

    assert.equal(response.status, 405);
    assert.deepNestedInclude(await response.json(), {
        "error.message": "Chat completions require POST",
    });
});

test("forwards only Google-relevant headers and keeps retry-after on errors", async () => {
    const calls = stubUpstream(
        () =>
            new Response(
                JSON.stringify({ error: { code: 429, message: "Slow down" } }),
                {
                    status: 429,
                    headers: {
                        "content-type": "application/json",
                        "retry-after": "17",
                    },
                }
            )
    );

    const response = await new Hono()
        .all("/*", createProxyHandler())
        .request(VERTEX_CHAT, {
            method: "POST",
            headers: {
                authorization: "Bearer vertex-key",
                "x-stainless-lang": "python",
                "openai-organization": "org-1",
                cookie: "a=b",
                "user-agent": "OpenAI/Python",
            },
            body: JSON.stringify({
                model: "gemini-3.8-flash",
                messages: [{ role: "user", content: "hi" }],
            }),
        });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "17");
    const sent = calls[0]?.headers;
    assert.isDefined(sent);
    assert.deepEqual([...sent.keys()].toSorted(), [
        "content-type",
        "user-agent",
        "x-goog-api-key",
    ]);
});

test("rejects unmappable requests with a real 400 even under early keepalive", async () => {
    const calls = stubUpstream(() => new Response(null));

    const response = await chat(
        {
            model: "gemini-3.8-flash",
            stream: true,
            messages: [
                { role: "user", content: "hi" },
                {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                        {
                            id: "call_x",
                            type: "function",
                            function: { name: "f", arguments: "not json" },
                        },
                    ],
                },
                { role: "tool", tool_call_id: "call_x", content: "ok" },
            ],
        },
        VERTEX_CHAT.replace("/maximum/", "/earlykeepalive/")
    );

    assert.equal(response.status, 400);
    assert.deepNestedInclude(await response.json(), {
        "error.type": "invalid_request_error",
    });
    assert.lengthOf(calls, 0);
});

test("decodes percent-encoded native model names before the Gemini 4 gate", async () => {
    const calls = stubUpstream(() => new Response(null));

    const response = await new Hono()
        .all("/*", createProxyHandler())
        .request(
            "/proxy/test-secret/maximum/generativelanguage.googleapis.com/v1beta/models/gemini%2D4-pro:generateContent",
            { method: "POST", body: '{"contents":[]}' }
        );

    assert.equal(response.status, 400);
    assert.lengthOf(calls, 0);
});

test("follows Gemini long-decode CONTINUATION hops for OpenAI clients", async () => {
    const hops = [
        {
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "Part one. " }] },
                    finishReason: "CONTINUATION",
                    continuationToken: "tok-1",
                },
            ],
            usageMetadata: {
                promptTokenCount: 10,
                candidatesTokenCount: 4,
                totalTokenCount: 14,
            },
        },
        {
            candidates: [
                {
                    content: { role: "model", parts: [{ text: "Part two." }] },
                    finishReason: "STOP",
                },
            ],
            usageMetadata: {
                promptTokenCount: 14,
                candidatesTokenCount: 3,
                totalTokenCount: 17,
            },
        },
    ];
    const bodies: unknown[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn((_input: URL | RequestInfo, init?: RequestInit) => {
            const raw = init?.body;
            bodies.push(typeof raw === "string" ? JSON.parse(raw) : raw);
            return Promise.resolve(Response.json(hops[bodies.length - 1]));
        })
    );

    const response = await chat(
        {
            model: "gemini-4-argon",
            messages: [{ role: "user", content: "Prove it." }],
        },
        VERTEX_CHAT.replace("/maximum/", "/maximum,allowgemini4/")
    );

    assert.equal(response.status, 200);
    assert.lengthOf(bodies, 2);
    // The second hop repeats the request with the token added.
    assert.deepEqual(bodies[1], {
        ...(isRecord(bodies[0]) ? bodies[0] : {}),
        continuationToken: "tok-1",
    });
    assert.deepNestedInclude(await response.json(), {
        "choices[0].message.content": "Part one. Part two.",
        "choices[0].finish_reason": "stop",
        "usage.prompt_tokens": 24,
        "usage.completion_tokens": 7,
    });
});
