import type { ReasonerEvidence } from "./contracts.js";
export interface RedactionEvent {
    evidence_id: string;
    field: "id" | "kind" | "text" | "file" | "rule_id" | "message";
    reason: "credential" | "email" | "absolute-path";
}
export interface RedactedEvidence {
    evidence: ReasonerEvidence[];
    events: RedactionEvent[];
}
export interface OutboundFindingContext {
    id: string;
    kind: string;
    decision: "PASS" | "BLOCK" | "REVIEW";
    message: string;
}
export interface RedactedOutboundContext extends RedactedEvidence {
    finding: OutboundFindingContext;
}
export declare function redactOutboundEvidence(input: readonly ReasonerEvidence[]): RedactedEvidence;
export declare function redactOutboundContext(finding: OutboundFindingContext, input: readonly ReasonerEvidence[]): RedactedOutboundContext;
/** Redact untrusted provider diagnostics before they enter a persisted run manifest. */
export declare function redactProviderDiagnostic(input: string): string;
export declare function redactProviderArtifactPath(input: string): string;
//# sourceMappingURL=redaction.d.ts.map