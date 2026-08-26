export type RootCauseCode = "boundary-bypass" | "missing-required-dependency" | "new-infrastructure" | "stale-baseline" | "detector-uncertainty" | "configuration-error" | "unknown";
export interface RootCauseClassification {
    code: RootCauseCode;
    reason: string;
}
export declare function classifyRootCause(finding: {
    kind: string;
    message: string;
    rule_id?: string;
    detector_confidence?: number;
}): RootCauseClassification;
//# sourceMappingURL=taxonomy.d.ts.map