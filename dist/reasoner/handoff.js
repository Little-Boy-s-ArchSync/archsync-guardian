import { createHash } from "node:crypto";
import { isReviewableRepairCandidate, validateRepairCandidateShape, } from "./contracts.js";
function canonicalCandidate(candidate) {
    return JSON.stringify({
        schema_version: candidate.schema_version,
        candidate_id: candidate.candidate_id,
        status: candidate.status,
        target_block_finding_fingerprints: [...candidate.target_block_finding_fingerprints].sort(),
        files: [...candidate.files].sort((left, right) => left.path.localeCompare(right.path)),
        unified_diff: candidate.unified_diff,
        rationale: candidate.rationale,
        expected_architecture_impact: candidate.expected_architecture_impact,
        risk: candidate.risk,
        verification_commands: candidate.verification_commands,
        rollback: candidate.rollback,
        verification: candidate.verification ?? null,
    });
}
function hasAcceptableVerification(handoff) {
    return handoff.candidate_status === "VERIFIED_FOR_REVIEW" &&
        handoff.verification?.decision === "ACCEPTABLE_FOR_REVIEW" &&
        handoff.verification.tests === "pass" &&
        handoff.verification.conformance === "pass" &&
        handoff.verification.safe_apply &&
        handoff.verification.new_blocking_findings === 0;
}
export function createReviewHandoff(handoffId, candidate, evidenceIds) {
    if (!handoffId.trim())
        throw new Error("handoff ID is required");
    const issues = validateRepairCandidateShape(candidate);
    if (issues.length > 0) {
        throw new Error(`repair candidate is invalid: ${issues.map(({ path }) => path).join(", ")}`);
    }
    if (candidate.status === "VERIFIED_FOR_REVIEW" && !isReviewableRepairCandidate(candidate)) {
        throw new Error("verified repair candidate does not satisfy the acceptable review invariants");
    }
    return {
        schema_version: 1,
        handoff_id: handoffId,
        candidate_hash: createHash("sha256").update(canonicalCandidate(candidate)).digest("hex"),
        candidate_status: candidate.status,
        risk: candidate.risk,
        evidence_ids: [...new Set(evidenceIds)].sort(),
        verification: candidate.verification ?? null,
        rollback: candidate.rollback,
        decision: null,
    };
}
export function recordHumanReview(handoff, input) {
    if (handoff.decision)
        throw new Error("review handoff already has an immutable decision");
    if (input.actor_type !== "human")
        throw new Error("actor_type must be human");
    if (!(input.outcome === "approved" || input.outcome === "rejected" || input.outcome === "inconclusive")) {
        throw new Error("outcome must be approved, rejected, or inconclusive");
    }
    for (const [name, value] of Object.entries(input)) {
        if (typeof value !== "string" || value.trim().length === 0)
            throw new Error(`${name} is required`);
    }
    if (input.outcome === "approved" && !hasAcceptableVerification(handoff)) {
        throw new Error("only an exactly verified candidate can be approved");
    }
    return { ...handoff, decision: { ...input } };
}
export function isHumanApproved(handoff) {
    return handoff.decision?.actor_type === "human" && handoff.decision.outcome === "approved" &&
        hasAcceptableVerification(handoff);
}
//# sourceMappingURL=handoff.js.map