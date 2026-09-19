import { assert, test } from "vitest";
import { transformGemini } from "@/transform/index.js";

test("folds native Gemini text into an inline PDF", async () => {
    const result = await transformGemini(
        {
            contents: [{ role: "user", parts: [{ text: "hello" }] }],
            generationConfig: { temperature: 0 },
        },
        "maximum",
        1
    );

    const serialized = JSON.stringify(result);
    assert.match(serialized, /"temperature":0/u);
    assert.match(serialized, /"mimeType":"application\/pdf"/u);
    assert.match(serialized, /"data":"JVBER/u);
});
