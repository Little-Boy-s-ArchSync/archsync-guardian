export const runtimeEvidenceContractVersion = "0.1" as const;
export const runtimeCollectorVersion = "0.1.0-foundation" as const;

export type OtlpScalar = string | number | boolean;

export interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    doubleValue?: string | number;
    boolValue?: boolean;
  };
}

export interface OtlpResource {
  attributes: OtlpAttribute[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status?: { code?: number };
}

export interface OtlpMetricPoint {
  timeUnixNano: string;
  attributes: OtlpAttribute[];
  asDouble?: number | string;
  asInt?: number | string;
}

export interface OtlpMetric {
  name: string;
  unit: string;
  gauge: { dataPoints: OtlpMetricPoint[] };
}

export interface OtlpExport {
  resourceSpans: Array<{
    resource: OtlpResource;
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
  resourceMetrics: Array<{
    resource: OtlpResource;
    scopeMetrics: Array<{ metrics: OtlpMetric[] }>;
  }>;
}

export type RuntimeRelationshipType = "http" | "async" | "data" | "dependency";

export interface NormalizedRuntimeSpan {
  evidence_id: string;
  trace_id: string;
  span_id: string;
  service: string;
  peer_service?: string;
  direction: "outbound" | "inbound" | "internal";
  relationship_type: RuntimeRelationshipType;
  start_unix_nano: string;
  end_unix_nano: string;
  duration_ms: number;
  error: boolean;
}

export interface RuntimeGoalMeasurement {
  evidence_id: string;
  source: "otel-metric" | "iac" | "model";
  goal_id: string;
  service: string;
  metric: string;
  unit: string;
  value: number;
  time_unix_nano: string;
  confidence: number;
}

export interface RuntimeEvidenceSnapshot {
  contract_version: typeof runtimeEvidenceContractVersion;
  collector: {
    id: "archsync-otlp-json";
    version: typeof runtimeCollectorVersion;
  };
  provenance: {
    input_sha256: string;
    options_sha256: string;
  };
  environment: string;
  window: {
    start_unix_nano: string;
    end_unix_nano: string;
  };
  sampling: {
    strategy: "fixture-replay" | "head" | "tail";
    rate: number;
  };
  retention_days: number;
  privacy: {
    stored_attribute_allowlist: readonly string[];
    sensitive_attributes_rejected: true;
    raw_payload_retained: false;
  };
  services: string[];
  spans: NormalizedRuntimeSpan[];
  measurements: RuntimeGoalMeasurement[];
}

export interface RuntimeCollectionOptions {
  environment: string;
  window: RuntimeEvidenceSnapshot["window"];
  sampling: RuntimeEvidenceSnapshot["sampling"];
  retention_days: number;
}

export interface RuntimeMappingConfig {
  contract_version: "0.1";
  minimum_edge_samples: number;
  services: Record<string, string[]>;
  expected_components: string[];
  expected_edges: Array<{
    from: string;
    to: string;
    type: RuntimeRelationshipType;
  }>;
}

export type RuntimeMappingStatus = "mapped" | "ambiguous" | "unmapped";

export interface ObservedRuntimeGraph {
  contract_version: "0.1";
  provenance: {
    runtime_snapshot_sha256: string;
    mapping_config_sha256: string;
  };
  environment: string;
  window: RuntimeEvidenceSnapshot["window"];
  nodes: Array<{
    runtime_service: string;
    component_ids: string[];
    mapping_status: RuntimeMappingStatus;
    confidence: number;
    span_count: number;
    metric_count: number;
    first_seen_unix_nano: string;
    last_seen_unix_nano: string;
  }>;
  edges: Array<{
    key: string;
    from_service: string;
    to_service: string;
    relationship_type: RuntimeRelationshipType;
    from_component_ids: string[];
    to_component_ids: string[];
    mapping_status: RuntimeMappingStatus;
    confidence: number;
    count: number;
    error_count: number;
    latency_ms: { p50: number; p95: number; max: number };
    first_seen_unix_nano: string;
    last_seen_unix_nano: string;
    evidence_ids: string[];
  }>;
  model_components: Array<{
    component_id: string;
    observation: "observed" | "no-evidence";
    runtime_services: string[];
  }>;
  signals: Array<{
    code:
      | "RUNTIME_MAPPING_AMBIGUOUS"
      | "RUNTIME_MAPPING_MISSING"
      | "RUNTIME_LOW_SAMPLE"
      | "RUNTIME_UNDECLARED_EDGE"
      | "RUNTIME_NO_EVIDENCE";
    severity: "info" | "warning";
    subject: string;
    evidence_ids: string[];
  }>;
  reliability: {
    span_count: number;
    metric_count: number;
    mapped_service_ratio: number;
    low_sample_edge_count: number;
  };
}
