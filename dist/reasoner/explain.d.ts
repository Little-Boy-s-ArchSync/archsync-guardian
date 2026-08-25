import { type CitationValidation } from "./citations.js";
import { type ContractIssue, type Explanation, type ReasonerEvidence } from "./contracts.js";
import { type ProviderReliabilityPolicy, type ProviderRunResult, type ReasonerProvider, type RunEnvironment } from "./provider.js";
import { type RedactionEvent } from "./redaction.js";
export interface ExplanationRun {
    ok: boolean;
    explanation?: Explanation;
    contract_issues: ContractIssue[];
    citation_validation?: CitationValidation;
    redactions: RedactionEvent[];
    provider_run: ProviderRunResult;
}
export declare function explainFinding(provider: ReasonerProvider, finding: {
    id: string;
    kind: string;
    decision: "PASS" | "BLOCK" | "REVIEW";
    message: string;
}, evidence: readonly ReasonerEvidence[], policy: ProviderReliabilityPolicy, environment: RunEnvironment): Promise<ExplanationRun>;
//# sourceMappingURL=explain.d.ts.map