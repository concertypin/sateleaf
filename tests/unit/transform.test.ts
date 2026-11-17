import { assert, test } from "vitest";
import { transformGemini } from "@/transform/index.js";

test.concurrent("preserves systemInstruction as system text", async () => {
    const result = await transformGemini(
        {
            systemInstruction: { parts: [{ text: "Be concise." }] },
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
        },
        "balanced",
        1,
        false
    );

    assert(
        typeof result.systemInstruction === "object" &&
            result.systemInstruction !== null &&
            !Array.isArray(result.systemInstruction)
    );
    assert.match(JSON.stringify(result.systemInstruction), /Be concise\./u);
});

test.concurrent("replaces maximum-mode system text with the PDF directive", async () => {
    const result = await transformGemini(
        {
            systemInstruction: { parts: [{ text: "Be concise." }] },
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
        },
        "maximum",
        1,
        false
    );

    const serialized = JSON.stringify(result.systemInstruction);
    assert.match(serialized, /complete ordered prompt/u);
    assert.notMatch(serialized, /Be concise\./u);
});

test.concurrent("folds native Gemini text into an inline PDF", async () => {
    const result = await transformGemini(
        {
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            generationConfig: { temperature: 0 },
        },
        "maximum",
        1,
        false
    );

    const serialized = JSON.stringify(result);
    assert.match(serialized, /"temperature":0/u);
    assert.match(serialized, /"mimeType":"application\/pdf"/u);
    assert.match(serialized, /"data":"JVBER/u);
});

test.concurrent("merges maximum-mode PDFs into a user turn with media", async () => {
    const result = await transformGemini(
        {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "look" },
                        { inlineData: { mimeType: "image/png", data: "AAAA" } },
                    ],
                },
            ],
        },
        "maximum",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 1);
    assert.match(JSON.stringify(result.contents[0]), /inlineData/u);
    assert.match(JSON.stringify(result.contents[0]), /application\/pdf/u);
});

test.concurrent("merges balanced-mode PDFs into a user turn with media", async () => {
    const result = await transformGemini(
        {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "look" },
                        { inlineData: { mimeType: "image/png", data: "AAAA" } },
                    ],
                },
            ],
        },
        "balanced",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 1);
    assert.match(JSON.stringify(result.contents[0]), /inlineData/u);
    assert.match(JSON.stringify(result.contents[0]), /application\/pdf/u);
});

test.concurrent("combines marked sections without splitting the source turn", async () => {
    const result = await transformGemini(
        {
            contents: [
                {
                    role: "user",
                    parts: [{ text: "<pdf>a</pdf> middle <pdf>b</pdf>" }],
                },
            ],
        },
        "marked_combined",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 1);
    const serialized = JSON.stringify(result.contents[0]);
    assert.equal((serialized.match(/application\/pdf/gu) ?? []).length, 2);
});

test.concurrent("merges marked PDFs into the existing user turn", async () => {
    const result = await transformGemini(
        {
            contents: [
                {
                    role: "user",
                    parts: [
                        { text: "before <pdf>secret</pdf> after" },
                        {
                            inlineData: {
                                mimeType: "image/png",
                                data: "AAAA",
                            },
                        },
                    ],
                },
            ],
        },
        "marked",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 1);
    const content = result.contents[0];
    assert(
        typeof content === "object" &&
            content !== null &&
            !Array.isArray(content)
    );
    assert.equal(content.role, "user");
    assert.match(JSON.stringify(content), /"inlineData"/u);
});

test.concurrent("attaches marked PDFs to the source user turn", async () => {
    const result = await transformGemini(
        {
            contents: [
                { role: "user", parts: [{ text: "first <pdf>secret</pdf>" }] },
                { role: "model", parts: [{ text: "answer" }] },
                { role: "user", parts: [{ text: "follow-up" }] },
            ],
        },
        "marked",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 3);
    const first = result.contents[0];
    const last = result.contents[2];
    assert(
        typeof first === "object" && first !== null && !Array.isArray(first)
    );
    assert(typeof last === "object" && last !== null && !Array.isArray(last));
    assert.match(JSON.stringify(first), /Use attached PDF section/u);
    assert.match(JSON.stringify(first), /inlineData/u);
    assert.notMatch(JSON.stringify(last), /inlineData/u);
});

test.concurrent("keeps folded user turns as stand-ins in tool conversations", async () => {
    const call = {
        functionCall: { name: "get_weather", args: { city: "Seoul" } },
        thoughtSignature: "sig",
    };
    const reply = {
        functionResponse: { name: "get_weather", response: { c: 18 } },
    };
    const result = await transformGemini(
        {
            contents: [
                { role: "user", parts: [{ text: "Weather in Seoul?" }] },
                { role: "model", parts: [call] },
                { role: "user", parts: [reply] },
            ],
        },
        "maximum",
        1,
        false
    );

    // Gemini rejects a function-call turn that does not follow a user turn.
    assert(Array.isArray(result.contents));
    const [first, second, third] = result.contents;
    assert.deepEqual(first, {
        role: "user",
        parts: [
            { text: "[This turn's text is in the attached PDF transcript.]" },
        ],
    });
    assert.deepEqual(second, { role: "model", parts: [call] });
    assert.match(JSON.stringify(third), /"functionResponse"/u);
    assert.match(JSON.stringify(third), /application\/pdf/u);
    assert.notMatch(JSON.stringify(result.contents), /Weather in Seoul\?/u);
});

test.concurrent("drops fully folded user turns when no tools are involved", async () => {
    const result = await transformGemini(
        {
            contents: [
                { role: "user", parts: [{ text: "first" }] },
                { role: "model", parts: [{ text: "answer" }] },
                { role: "user", parts: [{ text: "second" }] },
            ],
        },
        "maximum",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 1);
    assert.notMatch(
        JSON.stringify(result.contents),
        /attached PDF transcript/u
    );
});

test.concurrent("emits one stand-in per run of folded user turns", async () => {
    const call = {
        functionCall: { name: "f", args: {} },
        thoughtSignature: "sig",
    };
    const result = await transformGemini(
        {
            contents: [
                { role: "user", parts: [{ text: "one" }] },
                { role: "user", parts: [{ text: "two" }] },
                { role: "user", parts: [] },
                { role: "model", parts: [call] },
                {
                    role: "user",
                    parts: [{ functionResponse: { name: "f", response: {} } }],
                },
            ],
        },
        "maximum",
        1,
        false
    );

    assert(Array.isArray(result.contents));
    assert.equal(result.contents.length, 3);
    assert.deepEqual(result.contents[1], { role: "model", parts: [call] });
});
