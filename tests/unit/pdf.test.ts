import { assert, test } from "vitest";
import { generateTranscriptPdf } from "@/pdf/index.js";

function findBytes(
    bytes: Uint8Array,
    needle: Uint8Array,
    fromIndex = 0
): number {
    outer: for (
        let index = fromIndex;
        index <= bytes.length - needle.length;
        index++
    ) {
        for (let offset = 0; offset < needle.length; offset++) {
            if (bytes[index + offset] !== needle[offset]) continue outer;
        }
        return index;
    }
    return -1;
}

test("generates a valid compressed PDF document", async () => {
    const pdf = await generateTranscriptPdf("compression sentinel", 1);
    const text = new TextDecoder().decode(pdf.bytes);

    assert.equal(text.startsWith("%PDF-1.7\n"), true);
    assert.match(text, /\/Filter \/FlateDecode/u);
    assert.match(text, /startxref\n\d+\n%%EOF/u);

    const decodedStreams: string[] = [];
    const streamMarker = new TextEncoder().encode(
        "/Filter /FlateDecode >>\nstream\n"
    );
    const endMarker = new TextEncoder().encode("\nendstream");
    let markerOffset = findBytes(pdf.bytes, streamMarker);
    while (markerOffset >= 0) {
        const dataStart = markerOffset + streamMarker.length;
        const dataEnd = findBytes(pdf.bytes, endMarker, dataStart);
        assert.notEqual(dataEnd, -1);
        const compressed = pdf.bytes.slice(dataStart, dataEnd);
        const input = new Uint8Array(new ArrayBuffer(compressed.byteLength));
        input.set(compressed);
        const body = new Response(input).body;
        assert.isNotNull(body);
        const decompressed = await new Response(
            body.pipeThrough(new DecompressionStream("deflate"))
        ).arrayBuffer();
        decodedStreams.push(new TextDecoder().decode(decompressed));
        markerOffset = findBytes(pdf.bytes, streamMarker, dataEnd);
    }

    const transcript = "compression sentinel";
    let transcriptHex = "";
    for (let index = 0; index < transcript.length; index++) {
        transcriptHex += transcript
            .charCodeAt(index)
            .toString(16)
            .toUpperCase()
            .padStart(4, "0");
    }
    assert.isTrue(
        decodedStreams.some((stream) => stream.includes("beginbfchar"))
    );
    const decodedText = decodedStreams.join("");
    for (let offset = 0; offset < transcriptHex.length; offset += 4) {
        assert.include(decodedText, transcriptHex.slice(offset, offset + 4));
    }
    assert.isAbove(pdf.pageCount, 0);
});
