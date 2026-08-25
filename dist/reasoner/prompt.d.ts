import type { ReasonerEvidence } from "./contracts.js";
export declare const evidencePromptVersion: "explanation-evidence-only-v0.1";
export interface FindingPromptContext {
    finding_id: string;
    kind: string;
    decision: "PASS" | "BLOCK" | "REVIEW";
    message: string;
    evidence: ReasonerEvidence[];
}
export interface VersionedPrompt {
    version: typeof evidencePromptVersion;
    sha256: string;
    text: string;
}
export declare function buildEvidenceOnlyPrompt(context: FindingPromptContext): VersionedPrompt;
//# sourceMappingURL=prompt.d.ts.map