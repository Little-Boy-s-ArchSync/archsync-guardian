export const explanationContractVersion = "0.1";
export const repairCandidateContractVersion = "0.1";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireString(value, key, path, issues) {
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
        issues.push({ path: `${path}/${key}`, message: "must be a non-empty string" });
    }
}
export function validateExplanationShape(value) {
    const issues = [];
    if (!isRecord(value))
        return [{ path: "/", message: "must be an object" }];
    if (value.contract_version !== explanationContractVersion) {
        issues.push({ path: "/contract_version", message: `must equal ${explanationContractVersion}` });
    }
    for (const key of ["summary", "root_cause", "recommended_next_action"]) {
        requireString(value, key, "", issues);
    }
    if (!Array.isArray(value.claims) || value.claims.length === 0) {
        issues.push({ path: "/claims", message: "must contain at least one claim" });
    }
    else {
        value.claims.forEach((claim, index) => {
            if (!isRecord(claim)) {
                issues.push({ path: `/claims/${index}`, message: "must be an object" });
                return;
            }
            requireString(claim, "text", `/claims/${index}`, issues);
            if (!Array.isArray(claim.citations) || claim.citations.length === 0 ||
                claim.citations.some((citation) => typeof citation !== "string" || citation.length === 0)) {
                issues.push({ path: `/claims/${index}/citations`, message: "must contain evidence IDs" });
            }
        });
    }
    if (!isRecord(value.uncertainty)) {
        issues.push({ path: "/uncertainty", message: "must be an object" });
    }
    else {
        if (!["low", "medium", "high"].includes(value.uncertainty.level)) {
            issues.push({ path: "/uncertainty/level", message: "must be low, medium, or high" });
        }
        requireString(value.uncertainty, "reason", "/uncertainty", issues);
    }
    if (!isRecord(value.model_provenance)) {
        issues.push({ path: "/model_provenance", message: "must be an object" });
    }
    else {
        for (const key of ["provider", "model", "prompt_version", "request_hash"]) {
            requireString(value.model_provenance, key, "/model_provenance", issues);
        }
    }
    return issues;
}
export function validateRepairCandidateShape(value) {
    const issues = [];
    if (!isRecord(value))
        return [{ path: "/", message: "must be an object" }];
    if (value.contract_version !== repairCandidateContractVersion) {
        issues.push({ path: "/contract_version", message: `must equal ${repairCandidateContractVersion}` });
    }
    if (!["PROPOSED", "VERIFIED_FOR_REVIEW"].includes(value.status)) {
        issues.push({ path: "/status", message: "must be PROPOSED or VERIFIED_FOR_REVIEW" });
    }
    for (const key of ["patch", "rationale", "expected_architecture_impact", "rollback"]) {
        requireString(value, key, "", issues);
    }
    for (const key of ["target_files", "verification_commands"]) {
        const entries = value[key];
        if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry.length === 0)) {
            issues.push({ path: `/${key}`, message: "must contain non-empty strings" });
        }
    }
    if (!["low", "medium", "high", "critical"].includes(value.risk)) {
        issues.push({ path: "/risk", message: "must be low, medium, high, or critical" });
    }
    if (value.status === "VERIFIED_FOR_REVIEW" && !isRecord(value.verification)) {
        issues.push({ path: "/verification", message: "is required before review" });
    }
    return issues;
}
export function isReviewableRepairCandidate(candidate) {
    return candidate.status === "VERIFIED_FOR_REVIEW" && candidate.verification !== undefined &&
        candidate.verification.safe_apply && candidate.verification.tests === "pass" &&
        candidate.verification.conformance === "pass" && candidate.verification.new_blocking_findings === 0;
}
//# sourceMappingURL=contracts.js.map