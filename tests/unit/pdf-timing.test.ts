import { afterEach, assert, test, vi } from "vitest";
import { transcriptPdfBase64 } from "@/pdf/cache.js";

afterEach(() => {
    vi.restoreAllMocks();
});

test("reports generation and cache timings without recording transcript contents", async () => {
    const logs = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const transcript = `private transcript ${crypto.randomUUID()}`;
    await transcriptPdfBase64(transcript, 1, false);
    await transcriptPdfBase64(transcript, 1, true);
    await transcriptPdfBase64(transcript, 1, true);

    const entries = logs.mock.calls.map(
        ([line]) =>
            JSON.parse(String(line)) as {
                event: string;
                cache: string;
                inputCharacters: number;
                fontSize: number;
                generationMs: number | null;
                totalMs: number;
                pdfBytes: number;
                pageCount: number | null;
            }
    );
    assert.deepEqual(
        entries.map(({ cache }) => cache),
        ["disabled", "miss", "hit"]
    );
    for (const entry of entries) {
        assert.equal(entry.event, "pdf_timing");
        assert.equal(entry.inputCharacters, transcript.length);
        assert.equal(entry.fontSize, 1);
        assert.isAbove(entry.pdfBytes, 0);
        assert.isAtLeast(entry.totalMs, 0);
        if (entry.cache === "hit") {
            assert.isNull(entry.generationMs);
            assert.isNull(entry.pageCount);
        } else {
            assert.isNumber(entry.generationMs);
            assert.isAtLeast(entry.generationMs ?? -1, 0);
            assert.isAtLeast(entry.totalMs, entry.generationMs ?? 0);
            assert.equal(entry.pageCount, 1);
        }
        assert.notInclude(JSON.stringify(entry), transcript);
        assert.notProperty(entry, "path");
        assert.notProperty(entry, "hash");
    }
});
