import { isValidFontSize, type FontSize } from "@/util/fontSize.js";
import { isMode, type Mode } from "@/util/mode.js";

const PROXY_PATH = /^\/proxy\/([^/]+)\/([^/]+)\/(.+)$/u;

export interface ProxyRoute {
    upstream: URL;
    mode: Mode;
    fontSize: FontSize;
    cachePdf: boolean;
    keepalive: boolean;
    earlyKeepalive: boolean;
    /** Allow Gemini 4 and later, where PDF folding no longer saves tokens */
    allowGemini4: boolean;
}

const GEMINI_MAJOR = /^(?:models\/)?gemini-(\d+)/iu;

/**
 * Reports whether a model is Gemini 4 or later. Those models no longer bill
 * PDF pages below their text-token cost, so folding stops paying off.
 */
export function isGemini4OrLater(model: string): boolean {
    const major = GEMINI_MAJOR.exec(model)?.[1];
    return major !== undefined && Number(major) >= 4;
}

/** The model segment of a native `…/models/{model}:method` path, if any. */
export function nativeModel(pathname: string): string | undefined {
    const raw = /\/models\/([^/:]+):[^/]+$/u.exec(pathname)?.[1];
    if (raw === undefined) return undefined;
    try {
        // Percent-encoding must not slip a model past the Gemini 4 gate.
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

/**
 * Reports whether a proxy path contains the configured shared secret.
 * A missing secret always rejects the request.
 */
export function hasValidProxySecret(
    pathname: string,
    expected: string | undefined
): boolean {
    const actual = pathname.match(PROXY_PATH)?.[1];
    if (!actual || !expected) return false;

    return expected
        .split(",")
        .map((secret) => secret.trim())
        .filter(Boolean)
        .includes(actual);
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
): Pick<
    ProxyRoute,
    | "mode"
    | "fontSize"
    | "cachePdf"
    | "keepalive"
    | "earlyKeepalive"
    | "allowGemini4"
> {
    if (raw.includes("."))
        throw new Error("Proxy settings must not contain dots");

    let mode: Mode = "maximum";
    let fontSizeValue = 1;
    let cachePdf = true;
    let keepalive = true;
    let earlyKeepalive = false;
    let allowGemini4 = false;
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
        else if (!rest.length && key.toLowerCase() === "nokeepalive")
            keepalive = false;
        else if (!rest.length && key.toLowerCase() === "earlykeepalive")
            earlyKeepalive = true;
        else if (!rest.length && key.toLowerCase() === "allowgemini4")
            allowGemini4 = true;
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
    if (!keepalive && earlyKeepalive)
        throw new Error("nokeepalive and earlykeepalive cannot be combined");
    return {
        mode,
        fontSize: fontSizeValue,
        cachePdf,
        keepalive,
        earlyKeepalive,
        allowGemini4,
    };
}

function parseFontSize(raw: string): FontSize {
    const value = Number(raw);
    if (!isValidFontSize(value))
        throw new Error("fontSize must be between 0 and 12");
    return value;
}
