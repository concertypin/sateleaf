const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const textEncoder = new TextEncoder();

/** Encodes PDF syntax and text as UTF-8 bytes. */
function encodeText(value: string): Uint8Array<ArrayBuffer> {
    return textEncoder.encode(value);
}

/** Concatenates byte chunks without converting binary data to strings. */
function concatBytes(chunks: Uint8Array[]): Uint8Array {
    const output = new Uint8Array(
        chunks.reduce((length, chunk) => length + chunk.length, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.length;
    }
    return output;
}

/** Formats a UTF-16 code unit or PDF character ID as four hex digits. */
function fourDigitHex(value: number): string {
    return value.toString(16).toUpperCase().padStart(4, "0");
}

/** Emits a compact decimal accepted by PDF content streams. */
function pdfNumber(value: number): string {
    return Number(value.toFixed(6)).toString();
}

function buildCharacterMap(lines: string[][]): Map<string, number> {
    const characters = new Map<string, number>();
    for (const line of lines) {
        for (const character of line) {
            if (characters.has(character)) continue;
            if (characters.size >= 65_535)
                throw new RangeError("Too many distinct PDF characters");
            characters.set(character, characters.size + 1);
        }
    }
    return characters;
}

/** Converts a Unicode code point into the UTF-16BE form used by ToUnicode. */
function unicodeHex(character: string): string {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined)
        throw new RangeError("Cannot encode an empty character");
    return codePoint <= 65_535
        ? fourDigitHex(codePoint)
        : fourDigitHex(55_296 + ((codePoint - 65_536) >> 10)) +
              fourDigitHex(56_320 + ((codePoint - 65_536) & 1_023));
}

function wrapText(text: string, columns: number): string[][] {
    const lines: string[][] = [];
    for (const rawLine of text.replaceAll(/\r\n?/g, "\n").split("\n")) {
        const characters = Array.from(rawLine);
        if (!characters.length) lines.push([]);
        for (let index = 0; index < characters.length; index += columns)
            lines.push(characters.slice(index, index + columns));
    }
    return lines;
}

function requireCharacterId(
    characters: Map<string, number>,
    character: string
): number {
    const id = characters.get(character);
    if (id === undefined) throw new Error("PDF character mapping is missing");
    return id;
}

/** Wraps CompressionStream output in a PDF stream object. */
async function createCompressedStream(
    data: Uint8Array<ArrayBuffer>
): Promise<Uint8Array> {
    const body = new Response(data).body;
    if (!body) throw new Error("Unable to create compression stream");
    const compressed = new Uint8Array(
        await new Response(
            body.pipeThrough(new CompressionStream("deflate"))
        ).arrayBuffer()
    );
    return concatBytes([
        encodeText(
            `<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`
        ),
        compressed,
        encodeText("\nendstream"),
    ]);
}

