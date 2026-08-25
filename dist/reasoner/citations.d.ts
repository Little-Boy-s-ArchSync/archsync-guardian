import type { Explanation, ReasonerEvidence } from "./contracts.js";
export interface CitationIssue {
    claim: number;
    citation?: string;
    message: string;
}
export interface CitationValidation {
    valid: boolean;
    unsupported_claims: number;
    issues: CitationIssue[];
}
export declare function validateExplanationCitations(explanation: Explanation, suppliedEvidence: readonly ReasonerEvidence[]): CitationValidation;
//# sourceMappingURL=citations.d.ts.map