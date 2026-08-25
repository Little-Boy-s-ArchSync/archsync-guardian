import type { QualityGoalV02 } from "@archsync/core";
import type { RuntimeEvidenceSnapshot, RuntimeGoalMeasurement } from "../runtime/contracts.js";
export type ScorecardObservation = {
    status: "known";
    value: number;
    unit: string;
    evidence_id: string;
    source: RuntimeGoalMeasurement["source"];
    confidence: number;
} | {
    status: "unknown";
    reason: "missing-evidence" | "ambiguous-evidence" | "incompatible-evidence";
    evidence_ids: string[];
};
export interface EvolutionScorecardRow {
    goal_id: string;
    attribute: QualityGoalV02["attribute"];
    scope: string;
    metric: QualityGoalV02["metric"];
    target: number;
    operator: QualityGoalV02["operator"];
    unit: QualityGoalV02["unit"];
    window: QualityGoalV02["window"];
    priority: QualityGoalV02["priority"];
    before: ScorecardObservation;
    after: ScorecardObservation;
    before_compliance: "met" | "unmet" | "unknown";
    after_compliance: "met" | "unmet" | "unknown";
    change: "improvement" | "regression" | "unchanged" | "unknown";
    confidence: number;
    evidence_ids: string[];
}
export interface EvolutionScorecard {
    contract_version: "0.1";
    aggregation: "none";
    provenance: {
        goals_sha256: string;
        before_evidence_sha256: string;
        after_evidence_sha256: string;
    };
    rows: EvolutionScorecardRow[];
    unknown_goal_ids: string[];
}
export declare function createEvolutionScorecard(goals: QualityGoalV02[], beforeSnapshot: RuntimeEvidenceSnapshot, afterSnapshot: RuntimeEvidenceSnapshot): EvolutionScorecard;
//# sourceMappingURL=scorecard.d.ts.map