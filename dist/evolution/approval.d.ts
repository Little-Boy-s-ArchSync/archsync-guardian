export type ApprovalRisk = "low" | "medium" | "high" | "critical";
export type ApprovalDecision = "pending" | "accepted" | "rejected";
export interface ApprovalRecord {
    contract_version: "0.1";
    record_id: string;
    risk_level: ApprovalRisk;
    decision: ApprovalDecision;
    evidence_snapshot_sha256: string;
    scorecard_sha256: string;
    rationale: string;
    rollback_plan: string;
    approver?: {
        kind: "human";
        identity: string;
        role: string;
    };
    baseline_update_commit?: string;
}
export interface ApprovalValidation {
    valid: boolean;
    issues: string[];
}
export declare function createPendingApprovalRecord(input: {
    record_id: string;
    risk_level: ApprovalRisk;
    evidence_snapshot_sha256: string;
    scorecard: unknown;
    rationale: string;
    rollback_plan: string;
}): ApprovalRecord;
export declare function validateApprovalRecord(record: ApprovalRecord): ApprovalValidation;
//# sourceMappingURL=approval.d.ts.map