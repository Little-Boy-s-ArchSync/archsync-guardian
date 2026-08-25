const replacements = [
    [/(?:github_pat_|gh[opusr]_|glpat-)[A-Za-z0-9_-]{8,}/giu, "[REDACTED_TOKEN]", "credential"],
    [/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{8,}\b/giu, "[REDACTED_TOKEN]", "credential"],
    [/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret)\s*[:=]\s*["']?)[^\s,"']+/giu, "$1[REDACTED]", "credential"],
    [/(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/giu, "$1[REDACTED]", "credential"],
    [/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/giu, "$1[REDACTED]@", "credential"],
    [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[REDACTED_EMAIL]", "email"],
    [/(^|[\s("'=:\[{])\/(?!\/)[^\s"',;)}\]]+/gmu, "$1[REDACTED_PATH]", "absolute-path"],
    [/(^|[\s("'=:\[{])[A-Za-z]:[\\/][^\s"',;)}\]]+/gmu, "$1[REDACTED_PATH]", "absolute-path"],
    [/(^|[\s("'=:\[{])\\\\[^\s"',;)}\]]+/gmu, "$1[REDACTED_PATH]", "absolute-path"],
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
    const reservedIds = new Set(input.map(({ id }) => id));
    const emittedIds = new Set();
    const evidence = input.map((item, index) => {
        const redactedId = redactValue(item.id);
        let id = redactedId.value;
        if (redactedId.reasons.length > 0) {
            let suffix = index + 1;
            do {
                id = `[REDACTED_EVIDENCE_ID_${suffix}]`;
                suffix += 1;
            } while (reservedIds.has(id) || emittedIds.has(id));
        }
        emittedIds.add(id);
        events.push(...redactedId.reasons.map((reason) => ({ evidence_id: id, field: "id", reason })));
        const text = redactField(item.text, id, "text", events);
        const file = item.file === undefined ? undefined : redactField(item.file, id, "file", events);
        const ruleId = item.rule_id === undefined ? undefined : redactField(item.rule_id, id, "rule_id", events);
        return {
            ...item,
            id,
            text,
            ...(file === undefined ? {} : { file }),
            ...(ruleId === undefined ? {} : { rule_id: ruleId }),
        };
    });
    return { evidence, events };
}
export function redactOutboundContext(finding, input) {
    const redacted = redactOutboundEvidence(input);
    const redactedFindingId = redactValue(finding.id);
    const id = redactedFindingId.reasons.length === 0 ? redactedFindingId.value : "[REDACTED_FINDING_ID]";
    redacted.events.push(...redactedFindingId.reasons.map((reason) => ({
        evidence_id: id,
        field: "id",
        reason,
    })));
    return {
        finding: {
            ...finding,
            id,
            kind: redactField(finding.kind, `finding:${id}`, "kind", redacted.events),
            message: redactField(finding.message, `finding:${id}`, "message", redacted.events),
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