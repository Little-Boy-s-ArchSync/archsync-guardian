import { sha256Canonical } from "../runtime/canonical.js";
const sha256Pattern = /^[0-9a-f]{64}$/u;
const gitCommitPattern = /^[0-9a-f]{40}$/u;
export function createPendingApprovalRecord(input) {
    return {
        contract_version: "0.1",
        record_id: input.record_id,
        risk_level: input.risk_level,
        decision: "pending",
        evidence_snapshot_sha256: input.evidence_snapshot_sha256,
        scorecard_sha256: sha256Canonical(input.scorecard),
        rationale: input.rationale,
        rollback_plan: input.rollback_plan,
    };
}
export function validateApprovalRecord(record) {
    const issues = [];
    if (record.contract_version !== "0.1")
        issues.push("contract_version must be 0.1");
    if (record.record_id.length === 0)
        issues.push("record_id is required");
    if (!sha256Pattern.test(record.evidence_snapshot_sha256)) {
        issues.push("evidence_snapshot_sha256 must be a lowercase SHA-256 digest");
    }
    if (!sha256Pattern.test(record.scorecard_sha256)) {
        issues.push("scorecard_sha256 must be a lowercase SHA-256 digest");
    }
    if (record.rationale.length === 0)
        issues.push("rationale is required");
    if (record.rollback_plan.length === 0)
        issues.push("rollback_plan is required");
    if (record.decision === "accepted") {
        if (record.approver?.kind !== "human" || record.approver.identity.length === 0 || record.approver.role.length === 0) {
            issues.push("accepted decisions require an identified human approver and role");
        }
        if (record.baseline_update_commit === undefined || !gitCommitPattern.test(record.baseline_update_commit)) {
            issues.push("accepted decisions require the exact 40-character baseline update commit");
        }
    }
    if (record.decision === "pending" && (record.approver !== undefined || record.baseline_update_commit !== undefined)) {
        issues.push("pending decisions must not claim an approver or baseline update");
    }
    return { valid: issues.length === 0, issues };
}
//# sourceMappingURL=approval.js.map