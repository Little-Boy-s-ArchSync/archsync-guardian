export declare const explanationContractVersion: "0.1";
export declare const repairCandidateContractVersion: "0.1";
export type UncertaintyLevel = "low" | "medium" | "high";
export type RepairRisk = "low" | "medium" | "high" | "critical";
export interface ReasonerEvidence {
    id: string;
    kind: "source" | "model" | "finding";
    text: string;
    file?: string;
    line?: number;
    rule_id?: string;
}
export interface ExplanationClaim {
    text: string;
    citations: string[];
    source_location?: {
        file?: string;
        line?: number;
        rule_id?: string;
    };
}
export interface Explanation {
    contract_version: typeof explanationContractVersion;
    summary: string;
    root_cause: string;
    claims: ExplanationClaim[];
    uncertainty: {
        level: UncertaintyLevel;
        reason: string;
    };
    recommended_next_action: string;
    model_provenance: {
        provider: string;
        model: string;
        prompt_version: string;
        request_hash: string;
    };
}
export interface VerificationResult {
    tests: "pass" | "fail" | "not-run";
    conformance: "pass" | "fail" | "not-run";
    safe_apply: boolean;
    new_blocking_findings: number;
}
export interface RepairCandidate {
    contract_version: typeof repairCandidateContractVersion;
    status: "PROPOSED" | "VERIFIED_FOR_REVIEW";
    patch: string;
    target_files: string[];
    rationale: string;
    expected_architecture_impact: string;
    risk: RepairRisk;
    verification_commands: string[];
    rollback: string;
    verification?: VerificationResult;
}
export interface ContractIssue {
    path: string;
    message: string;
}
export declare function validateExplanationShape(value: unknown): ContractIssue[];
export declare function validateRepairCandidateShape(value: unknown): ContractIssue[];
export declare function isReviewableRepairCandidate(candidate: RepairCandidate): boolean;
//# sourceMappingURL=contracts.d.ts.map