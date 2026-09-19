import { isValidFontSize, type FontSize } from "@/util/fontSize.js";
import { isMode, type Mode } from "@/util/mode.js";

const PROXY_PATH = /^\/proxy\/([^/]+)\/([^/]+)\/(.+)$/u;

export interface ProxyRoute {
    upstream: URL;
    mode: Mode;
    fontSize: FontSize;
    cachePdf: boolean;
}

/**
 * Reports whether a proxy path contains the configured shared secret.
 * A missing secret always rejects the request.
 */
export function hasValidProxySecret(
    pathname: string,
    expected: string | undefined
): boolean {
    return Boolean(expected && pathname.match(PROXY_PATH)?.[1] === expected);
}

/**
 * Parses `/proxy/{secret}/{settings}/{host/path}` into validated proxy options.
 * The secret is deliberately ignored here and must be checked separately.
 */
export function parseProxyRoute(pathname: string): ProxyRoute {
    const match = pathname.match(PROXY_PATH);
    const rawSettings = match?.[2];
    const endpoint = match?.[3];
    if (rawSettings === undefined || endpoint === undefined)
        throw new Error(
            "Expected /proxy/{secret}/{settings}/{upstream-host-and-path}"
        );
    if (
        endpoint.includes("\\") ||
        endpoint.startsWith("//") ||
        endpoint.includes("#")
    )
        throw new Error("Invalid upstream endpoint");

    const upstream = new URL(`https://${endpoint}`);
    if (!upstream.hostname || upstream.username || upstream.password)
        throw new Error("Invalid upstream endpoint");
    return { upstream, ...parseProxySettings(rawSettings) };
}

function parseProxySettings(
    raw: string
): Pick<ProxyRoute, "mode" | "fontSize" | "cachePdf"> {
    if (raw.includes("."))
        throw new Error("Proxy settings must not contain dots");

    let mode: Mode = "maximum";
    let fontSizeValue = 1;
    let cachePdf = true;
    for (const item of raw
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)) {
        const [key, ...rest] = item.split("=");
        if (!key) throw new Error("Proxy setting name is required");
        const value = rest.length ? rest.join("=").trim() : key;
        const legacyMode =
            /^mode_(maximum|balanced|marked|marked_combined)$/iu.exec(
                item
            )?.[1];
        const legacyFontSize = /^fontsize_(.+)$/iu.exec(item)?.[1];
        const normalizedLegacyMode = legacyMode?.toLowerCase();

        if (!rest.length && key.toLowerCase() === "nocache") cachePdf = false;
        else if (isMode(normalizedLegacyMode)) mode = normalizedLegacyMode;
        else if (!rest.length && isMode(value)) mode = value;
        else if (key.toLowerCase() === "mode" && isMode(value)) mode = value;
        else if (legacyFontSize !== undefined)
            fontSizeValue = parseFontSize(legacyFontSize);
        else if (key.toLowerCase() === "fontsize")
            fontSizeValue = parseFontSize(value);
        else throw new Error(`Unknown proxy setting: ${key}`);
    }

    if (!isValidFontSize(fontSizeValue))
        throw new Error("fontSize must be between 0 and 12");
    return { mode, fontSize: fontSizeValue, cachePdf };
}

function parseFontSize(raw: string): FontSize {
    const value = Number(raw);
    if (!isValidFontSize(value))
        throw new Error("fontSize must be between 0 and 12");
    return value;
}