/** Serializes indirect objects and builds the matching xref table. */
function serializePdf(objects: Uint8Array[]): Uint8Array {
    const header = concatBytes([
        encodeText("%PDF-1.7\n%"),
        new Uint8Array([255, 255, 255, 255]),
        encodeText("\n"),
    ]);
    const chunks = [header];
    const offsets = [0];
    let length = header.length;

    for (const [index, object] of objects.entries()) {
        offsets.push(length);
        const chunk = concatBytes([
            encodeText(`${index + 1} 0 obj\n`),
            object,
            encodeText("\nendobj\n"),
        ]);
        chunks.push(chunk);
        length += chunk.length;
    }
    chunks.push(
        encodeText(
            [
                `xref\n0 ${objects.length + 1}`,
                "0000000000 65535 f ",
                ...offsets
                    .slice(1)
                    .map(
                        (offset) =>
                            `${offset.toString().padStart(10, "0")} 00000 n `
                    ),
                "trailer",
                `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
                "startxref",
                String(length),
                "%%EOF",
            ].join("\n")
        )
    );
    return concatBytes(chunks);
}

export interface TranscriptPdf {
    bytes: Uint8Array;
    pageCount: number;
}

/**
 * Generates a compact searchable PDF containing a serialized conversation.
 * Newlines are stored as literal `\\n` markers so models can reconstruct the
 * original text after reading the PDF text layer.
 */
export async function generateTranscriptPdf(
    transcript: string,
    fontSize = 1,
    margin = 0
): Promise<TranscriptPdf> {
    if (
        !Number.isFinite(fontSize) ||
        fontSize <= 0 ||
        !Number.isFinite(margin) ||
        margin < 0
    )
        throw new RangeError("Invalid PDF dimensions");

    const columns = Math.floor((PAGE_WIDTH - margin * 2) / (fontSize * 0.5));
    const rows = Math.floor((PAGE_HEIGHT - margin * 2) / fontSize);
    if (columns < 1 || rows < 1) throw new RangeError("No usable page area");

    const lines = wrapText(
        transcript
            .replaceAll("\r\n", "\n")
            .replaceAll("\r", "\n")
            .replaceAll("\n", "\\n"),
        columns
    );
    const pages: string[][][] = [];
    for (let index = 0; index < lines.length; index += rows)
        pages.push(lines.slice(index, index + rows));

    const characters = buildCharacterMap(lines);
    const unicodeMappings = Array.from(
        characters,
        ([character, id]) => `<${fourDigitHex(id)}><${unicodeHex(character)}>`
    );
    const mappingBlocks: string[] = [];
    for (let index = 0; index < unicodeMappings.length; index += 100) {
        mappingBlocks.push(
            `${Math.min(100, unicodeMappings.length - index)} beginbfchar\n${unicodeMappings.slice(index, index + 100).join("\n")}\nendbfchar`
        );
    }
    const unicodeMap = encodeText(
        [
            "/CIDInit /ProcSet findresource begin",
            "12 dict begin",
            "begincmap",
            "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
            "/CMapName /PMUnicode-UCS def",
            "/CMapType 2 def",
            "1 begincodespacerange",
            "<0000><FFFF>",
            "endcodespacerange",
            ...mappingBlocks,
            "endcmap",
            "CMapName currentdict /CMap defineresource pop",
            "end",
            "end",
        ].join("\n")
    );

    const pageIds = pages.map((_, index) => 7 + index * 2);
    const objects: Uint8Array[] = [
        encodeText("<< /Type /Catalog /Pages 2 0 R >>"),
        encodeText(
            `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F0 3 0 R >> >> >>`
        ),
        encodeText(
            "<< /Type /Font /Subtype /Type0 /BaseFont /PMUnicode /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 6 0 R >>"
        ),
        encodeText(
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /PMUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /DW 500 /CIDToGIDMap /Identity >>"
        ),
        encodeText(
            "<< /Type /FontDescriptor /FontName /PMUnicode /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 500 >>"
        ),
        await createCompressedStream(unicodeMap),
    ];

    for (const [index, page] of pages.entries()) {
        const pageId = pageIds[index];
        if (pageId === undefined)
            throw new Error("PDF page identifier is missing");
        const commands = [
            "BT",
            `/F0 ${pdfNumber(fontSize)} Tf`,
            `${pdfNumber(fontSize)} TL`,
            `1 0 0 1 ${pdfNumber(margin)} ${pdfNumber(PAGE_HEIGHT - margin - fontSize)} Tm`,
        ];
        for (const [lineIndex, line] of page.entries()) {
            commands.push(
                `<${line
                    .map((character) =>
                        fourDigitHex(requireCharacterId(characters, character))
                    )
                    .join("")}> Tj`
            );
            if (lineIndex < page.length - 1) commands.push("T*");
        }
        commands.push("ET");
        objects.push(
            encodeText(
                `<< /Type /Page /Parent 2 0 R /Contents ${pageId + 1} 0 R >>`
            ),
            await createCompressedStream(encodeText(commands.join("\n")))
        );
    }

    return { bytes: serializePdf(objects), pageCount: pages.length };
}
