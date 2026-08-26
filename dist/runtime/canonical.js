import { createHash } from "node:crypto";
export function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalize(child)]));
    }
    return value;
}
export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}
export function sha256Canonical(value) {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
//# sourceMappingURL=canonical.js.map