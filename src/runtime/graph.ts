import { RuntimeEvidenceError } from "./collector.js";
import { sha256Canonical } from "./canonical.js";
import type {
  NormalizedRuntimeSpan,
  ObservedRuntimeGraph,
  RuntimeEvidenceSnapshot,
  RuntimeMappingConfig,
  RuntimeMappingStatus,
  RuntimeRelationshipType,
} from "./contracts.js";

interface ServiceMapping {
  ids: string[];
  status: RuntimeMappingStatus;
  confidence: number;
}

function compareNano(left: string, right: string): number {
  return Number(BigInt(left) - BigInt(right));
}

function unique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new RuntimeEvidenceError(path, "values must be unique");
  }
}

function validateMappingConfig(config: RuntimeMappingConfig): void {
  if (config.contract_version !== "0.1") {
    throw new RuntimeEvidenceError("/mapping/contract_version", "expected 0.1");
  }
  if (!Number.isInteger(config.minimum_edge_samples) || config.minimum_edge_samples < 1) {
    throw new RuntimeEvidenceError("/mapping/minimum_edge_samples", "expected a positive integer");
  }
  unique(config.expected_components, "/mapping/expected_components");
  const expected = new Set(config.expected_components);
  for (const [service, ids] of Object.entries(config.services)) {
    if (service.length === 0) throw new RuntimeEvidenceError("/mapping/services", "service name must not be empty");
    unique(ids, `/mapping/services/${service}`);
    for (const id of ids) {
      if (!expected.has(id)) {
        throw new RuntimeEvidenceError(`/mapping/services/${service}`, `unknown component '${id}'`);
      }
    }
  }
  const edgeKeys = config.expected_edges.map((edge) => `${edge.from}|${edge.type}|${edge.to}`);
  unique(edgeKeys, "/mapping/expected_edges");
  config.expected_edges.forEach((edge, index) => {
    if (!expected.has(edge.from) || !expected.has(edge.to)) {
      throw new RuntimeEvidenceError(`/mapping/expected_edges/${index}`, "edge references an unknown component");
    }
  });
}

function mappingFor(service: string, config: RuntimeMappingConfig): ServiceMapping {
  const ids = [...(config.services[service] ?? [])].sort();
  if (ids.length === 1) return { ids, status: "mapped", confidence: 1 };
  if (ids.length > 1) return { ids, status: "ambiguous", confidence: 0 };
  return { ids, status: "unmapped", confidence: 0 };
}

function evidenceForService(service: string, snapshot: RuntimeEvidenceSnapshot): string[] {
  return [
    ...snapshot.spans
      .filter((span) => span.service === service || span.peer_service === service)
      .map((span) => span.evidence_id),
    ...snapshot.measurements
      .filter((measurement) => measurement.service === service)
      .map((measurement) => measurement.evidence_id),
  ].sort();
}

function timestampBounds(service: string, snapshot: RuntimeEvidenceSnapshot): [string, string] {
  const timestamps = [
    ...snapshot.spans.flatMap((span) => {
      if (span.service === service || span.peer_service === service) {
        return [span.start_unix_nano, span.end_unix_nano];
      }
      return [];
    }),
    ...snapshot.measurements
      .filter((measurement) => measurement.service === service)
      .map((measurement) => measurement.time_unix_nano),
  ].sort(compareNano);
  return [timestamps[0]!, timestamps.at(-1)!];
}

function edgeEndpoints(span: NormalizedRuntimeSpan): [string, string] | undefined {
  if (span.peer_service === undefined || span.direction === "internal") return undefined;
  return span.direction === "outbound"
    ? [span.service, span.peer_service]
    : [span.peer_service, span.service];
}

function percentile(values: number[], proportion: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * proportion) - 1]!;
}

function combinedStatus(from: ServiceMapping, to: ServiceMapping): RuntimeMappingStatus {
  if (from.status === "unmapped" || to.status === "unmapped") return "unmapped";
  if (from.status === "ambiguous" || to.status === "ambiguous") return "ambiguous";
  return "mapped";
}

