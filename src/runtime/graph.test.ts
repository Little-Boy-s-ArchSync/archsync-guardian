import { describe, expect, it } from "vitest";

import type {
  NormalizedRuntimeSpan,
  RuntimeEvidenceSnapshot,
  RuntimeMappingConfig,
} from "./contracts.js";
import { buildObservedRuntimeGraph } from "./graph.js";

function runtimeSpan(
  id: string,
  service: string,
  peerService: string | undefined,
  relationship: NormalizedRuntimeSpan["relationship_type"],
  duration: number,
  error = false,
  direction: NormalizedRuntimeSpan["direction"] = "outbound",
): NormalizedRuntimeSpan {
  const base = {
    evidence_id: `span:${id}`,
    trace_id: id.padStart(32, "a"),
    span_id: id.padStart(16, "b"),
    service,
    direction,
    relationship_type: relationship,
    start_unix_nano: String(1_000_000_000 + Number(id) * 100_000_000),
    end_unix_nano: String(1_000_000_000 + Number(id) * 100_000_000 + duration * 1_000_000),
    duration_ms: duration,
    error,
  };
  return peerService === undefined ? base : { ...base, peer_service: peerService };
}

function snapshot(): RuntimeEvidenceSnapshot {
  return {
    contract_version: "0.1",
    collector: { id: "archsync-otlp-json", version: "0.1.0-foundation" },
    provenance: { input_sha256: "a".repeat(64), options_sha256: "b".repeat(64) },
    environment: "test",
    window: { start_unix_nano: "1000000000", end_unix_nano: "9000000000" },
    sampling: { strategy: "fixture-replay", rate: 1 },
    retention_days: 14,
    privacy: {
      stored_attribute_allowlist: [],
      sensitive_attributes_rejected: true,
      raw_payload_retained: false,
    },
    services: ["ambiguous", "api", "missing", "order", "postgres"],
    spans: [
      runtimeSpan("1", "api", "order", "http", 10),
      runtimeSpan("2", "api", "order", "http", 20, true),
      runtimeSpan("3", "order", "postgres", "data", 30),
      runtimeSpan("4", "order", "missing", "dependency", 40),
      runtimeSpan("5", "order", "ambiguous", "async", 50),
      runtimeSpan("6", "api", "order", "dependency", 60, false, "inbound"),
      runtimeSpan("7", "order", undefined, "dependency", 70, false, "internal"),
    ],
    measurements: [{
      evidence_id: "metric:one",
      source: "otel-metric",
      goal_id: "LAT-001",
      service: "order",
      metric: "archsync.goal.p95_latency",
      unit: "ms",
      value: 20,
      time_unix_nano: "3000000000",
      confidence: 1,
    }],
  };
}

function mapping(): RuntimeMappingConfig {
  return {
    contract_version: "0.1",
    minimum_edge_samples: 2,
    services: {
      ambiguous: ["choice-b", "choice-a"],
      api: ["api-gateway"],
      order: ["order-service"],
      postgres: ["postgres"],
    },
    expected_components: [
      "unused",
      "postgres",
      "order-service",
      "choice-b",
      "choice-a",
      "api-gateway",
    ],
    expected_edges: [
      { from: "api-gateway", to: "order-service", type: "http" },
      { from: "order-service", to: "postgres", type: "data" },
    ],
  };
}

describe("observed runtime graph", () => {
  it("normalizes mappings, aggregates edges and surfaces reliability/conflict signals", () => {
    const graph = buildObservedRuntimeGraph(snapshot(), mapping());
    const replay = buildObservedRuntimeGraph(snapshot(), mapping());

    expect(graph).toEqual(replay);
    expect(graph.nodes.map((node) => node.runtime_service)).toEqual([
      "ambiguous",
      "api",
      "missing",
      "order",
      "postgres",
    ]);
    expect(graph.nodes.find((node) => node.runtime_service === "ambiguous")).toMatchObject({
      component_ids: ["choice-a", "choice-b"],
      mapping_status: "ambiguous",
      confidence: 0,
    });
    expect(graph.nodes.find((node) => node.runtime_service === "missing")?.mapping_status).toBe("unmapped");
    expect(graph.edges).toHaveLength(5);
    expect(graph.edges.find((edge) => edge.key === "api|http|order")).toMatchObject({
      count: 2,
      error_count: 1,
      latency_ms: { p50: 10, p95: 20, max: 20 },
      mapping_status: "mapped",
    });
    expect(graph.edges.find((edge) => edge.key === "order|dependency|api")).toBeDefined();
    expect(graph.model_components.find((item) => item.component_id === "unused")?.observation)
      .toBe("no-evidence");
    expect(new Set(graph.signals.map((signal) => signal.code))).toEqual(new Set([
      "RUNTIME_MAPPING_AMBIGUOUS",
      "RUNTIME_MAPPING_MISSING",
      "RUNTIME_LOW_SAMPLE",
      "RUNTIME_UNDECLARED_EDGE",
      "RUNTIME_NO_EVIDENCE",
    ]));
    expect(graph.reliability).toEqual({
      span_count: 7,
      metric_count: 1,
      mapped_service_ratio: 3 / 5,
      low_sample_edge_count: 4,
    });
    expect(graph.provenance.runtime_snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(graph.provenance.mapping_config_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("represents an empty window as no evidence rather than absence", () => {
    const empty = snapshot();
    empty.services = [];
    empty.spans = [];
    empty.measurements = [];
    const config = mapping();
    config.services = {};
    config.expected_edges = [];
    const graph = buildObservedRuntimeGraph(empty, config);

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.reliability.mapped_service_ratio).toBe(0);
    expect(graph.signals).toHaveLength(config.expected_components.length);
    expect(graph.signals.every((signal) => signal.code === "RUNTIME_NO_EVIDENCE")).toBe(true);
  });

  it("rejects invalid or ambiguous mapping-contract structure before graph construction", () => {
    const cases: Array<[(config: RuntimeMappingConfig) => void, string]> = [
      [(config) => { config.contract_version = "wrong" as "0.1"; }, "contract_version"],
      [(config) => { config.minimum_edge_samples = 0; }, "positive integer"],
      [(config) => { config.expected_components.push(config.expected_components[0]!); }, "must be unique"],
      [(config) => { config.services[""] = []; }, "must not be empty"],
      [(config) => { config.services.api = ["api-gateway", "api-gateway"]; }, "must be unique"],
      [(config) => { config.services.api = ["unknown"]; }, "unknown component"],
      [(config) => { config.expected_edges.push({ ...config.expected_edges[0]! }); }, "must be unique"],
      [(config) => { config.expected_edges[0]!.to = "unknown"; }, "unknown component"],
    ];
    cases.forEach(([mutate, expected]) => {
      const config = mapping();
      mutate(config);
      expect(() => buildObservedRuntimeGraph(snapshot(), config)).toThrow(expected);
    });
  });
});
