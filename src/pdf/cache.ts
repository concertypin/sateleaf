import { createHash } from "node:crypto";
import {
    mkdir,
    open,
    readdir,
    readFile,
    rm,
    stat,
    utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTranscriptPdf } from "./index.js";

const CACHE_FORMAT_VERSION = "transcript-pdf-v1";
const CACHE_DIRECTORY = join(tmpdir(), "sateleaf-pdf-cache-v1");
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Returns a deterministic PDF encoding, optionally reusing a bounded temporary
 * file. Filenames contain only salted digests; file contents retain transformed
 * prompt data until eviction, so `nocache` callers bypass all filesystem access.
 */
export async function transcriptPdfBase64(
    transcript: string,
    fontSize: number,
    useCache: boolean
): Promise<string> {
    if (!useCache)
        return Buffer.from(
            generateTranscriptPdf(transcript, fontSize).bytes
        ).toString("base64");

    const key = cacheKey(transcript, fontSize);
    const path = join(CACHE_DIRECTORY, `${key}.pdf`);
    const now = new Date();
    try {
        const cached = await readFreshEntry(path, now.getTime());
        if (cached) {
            await utimes(path, now, now);
            return cached.toString("base64");
        }
    } catch {
        // A cache miss or unavailable temporary directory must not fail a request.
    }

    const pdf = Buffer.from(generateTranscriptPdf(transcript, fontSize).bytes);
    if (pdf.byteLength <= MAX_ENTRY_BYTES) {
        try {
            await mkdir(CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
            await evictEntries(now.getTime(), pdf.byteLength);
            const file = await open(path, "w", 0o600);
            try {
                await file.writeFile(pdf);
            } finally {
                await file.close();
            }
        } catch {
            // PDF generation remains useful even when caching is unavailable.
        }
    }
    return pdf.toString("base64");
}

function cacheKey(transcript: string, fontSize: number): string {
    return createHash("sha256")
        .update("sateleaf-pdf-cache-key\0")
        .update(CACHE_FORMAT_VERSION)
        .update("\0")
        .update(String(fontSize))
        .update("\0")
        .update(transcript)
        .digest("hex");
}

async function readFreshEntry(
    path: string,
    now: number
): Promise<Buffer | undefined> {
    const metadata = await stat(path);
    if (now - metadata.mtimeMs > CACHE_TTL_MS) {
        await rm(path, { force: true });
        return undefined;
    }
    return readFile(path);
}

async function evictEntries(now: number, incomingBytes: number): Promise<void> {
    const names = await readdir(CACHE_DIRECTORY);
    const entries = await Promise.all(
        names
            .filter((name) => name.endsWith(".pdf"))
            .map(async (name) => {
                const path = join(CACHE_DIRECTORY, name);
                const metadata = await stat(path);
                return {
                    path,
                    bytes: metadata.size,
                    modifiedAt: metadata.mtimeMs,
                };
            })
    );

    let totalBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    let totalEntries = entries.length;
    for (const entry of entries.sort(
        (left, right) => left.modifiedAt - right.modifiedAt
    )) {
        if (
            now - entry.modifiedAt <= CACHE_TTL_MS &&
            totalEntries < MAX_CACHE_ENTRIES &&
            totalBytes + incomingBytes <= MAX_CACHE_BYTES
        )
            break;
        await rm(entry.path, { force: true });
        totalBytes -= entry.bytes;
        totalEntries -= 1;
    }
}
