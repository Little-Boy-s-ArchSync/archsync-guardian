import type { QualityGoalV02 } from "@archsync/core";
import { describe, expect, it } from "vitest";

import type { RuntimeEvidenceSnapshot, RuntimeGoalMeasurement } from "../runtime/contracts.js";
import { createEvolutionScorecard } from "./scorecard.js";

function goal(
  id: string,
  attribute: QualityGoalV02["attribute"],
  metric: QualityGoalV02["metric"],
  operator: QualityGoalV02["operator"],
  target: number,
  unit: QualityGoalV02["unit"],
): QualityGoalV02 {
  return {
    contract_version: "0.2",
    id,
    attribute,
    scope: "order-service",
    metric,
    operator,
    target,
    unit,
    window: { value: 15, unit: "minute" },
    priority: "high",
  };
}

function measurement(
  goalId: string,
  metricName: string,
  unit: string,
  value: number,
  suffix: string,
  source: RuntimeGoalMeasurement["source"] = "otel-metric",
): RuntimeGoalMeasurement {
  return {
    evidence_id: `evidence:${suffix}`,
    source,
    goal_id: goalId,
    service: "order-service",
    metric: metricName,
    unit,
    value,
    time_unix_nano: "2000000000",
    confidence: source === "otel-metric" ? 0.9 : 0.8,
  };
}

function snapshot(measurements: RuntimeGoalMeasurement[]): RuntimeEvidenceSnapshot {
  return {
    contract_version: "0.1",
    collector: { id: "archsync-otlp-json", version: "0.1.0-foundation" },
    provenance: { input_sha256: "a".repeat(64), options_sha256: "b".repeat(64) },
    environment: "test",
    window: { start_unix_nano: "1000000000", end_unix_nano: "3000000000" },
    sampling: { strategy: "fixture-replay", rate: 1 },
    retention_days: 14,
    privacy: {
      stored_attribute_allowlist: [],
      sensitive_attributes_rejected: true,
      raw_payload_retained: false,
    },
    services: ["order-service"],
    spans: [],
    measurements,
  };
}

describe("evolution scorecard", () => {
  it("keeps every goal independent and traces improvements, regressions and unknowns", () => {
    const goals = [
      goal("LAT-001", "latency", "p95_latency", "<=", 200, "ms"),
      goal("AVL-001", "availability", "availability_ratio", ">=", 0.995, "ratio"),
      goal("SEC-001", "security", "security_violation_count", "<", 1, "count"),
      goal("COST-001", "cost", "estimated_cost", "<=", 500, "usd"),
      goal("CPLX-001", "complexity", "component_count", "<=", 12, "count"),
    ];
    const before = snapshot([
      measurement("LAT-001", "archsync.goal.p95_latency", "ms", 250, "lat-before"),
      measurement("AVL-001", "archsync.goal.availability_ratio", "ratio", 0.999, "avl-before"),
      measurement("SEC-001", "archsync.goal.security_violation_count", "count", 0, "sec-before", "iac"),
      measurement("COST-001", "archsync.goal.estimated_cost", "usd", 400, "cost-before", "model"),
      measurement("CPLX-001", "archsync.goal.component_count", "count", 10, "cplx-before-1"),
      measurement("CPLX-001", "archsync.goal.component_count", "count", 11, "cplx-before-2"),
    ]);
    const after = snapshot([
      measurement("LAT-001", "archsync.goal.p95_latency", "ms", 180, "lat-after"),
      measurement("AVL-001", "archsync.goal.availability_ratio", "ratio", 0.99, "avl-after"),
      measurement("SEC-001", "archsync.goal.security_violation_count", "count", 0, "sec-after", "iac"),
      measurement("COST-001", "archsync.goal.estimated_cost", "usd", 550, "cost-after", "model"),
      measurement("CPLX-001", "archsync.goal.component_count", "usd", 12, "cplx-after"),
    ]);

    const scorecard = createEvolutionScorecard(goals.reverse(), before, after);
    expect(scorecard.aggregation).toBe("none");
    expect(scorecard.rows.map((row) => row.goal_id)).toEqual([
      "AVL-001",
      "COST-001",
      "CPLX-001",
      "LAT-001",
      "SEC-001",
    ]);
    expect(scorecard.rows.find((row) => row.goal_id === "LAT-001")).toMatchObject({
      before_compliance: "unmet",
      after_compliance: "met",
      change: "improvement",
      confidence: 0.9,
    });
    expect(scorecard.rows.find((row) => row.goal_id === "AVL-001")).toMatchObject({
      before_compliance: "met",
      after_compliance: "unmet",
      change: "regression",
    });
    expect(scorecard.rows.find((row) => row.goal_id === "SEC-001")).toMatchObject({
      before_compliance: "met",
      after_compliance: "met",
      change: "unchanged",
      confidence: 0.8,
    });
    expect(scorecard.rows.find((row) => row.goal_id === "COST-001")?.change).toBe("regression");
    expect(scorecard.rows.find((row) => row.goal_id === "CPLX-001")).toMatchObject({
      before: { status: "unknown", reason: "ambiguous-evidence" },
      after: { status: "unknown", reason: "incompatible-evidence" },
      before_compliance: "unknown",
      after_compliance: "unknown",
      change: "unknown",
      confidence: 0,
    });
    expect(scorecard.unknown_goal_ids).toEqual(["CPLX-001"]);
    expect(scorecard.provenance.goals_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats absent evidence as unknown and supports strict greater-than targets", () => {
    const availability = goal(
      "AVL-STRICT",
      "availability",
      "availability_ratio",
      ">",
      0.99,
      "ratio",
    );
    const before = snapshot([]);
    const after = snapshot([
      measurement(
        "AVL-STRICT",
        "archsync.goal.availability_ratio",
        "ratio",
        0.991,
        "strict-after",
      ),
    ]);
    const row = createEvolutionScorecard([availability], before, after).rows[0]!;

    expect(row.before).toEqual({ status: "unknown", reason: "missing-evidence", evidence_ids: [] });
    expect(row.after_compliance).toBe("met");
    expect(row.change).toBe("unknown");
  });

  it("rejects duplicate goal ids rather than silently selecting a row", () => {
    const duplicate = goal("LAT-001", "latency", "p95_latency", "<", 200, "ms");
    expect(() => createEvolutionScorecard([duplicate, { ...duplicate }], snapshot([]), snapshot([])))
      .toThrow("goal ids must be unique");
  });
});