export function buildObservedRuntimeGraph(
  snapshot: RuntimeEvidenceSnapshot,
  config: RuntimeMappingConfig,
): ObservedRuntimeGraph {
  validateMappingConfig(config);
  const mappings = new Map(snapshot.services.map((service) => [service, mappingFor(service, config)]));
  const nodes = snapshot.services.map((service) => {
    const mapping = mappings.get(service)!;
    const [firstSeen, lastSeen] = timestampBounds(service, snapshot);
    return {
      runtime_service: service,
      component_ids: mapping.ids,
      mapping_status: mapping.status,
      confidence: mapping.confidence,
      span_count: snapshot.spans.filter(
        (span) => span.service === service || span.peer_service === service,
      ).length,
      metric_count: snapshot.measurements.filter(
        (measurement) => measurement.service === service,
      ).length,
      first_seen_unix_nano: firstSeen,
      last_seen_unix_nano: lastSeen,
    };
  });

  const grouped = new Map<string, { from: string; to: string; type: RuntimeRelationshipType; spans: NormalizedRuntimeSpan[] }>();
  snapshot.spans.forEach((span) => {
    const endpoints = edgeEndpoints(span);
    if (endpoints === undefined) return;
    const [from, to] = endpoints;
    const key = `${from}|${span.relationship_type}|${to}`;
    const current = grouped.get(key) ?? { from, to, type: span.relationship_type, spans: [] };
    current.spans.push(span);
    grouped.set(key, current);
  });

  const edges = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, group]) => {
    const fromMapping = mappings.get(group.from)!;
    const toMapping = mappings.get(group.to)!;
    const status = combinedStatus(fromMapping, toMapping);
    const times = group.spans.flatMap((span) => [span.start_unix_nano, span.end_unix_nano])
      .sort(compareNano);
    const durations = group.spans.map((span) => span.duration_ms);
    return {
      key,
      from_service: group.from,
      to_service: group.to,
      relationship_type: group.type,
      from_component_ids: fromMapping.ids,
      to_component_ids: toMapping.ids,
      mapping_status: status,
      confidence: status === "mapped" ? 1 : 0,
      count: group.spans.length,
      error_count: group.spans.filter((span) => span.error).length,
      latency_ms: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
        max: Math.max(...durations),
      },
      first_seen_unix_nano: times[0]!,
      last_seen_unix_nano: times.at(-1)!,
      evidence_ids: group.spans.map((span) => span.evidence_id).sort(),
    };
  });

  const modelComponents = [...config.expected_components].sort().map((componentId) => {
    const runtimeServices = nodes
      .filter((node) => node.mapping_status === "mapped" && node.component_ids[0] === componentId)
      .map((node) => node.runtime_service);
    return {
      component_id: componentId,
      observation: runtimeServices.length === 0 ? "no-evidence" as const : "observed" as const,
      runtime_services: runtimeServices,
    };
  });

  const signals: ObservedRuntimeGraph["signals"] = [];
  nodes.forEach((node) => {
    if (node.mapping_status === "ambiguous") {
      signals.push({
        code: "RUNTIME_MAPPING_AMBIGUOUS",
        severity: "warning",
        subject: node.runtime_service,
        evidence_ids: evidenceForService(node.runtime_service, snapshot),
      });
    }
    if (node.mapping_status === "unmapped") {
      signals.push({
        code: "RUNTIME_MAPPING_MISSING",
        severity: "warning",
        subject: node.runtime_service,
        evidence_ids: evidenceForService(node.runtime_service, snapshot),
      });
    }
  });
  const expectedEdgeKeys = new Set(config.expected_edges.map((edge) => `${edge.from}|${edge.type}|${edge.to}`));
  edges.forEach((edge) => {
    if (edge.count < config.minimum_edge_samples) {
      signals.push({
        code: "RUNTIME_LOW_SAMPLE",
        severity: "info",
        subject: edge.key,
        evidence_ids: edge.evidence_ids,
      });
    }
    if (edge.mapping_status === "mapped") {
      const modelKey = `${edge.from_component_ids[0]}|${edge.relationship_type}|${edge.to_component_ids[0]}`;
      if (!expectedEdgeKeys.has(modelKey)) {
        signals.push({
          code: "RUNTIME_UNDECLARED_EDGE",
          severity: "warning",
          subject: edge.key,
          evidence_ids: edge.evidence_ids,
        });
      }
    }
  });
  modelComponents.filter((component) => component.observation === "no-evidence").forEach((component) => {
    signals.push({
      code: "RUNTIME_NO_EVIDENCE",
      severity: "info",
      subject: component.component_id,
      evidence_ids: [],
    });
  });
  signals.sort((left, right) => `${left.code}|${left.subject}`.localeCompare(`${right.code}|${right.subject}`));

  const mappedServices = nodes.filter((node) => node.mapping_status === "mapped").length;
  return {
    contract_version: "0.1",
    provenance: {
      runtime_snapshot_sha256: sha256Canonical(snapshot),
      mapping_config_sha256: sha256Canonical(config),
    },
    environment: snapshot.environment,
    window: { ...snapshot.window },
    nodes,
    edges,
    model_components: modelComponents,
    signals,
    reliability: {
      span_count: snapshot.spans.length,
      metric_count: snapshot.measurements.length,
      mapped_service_ratio: nodes.length === 0 ? 0 : mappedServices / nodes.length,
      low_sample_edge_count: edges.filter((edge) => edge.count < config.minimum_edge_samples).length,
    },
  };
}
