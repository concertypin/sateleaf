/** Reads a stream until it ends or errors, returning the text received and any failure. */
export async function readUntilEnd(
    stream: ReadableStream<Uint8Array>
): Promise<{ text: string; error: unknown }> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let text = "";
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return { text, error: undefined };
            text += decoder.decode(chunk.value, { stream: true });
        }
    } catch (error) {
        return { text, error };
    }
}

/** Parses the first non-comment `data:` line. */
export function firstData<T = unknown>(text: string): T {
    const line = text.split("\n").find((value) => value.startsWith("data: "));
    return JSON.parse(line!.slice(6)) as T;
}
