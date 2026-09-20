import { createHash, randomUUID } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    utimes,
    writeFile,
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
let cacheMutationQueue = Promise.resolve();

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
            (await generateTranscriptPdf(transcript, fontSize)).bytes
        ).toString("base64");

    const key = cacheKey(transcript, fontSize);
    const path = join(CACHE_DIRECTORY, `${key}.pdf`);
    const now = new Date();
    let cacheAvailable = false;
    try {
        await ensureCacheDirectory();
        cacheAvailable = true;
        const cached = await readFreshEntry(path, now.getTime());
        if (cached) {
            try {
                await utimes(path, now, now);
            } catch {
                // A valid PDF remains reusable when only LRU metadata fails.
            }
            return cached.toString("base64");
        }
    } catch {
        // A cache miss or unavailable temporary directory must not fail a request.
    }

    const pdf = Buffer.from(
        (await generateTranscriptPdf(transcript, fontSize)).bytes
    );
    if (cacheAvailable && pdf.byteLength <= MAX_ENTRY_BYTES) {
        const temporaryPath = join(
            CACHE_DIRECTORY,
            `${key}.${randomUUID()}.tmp`
        );
        try {
            await queueCacheWrite(path, temporaryPath, pdf, now.getTime());
        } catch {
            // PDF generation remains useful even when caching is unavailable.
        } finally {
            await rm(temporaryPath, { force: true }).catch(() => undefined);
        }
    }
    return pdf.toString("base64");
}

async function ensureCacheDirectory(): Promise<void> {
    await mkdir(CACHE_DIRECTORY, { recursive: true, mode: 0o700 });
    const metadata = await lstat(CACHE_DIRECTORY);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Unsafe PDF cache directory");
    const userId = process.getuid?.();
    if (userId !== undefined && metadata.uid !== userId)
        throw new Error("PDF cache directory has an unexpected owner");
    await chmod(CACHE_DIRECTORY, 0o700);
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
    const metadata = await lstat(path);
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size <= 0 ||
        metadata.size > MAX_ENTRY_BYTES ||
        now - metadata.mtimeMs > CACHE_TTL_MS
    ) {
        await rm(path, { force: true });
        return undefined;
    }
    return readFile(path);
}

function queueCacheWrite(
    path: string,
    temporaryPath: string,
    pdf: Buffer,
    now: number
): Promise<void> {
    const operation = cacheMutationQueue.then(async () => {
        await evictEntries(now, pdf.byteLength);
        await writeFile(temporaryPath, pdf, { flag: "wx", mode: 0o600 });
        await rename(temporaryPath, path);
    });
    cacheMutationQueue = operation.catch(() => undefined);
    return operation;
}

function isMissingFileError(
    error: unknown
): error is Error & { code: "ENOENT" } {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function evictEntries(now: number, incomingBytes: number): Promise<void> {
    const names = await readdir(CACHE_DIRECTORY);
    const entries = await Promise.all(
        names
            .filter((name) => name.endsWith(".pdf"))
            .map(async (name) => {
                const path = join(CACHE_DIRECTORY, name);
                try {
                    const metadata = await stat(path);
                    return {
                        path,
                        bytes: metadata.size,
                        modifiedAt: metadata.mtimeMs,
                    };
                } catch (error) {
                    if (isMissingFileError(error)) return undefined;
                    throw error;
                }
            })
    ).then((candidates) =>
        candidates.filter((candidate) => candidate !== undefined)
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
