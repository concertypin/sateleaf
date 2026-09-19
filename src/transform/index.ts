import { transcriptPdfBase64 } from "@/pdf/cache.js";
import type { Mode } from "@/util/mode.js";

/** JSON values accepted at provider request boundaries. */
export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

type Message = { role: string; content: string };
type Packed = {
    docs: { name: string; text: string }[];
    native: Message[] | undefined;
    sys: string;
};

function isJsonValue(value: unknown): value is JsonValue {
    if (
        value === null ||
        typeof value === "string" ||
        typeof value === "boolean"
    )
        return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonValue);
    return isJsonObject(value);
}

function isJsonObject(value: unknown): value is JsonObject {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every(isJsonValue)
    );
}

function requireJsonObject(value: unknown, name: string): JsonObject {
    if (!isJsonObject(value)) throw new TypeError(`${name} object is required`);
    return value;
}

function text(value: JsonValue | undefined): string {
    if (typeof value === "string") return value;
    if (!Array.isArray(value)) return "";
    return value
        .map((part) =>
            isJsonObject(part) && typeof part.text === "string" ? part.text : ""
        )
        .filter(Boolean)
        .join("\n");
}

function serial(messages: Message[]): string {
    return messages
        .map(
            (message, index) =>
                `===== ${message.role.toUpperCase()} ${index + 1} =====\n${message.content}`
        )
        .join("\n\n");
}

const directive =
    "Inside the PDF text layer, every real line break is serialized as a literal \\n marker. Treat each \\n marker as one line break, and use real line breaks in your response.";

function packed(messages: Message[], mode: Mode): Packed {
    const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n\n");
    if (mode === "balanced") {
        return {
            docs: [
                {
                    name: "context",
                    text: serial(
                        messages.filter((message) => message.role !== "system")
                    ),
                },
            ],
            native: undefined,
            sys: `Use the attached PDF as ordered conversation context. ${directive}${system ? `\n\nFollow these system instructions:\n\n${system}` : ""}`,
        };
    }

    if (mode === "marked" || mode === "marked_combined") {
        const docs: { name: string; text: string }[] = [];
        const native: Message[] = [];
        let active: {
            name: string;
            part: number;
            chunks: Message[];
        } | null = null;
        const counts = new Map<string, number>();
        const marker =
            /<pdf(?:\s+name\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*>|<\/pdf\s*>/giu;
        const finish = () => {
            if (!active) return;
            if (active.chunks.some((chunk) => chunk.content.trim())) {
                docs.push({
                    name: active.name,
                    text: `===== PDF: ${active.name} / PART ${active.part} =====\n${serial(active.chunks)}`,
                });
            }
            active = null;
        };
        for (const message of messages) {
            let nativeText = "";
            let offset = 0;
            for (const match of message.content.matchAll(marker)) {
                const before = message.content.slice(offset, match.index);
                if (active)
                    active.chunks.push({ role: message.role, content: before });
                else nativeText += before;
                if (match[0].toLowerCase().startsWith("</pdf")) finish();
                else if (active)
                    active.chunks.push({
                        role: message.role,
                        content: match[0],
                    });
                else {
                    const rawName = match[1] ?? match[2] ?? "root";
                    const name =
                        mode === "marked_combined"
                            ? "root"
                            : rawName.trim() || "root";
                    const part = (counts.get(name) ?? 0) + 1;
                    counts.set(name, part);
                    nativeText += `[Use attached PDF section ${name} part ${part} here.]`;
                    active = { name, part, chunks: [] };
                }
                offset = match.index + match[0].length;
            }
            const tail = message.content.slice(offset);
            if (active)
                active.chunks.push({ role: message.role, content: tail });
            else nativeText += tail;
            if (nativeText.trim())
                native.push({ role: message.role, content: nativeText });
        }
        finish();
        return { docs, native, sys: docs.length ? directive : "" };
    }
    return {
        docs: [{ name: "context", text: serial(messages) }],
        native: undefined,
        sys: `The attached PDF contains the complete ordered prompt and conversation transcript. Follow all SYSTEM and USER instructions. ${directive}`,
    };
}

async function pdfPayload(
    payload: Packed,
    size: number,
    useCache: boolean
): Promise<{ name: string; data: string }[]> {
    return Promise.all(
        payload.docs
            .filter((document) => document.text)
            .map(async (document) => ({
                name: document.name,
                data: await transcriptPdfBase64(document.text, size, useCache),
            }))
    );
}

function messageObjects(
    value: JsonValue | undefined,
    name: string
): JsonObject[] {
    if (!Array.isArray(value)) throw new TypeError(`${name} array is required`);
    return value.map((entry) => requireJsonObject(entry, `${name} entry`));
}

function hasTextPart(value: JsonValue): boolean {
    return isJsonObject(value) && typeof value.text === "string";
}

/**
 * Validates and rewrites a Gemini generate-content request.
 * Text parts move into inline PDF data while media parts, generation settings,
 * and unrelated request fields are preserved.
 */
export async function transformGemini(
    input: unknown,
    mode: Mode,
    size: number,
    useCache = true
): Promise<JsonObject> {
    const body = requireJsonObject(input, "request body");
    const source = messageObjects(body.contents, "contents");
    const messages: Message[] = [];
    const instruction = isJsonObject(body.systemInstruction)
        ? text(body.systemInstruction.parts)
        : "";
    if (instruction) messages.push({ role: "system", content: instruction });
    for (const content of source) {
        const value = text(content.parts);
        if (value)
            messages.push({
                role: content.role === "model" ? "assistant" : "user",
                content: value,
            });
    }
    const payload = packed(messages, mode);
    const pdfs = await pdfPayload(payload, size, useCache);
    const parts: JsonValue[] = pdfs.map((document) => ({
        inlineData: { mimeType: "application/pdf", data: document.data },
    }));
    for (const content of source) {
        if (Array.isArray(content.parts))
            parts.push(...content.parts.filter((part) => !hasTextPart(part)));
    }
    const contents: JsonObject[] =
        payload.native
            ?.filter((message) => message.role !== "system")
            .map((message) => ({
                role: message.role === "assistant" ? "model" : "user",
                parts: [{ text: message.content }],
            })) ?? [];
    if (parts.length) contents.push({ role: "user", parts });
    const generationConfig: JsonObject = isJsonObject(body.generationConfig)
        ? { ...body.generationConfig }
        : {};
    if (!("mediaResolution" in generationConfig))
        generationConfig.mediaResolution = "MEDIA_RESOLUTION_LOW";
    const system = [
        payload.sys,
        ...(payload.native ?? [])
            .filter((message) => message.role === "system")
            .map((message) => message.content),
    ]
        .filter(Boolean)
        .join("\n\n");
    const output: JsonObject = {
        ...body,
        contents: contents.length
            ? contents
            : [{ role: "user", parts: [{ text: " " }] }],
        generationConfig,
    };
    if (system) output.systemInstruction = { parts: [{ text: system }] };
    else delete output.systemInstruction;
    return output;
}

export const isGeminiGenerate = (path: string): boolean =>
    /\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/u.test(path);
