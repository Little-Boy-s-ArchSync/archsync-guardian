const replacements = [
    [/(?:github_pat_|gh[opusr]_|glpat-)[A-Za-z0-9_-]{8,}/giu, "[REDACTED_TOKEN]", "credential"],
    [/(\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s,"']+/giu, "$1[REDACTED]", "credential"],
    [/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, "$1[REDACTED]", "credential"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]", "email"],
    [/(?:[A-Za-z]:\\|\/(?:Users|home)\/)[^\s"']+/gu, "[REDACTED_PATH]", "absolute-path"],
];
function redactValue(input) {
    const reasons = [];
    let value = input;
    for (const [pattern, replacement, reason] of replacements) {
        const next = value.replace(pattern, replacement);
        if (next !== value)
            reasons.push(reason);
        value = next;
    }
    return { value, reasons };
}
function isPortableAbsolutePath(value) {
    return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/u.test(value);
}
function redactField(input, evidenceId, field, events) {
    if (field === "file" && isPortableAbsolutePath(input)) {
        events.push({ evidence_id: evidenceId, field, reason: "absolute-path" });
        return "[REDACTED_PATH]";
    }
    const redacted = redactValue(input);
    events.push(...redacted.reasons.map((reason) => ({ evidence_id: evidenceId, field, reason })));
    return redacted.value;
}
export function redactOutboundEvidence(input) {
    const events = [];
    const evidence = input.map((item) => {
        const text = redactField(item.text, item.id, "text", events);
        const file = item.file === undefined ? undefined : redactField(item.file, item.id, "file", events);
        return { ...item, text, ...(file === undefined ? {} : { file }) };
    });
    return { evidence, events };
}
export function redactOutboundContext(finding, input) {
    const redacted = redactOutboundEvidence(input);
    return {
        finding: {
            ...finding,
            message: redactField(finding.message, `finding:${finding.id}`, "message", redacted.events),
        },
        evidence: redacted.evidence,
        events: redacted.events,
    };
}
/** Redact untrusted provider diagnostics before they enter a persisted run manifest. */
export function redactProviderDiagnostic(input) {
    return redactValue(input).value;
}
export function redactProviderArtifactPath(input) {
    return isPortableAbsolutePath(input) ? "[REDACTED_PATH]" : redactProviderDiagnostic(input);
}
//# sourceMappingURL=redaction.js.map