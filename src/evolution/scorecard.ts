import type { QualityGoalV02 } from "@archsync/core";

import { RuntimeEvidenceError } from "../runtime/collector.js";
import { sha256Canonical } from "../runtime/canonical.js";
import type { RuntimeEvidenceSnapshot, RuntimeGoalMeasurement } from "../runtime/contracts.js";

const goalMetricNames: Record<QualityGoalV02["metric"], string> = {
  p95_latency: "archsync.goal.p95_latency",
  availability_ratio: "archsync.goal.availability_ratio",
  security_violation_count: "archsync.goal.security_violation_count",
  estimated_cost: "archsync.goal.estimated_cost",
  component_count: "archsync.goal.component_count",
};

export type ScorecardObservation =
  | {
      status: "known";
      value: number;
      unit: string;
      evidence_id: string;
      source: RuntimeGoalMeasurement["source"];
      confidence: number;
    }
  | {
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

function observation(
  goal: QualityGoalV02,
  snapshot: RuntimeEvidenceSnapshot,
): ScorecardObservation {
  const matches = snapshot.measurements.filter((measurement) => measurement.goal_id === goal.id);
  if (matches.length === 0) {
    return { status: "unknown", reason: "missing-evidence", evidence_ids: [] };
  }
  if (matches.length > 1) {
    return {
      status: "unknown",
      reason: "ambiguous-evidence",
      evidence_ids: matches.map((measurement) => measurement.evidence_id).sort(),
    };
  }
  const match = matches[0]!;
  if (match.metric !== goalMetricNames[goal.metric] || match.unit !== goal.unit) {
    return {
      status: "unknown",
      reason: "incompatible-evidence",
      evidence_ids: [match.evidence_id],
    };
  }
  return {
    status: "known",
    value: match.value,
    unit: match.unit,
    evidence_id: match.evidence_id,
    source: match.source,
    confidence: match.confidence,
  };
}

function compliant(
  value: ScorecardObservation,
  goal: QualityGoalV02,
): "met" | "unmet" | "unknown" {
  if (value.status === "unknown") return "unknown";
  const met = goal.operator === "<"
    ? value.value < goal.target
    : goal.operator === "<="
      ? value.value <= goal.target
      : goal.operator === ">"
        ? value.value > goal.target
        : value.value >= goal.target;
  return met ? "met" : "unmet";
}

function change(
  before: ScorecardObservation,
  after: ScorecardObservation,
  operator: QualityGoalV02["operator"],
): EvolutionScorecardRow["change"] {
  if (before.status === "unknown" || after.status === "unknown") return "unknown";
  if (before.value === after.value) return "unchanged";
  const smallerIsBetter = operator === "<" || operator === "<=";
  const improved = smallerIsBetter ? after.value < before.value : after.value > before.value;
  return improved ? "improvement" : "regression";
}

function observationEvidence(observation: ScorecardObservation): string[] {
  return observation.status === "known" ? [observation.evidence_id] : observation.evidence_ids;
}

export function createEvolutionScorecard(
  goals: QualityGoalV02[],
  beforeSnapshot: RuntimeEvidenceSnapshot,
  afterSnapshot: RuntimeEvidenceSnapshot,
): EvolutionScorecard {
  const goalIds = goals.map((goal) => goal.id);
  if (new Set(goalIds).size !== goalIds.length) {
    throw new RuntimeEvidenceError("/scorecard/goals", "goal ids must be unique");
  }
  const rows = [...goals].sort((left, right) => left.id.localeCompare(right.id)).map((goal) => {
    const before = observation(goal, beforeSnapshot);
    const after = observation(goal, afterSnapshot);
    const confidence = before.status === "known" && after.status === "known"
      ? Math.min(before.confidence, after.confidence)
      : 0;
    return {
      goal_id: goal.id,
      attribute: goal.attribute,
      scope: goal.scope,
      metric: goal.metric,
      target: goal.target,
      operator: goal.operator,
      unit: goal.unit,
      window: { ...goal.window },
      priority: goal.priority,
      before,
      after,
      before_compliance: compliant(before, goal),
      after_compliance: compliant(after, goal),
      change: change(before, after, goal.operator),
      confidence,
      evidence_ids: [...new Set([
        ...observationEvidence(before),
        ...observationEvidence(after),
      ])].sort(),
    };
  });
  return {
    contract_version: "0.1",
    aggregation: "none",
    provenance: {
      goals_sha256: sha256Canonical(goals),
      before_evidence_sha256: sha256Canonical(beforeSnapshot),
      after_evidence_sha256: sha256Canonical(afterSnapshot),
    },
    rows,
    unknown_goal_ids: rows
      .filter((row) => row.before.status === "unknown" || row.after.status === "unknown")
      .map((row) => row.goal_id),
  };
}
