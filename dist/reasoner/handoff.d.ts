import { type RepairCandidate, type RepairRisk } from "./contracts.js";
export interface ReviewHandoff {
    schema_version: 1;
    handoff_id: string;
    candidate_hash: string;
    candidate_status: RepairCandidate["status"];
    risk: RepairRisk;
    evidence_ids: string[];
    verification: RepairCandidate["verification"] | null;
    filesystem_isolation: null | {
        status: "approved" | "not-approved";
        attestation_sha256: string | null;
    };
    rollback: string;
    decision: null | {
        actor_type: "human";
        reviewer_id: string;
        decision_id: string;
        outcome: "approved" | "rejected" | "inconclusive";
        rationale: string;
        decided_at: string;
    };
}
export declare function createReviewHandoff(handoffId: string, candidate: RepairCandidate, evidenceIds: readonly string[]): ReviewHandoff;
export declare function recordHumanReview(handoff: ReviewHandoff, input: {
    actor_type: "human";
    reviewer_id: string;
    decision_id: string;
    outcome: "approved" | "rejected" | "inconclusive";
    rationale: string;
    decided_at: string;
}): ReviewHandoff;
export declare function isHumanApproved(handoff: ReviewHandoff): boolean;
//# sourceMappingURL=handoff.d.ts.map