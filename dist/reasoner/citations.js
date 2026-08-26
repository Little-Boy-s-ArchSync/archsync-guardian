export function validateExplanationCitations(explanation, suppliedEvidence) {
    const evidence = new Map(suppliedEvidence.map((item) => [item.id, item]));
    const issues = [];
    let unsupported = 0;
    explanation.claims.forEach((claim, index) => {
        if (claim.citations.length === 0) {
            unsupported += 1;
            issues.push({ claim: index, message: "claim has no evidence citation" });
            return;
        }
        const unique = new Set();
        let supported = false;
        for (const citation of claim.citations) {
            if (unique.has(citation)) {
                issues.push({ claim: index, citation, message: "duplicate citation" });
                continue;
            }
            unique.add(citation);
            const item = evidence.get(citation);
            if (!item) {
                issues.push({ claim: index, citation, message: "citation was not supplied to the provider" });
                continue;
            }
            const location = claim.source_location;
            if (location &&
                ((location.file !== undefined && location.file !== item.file) ||
                    (location.line !== undefined && location.line !== item.line) ||
                    (location.rule_id !== undefined && location.rule_id !== item.rule_id))) {
                issues.push({ claim: index, citation, message: "quoted file, line, or rule does not match evidence" });
                continue;
            }
            supported = true;
        }
        if (!supported)
            unsupported += 1;
    });
    return { valid: issues.length === 0, unsupported_claims: unsupported, issues };
}
//# sourceMappingURL=citations.js.map