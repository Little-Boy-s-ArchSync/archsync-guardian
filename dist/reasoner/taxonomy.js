export function classifyRootCause(finding) {
    const text = `${finding.kind} ${finding.message}`.toLowerCase();
    if (finding.detector_confidence !== undefined && finding.detector_confidence < 0.8) {
        return { code: "detector-uncertainty", reason: "Source detector confidence is below 0.8." };
    }
    if (/invalid|configuration|schema|version/u.test(text)) {
        return { code: "configuration-error", reason: "The finding reports invalid configuration or contract input." };
    }
    if (/pre-existing|baseline|removed component|missing baseline|missing from the observed architecture|removed from the observed architecture/u.test(text)) {
        return { code: "stale-baseline", reason: "Observed and approved baseline state are out of sync." };
    }
    if (/require|missing dependency|missing path/u.test(text) || finding.rule_id?.startsWith("REQ-") === true) {
        return { code: "missing-required-dependency", reason: "A required architecture dependency or path is absent." };
    }
    if (/evolution|new (?:database|cache|queue|broker|service)|unexpected infrastructure/u.test(text)) {
        return { code: "new-infrastructure", reason: "The observed graph introduces infrastructure not present in the baseline." };
    }
    if (/bypass|forbidden|deny|direct dependency/u.test(text) || finding.rule_id?.startsWith("ARCH-") === true) {
        return { code: "boundary-bypass", reason: "A source dependency crosses an enforced architecture boundary." };
    }
    return { code: "unknown", reason: "No taxonomy rule matched; retain the case for human classification." };
}
//# sourceMappingURL=taxonomy.js.map