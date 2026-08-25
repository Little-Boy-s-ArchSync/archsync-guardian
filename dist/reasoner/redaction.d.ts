import type { ReasonerEvidence } from "./contracts.js";
export interface RedactionEvent {
    evidence_id: string;
    reason: "credential" | "email" | "absolute-path";
}
export interface RedactedEvidence {
    evidence: ReasonerEvidence[];
    events: RedactionEvent[];
}
export declare function redactOutboundEvidence(input: readonly ReasonerEvidence[]): RedactedEvidence;
//# sourceMappingURL=redaction.d.ts.map