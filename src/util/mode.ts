export type Mode = "maximum" | "balanced" | "marked" | "marked_combined";

export function isMode(value: unknown): value is Mode {
    return (
        value === "maximum" ||
        value === "balanced" ||
        value === "marked" ||
        value === "marked_combined"
    );
}
