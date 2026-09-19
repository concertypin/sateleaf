import { beforeEach, assert, test, vi } from "vitest";
import { generateTranscriptPdf } from "@/pdf/index.js";
import { transcriptPdfBase64 } from "@/pdf/cache.js";

vi.mock("@/pdf/index.js", () => ({
    generateTranscriptPdf: vi.fn<
        (
            transcript: string,
            fontSize?: number,
            margin?: number
        ) => {
            bytes: Uint8Array;
            pageCount: number;
        }
    >(() => ({
        bytes: new TextEncoder().encode("deterministic-pdf"),
        pageCount: 1,
    })),
}));

beforeEach(() => {
    vi.mocked(generateTranscriptPdf).mockClear();
});

test("reuses identical PDFs and bypasses both cache lookup and storage", async () => {
    const transcript = `cached transcript ${Date.now()}`;
    const first = await transcriptPdfBase64(transcript, 1, true);
    const second = await transcriptPdfBase64(transcript, 1, true);
    const bypassed = await transcriptPdfBase64(transcript, 1, false);

    assert.equal(first, second);
    assert.equal(second, bypassed);
    assert.equal(vi.mocked(generateTranscriptPdf).mock.calls.length, 2);
});
