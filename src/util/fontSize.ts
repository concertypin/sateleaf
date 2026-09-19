export function isValidFontSize(value: number): value is FontSize {
    return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        value > 0 &&
        value <= 12
    );
}

export type FontSize = number & {
    __brand: "FontSize";
};
