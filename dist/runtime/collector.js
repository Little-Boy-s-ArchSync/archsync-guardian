import { canonicalJson, sha256Canonical } from "./canonical.js";
import { runtimeCollectorVersion, runtimeEvidenceContractVersion, } from "./contracts.js";
export const storedRuntimeAttributeAllowlist = [
    "archsync.goal.id",
    "db.system",
    "deployment.environment.name",
    "http.request.method",
    "messaging.destination.name",
    "messaging.system",
    "peer.service",
    "rpc.system",
    "server.address",
    "service.name",
];
const sensitiveKey = /(?:authorization|cookie|e-?mail|enduser|password|secret|token|user\.id)/iu;
const decimalNano = /^\d+$/u;
const hexId = /^[0-9a-f]+$/iu;
export class RuntimeEvidenceError extends Error {
    constructor(path, message) {
        super(`${path}: ${message}`);
        this.name = "RuntimeEvidenceError";
    }
}
function record(value, path) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new RuntimeEvidenceError(path, "expected an object");
    }
    return value;
}
function array(value, path) {
    if (!Array.isArray(value))
        throw new RuntimeEvidenceError(path, "expected an array");
    return value;
}
function text(value, path) {
    if (typeof value !== "string" || value.length === 0) {
        throw new RuntimeEvidenceError(path, "expected a non-empty string");
    }
    return value;
}
function finiteNumber(value, path) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed))
        throw new RuntimeEvidenceError(path, "expected a finite number");
    return parsed;
}
function scalar(value, path) {
    const wrapped = record(value, path);
    const populated = ["stringValue", "intValue", "doubleValue", "boolValue"]
        .filter((key) => wrapped[key] !== undefined);
    if (populated.length !== 1) {
        throw new RuntimeEvidenceError(path, "expected exactly one scalar OTLP value");
    }
    const key = populated[0];
    if (key === "stringValue")
        return text(wrapped[key], `${path}/${key}`);
    if (key === "boolValue") {
        if (typeof wrapped[key] !== "boolean") {
            throw new RuntimeEvidenceError(`${path}/${key}`, "expected a boolean");
        }
        return wrapped[key];
    }
    return finiteNumber(wrapped[key], `${path}/${key}`);
}
function attributeMap(value, path) {
    const output = new Map();
    array(value, path).forEach((raw, index) => {
        const item = record(raw, `${path}/${index}`);
        const key = text(item.key, `${path}/${index}/key`);
        if (sensitiveKey.test(key)) {
            throw new RuntimeEvidenceError(`${path}/${index}/key`, "sensitive attribute key is forbidden");
        }
        if (output.has(key))
            throw new RuntimeEvidenceError(`${path}/${index}/key`, "duplicate attribute key");
        output.set(key, scalar(item.value, `${path}/${index}/value`));
    });
    return output;
}
function requiredAttribute(attributes, key, path) {
    return text(attributes.get(key), `${path}/${key}`);
}
function nano(value, path) {
    const parsed = text(value, path);
    if (!decimalNano.test(parsed))
        throw new RuntimeEvidenceError(path, "expected unsigned unix nanoseconds");
    return parsed;
}
function withinWindow(timestamp, options, path) {
    const value = BigInt(timestamp);
    if (value < BigInt(options.window.start_unix_nano) || value > BigInt(options.window.end_unix_nano)) {
        throw new RuntimeEvidenceError(path, "timestamp is outside the configured evidence window");
    }
}
function validateOptions(options) {
    text(options.environment, "/options/environment");
    const start = nano(options.window.start_unix_nano, "/options/window/start_unix_nano");
    const end = nano(options.window.end_unix_nano, "/options/window/end_unix_nano");
    if (BigInt(start) > BigInt(end)) {
        throw new RuntimeEvidenceError("/options/window", "start must not be after end");
    }
    if (!["fixture-replay", "head", "tail"].includes(options.sampling.strategy)) {
        throw new RuntimeEvidenceError("/options/sampling/strategy", "unsupported sampling strategy");
    }
    if (!(options.sampling.rate > 0 && options.sampling.rate <= 1)) {
        throw new RuntimeEvidenceError("/options/sampling/rate", "sampling rate must be in (0, 1]");
    }
    if (!Number.isInteger(options.retention_days) || options.retention_days < 1 || options.retention_days > 30) {
        throw new RuntimeEvidenceError("/options/retention_days", "retention must be an integer from 1 to 30 days");
    }
}
function resourceIdentity(value, path, options) {
    const resource = record(value, path);
    const attributes = attributeMap(resource.attributes, `${path}/attributes`);
    const service = requiredAttribute(attributes, "service.name", `${path}/attributes`);
    const environment = requiredAttribute(attributes, "deployment.environment.name", `${path}/attributes`);
    if (environment !== options.environment) {
        throw new RuntimeEvidenceError(`${path}/attributes/deployment.environment.name`, "environment mismatch");
    }
    return service;
}
function direction(kind) {
    if (kind === 3 || kind === 4)
        return "outbound";
    if (kind === 2 || kind === 5)
        return "inbound";
    return "internal";
}
function relationship(attributes) {
    if (attributes.has("db.system"))
        return "data";
    if (attributes.has("messaging.system"))
        return "async";
    if (attributes.has("http.request.method") || attributes.has("rpc.system"))
        return "http";
    return "dependency";
}
function peer(attributes) {
    const value = attributes.get("peer.service")
        ?? attributes.get("server.address")
        ?? attributes.get("messaging.destination.name");
    return value === undefined ? undefined : String(value);
}
function normalizeSpan(raw, path, service, options) {
    const span = record(raw, path);
    const traceId = text(span.traceId, `${path}/traceId`);
    const spanId = text(span.spanId, `${path}/spanId`);
    if (!hexId.test(traceId) || !hexId.test(spanId)) {
        throw new RuntimeEvidenceError(path, "traceId and spanId must be hexadecimal");
    }
    text(span.name, `${path}/name`);
    const kind = finiteNumber(span.kind, `${path}/kind`);
    if (!Number.isInteger(kind) || kind < 0 || kind > 5) {
        throw new RuntimeEvidenceError(`${path}/kind`, "span kind must be an integer from 0 to 5");
    }
    const start = nano(span.startTimeUnixNano, `${path}/startTimeUnixNano`);
    const end = nano(span.endTimeUnixNano, `${path}/endTimeUnixNano`);
    withinWindow(start, options, `${path}/startTimeUnixNano`);
    withinWindow(end, options, `${path}/endTimeUnixNano`);
    if (BigInt(end) < BigInt(start)) {
        throw new RuntimeEvidenceError(path, "span end must not precede start");
    }
    const attributes = attributeMap(span.attributes, `${path}/attributes`);
    const status = span.status === undefined ? {} : record(span.status, `${path}/status`);
    const statusCode = status.code === undefined ? 0 : finiteNumber(status.code, `${path}/status/code`);
    if (!Number.isInteger(statusCode) || statusCode < 0 || statusCode > 2) {
        throw new RuntimeEvidenceError(`${path}/status/code`, "status code must be 0, 1 or 2");
    }
    const normalized = {
        evidence_id: `span:${traceId}:${spanId}`,
        trace_id: traceId.toLowerCase(),
        span_id: spanId.toLowerCase(),
        service,
        direction: direction(kind),
        relationship_type: relationship(attributes),
        start_unix_nano: start,
        end_unix_nano: end,
        duration_ms: Number(BigInt(end) - BigInt(start)) / 1_000_000,
        error: statusCode === 2,
    };
    const peerService = peer(attributes);
    return peerService === undefined ? normalized : { ...normalized, peer_service: peerService };
}
function metricValue(point, path) {
    const defined = ["asDouble", "asInt"].filter((key) => point[key] !== undefined);
    if (defined.length !== 1) {
        throw new RuntimeEvidenceError(path, "gauge point must contain exactly one numeric value");
    }
    return finiteNumber(point[defined[0]], `${path}/${defined[0]}`);
}
function normalizeMeasurement(raw, path, service, metric, unit, options) {
    const point = record(raw, path);
    const timestamp = nano(point.timeUnixNano, `${path}/timeUnixNano`);
    withinWindow(timestamp, options, `${path}/timeUnixNano`);
    const attributes = attributeMap(point.attributes, `${path}/attributes`);
    const goalId = requiredAttribute(attributes, "archsync.goal.id", `${path}/attributes`);
    const value = metricValue(point, path);
    const evidenceId = `metric:${sha256Canonical({ goalId, metric, service, timestamp, unit, value })}`;
    return {
        evidence_id: evidenceId,
        source: "otel-metric",
        goal_id: goalId,
        service,
        metric,
        unit,
        value,
        time_unix_nano: timestamp,
        confidence: 1,
    };
}
function parseExport(value, options) {
    const root = record(value, "/");
    const spans = [];
    const measurements = [];
    array(root.resourceSpans, "/resourceSpans").forEach((rawResource, resourceIndex) => {
        const path = `/resourceSpans/${resourceIndex}`;
        const resourceSpan = record(rawResource, path);
        const service = resourceIdentity(resourceSpan.resource, `${path}/resource`, options);
        array(resourceSpan.scopeSpans, `${path}/scopeSpans`).forEach((rawScope, scopeIndex) => {
            const scopePath = `${path}/scopeSpans/${scopeIndex}`;
            const scope = record(rawScope, scopePath);
            array(scope.spans, `${scopePath}/spans`).forEach((span, spanIndex) => {
                spans.push(normalizeSpan(span, `${scopePath}/spans/${spanIndex}`, service, options));
            });
        });
    });
    array(root.resourceMetrics, "/resourceMetrics").forEach((rawResource, resourceIndex) => {
        const path = `/resourceMetrics/${resourceIndex}`;
        const resourceMetric = record(rawResource, path);
        const service = resourceIdentity(resourceMetric.resource, `${path}/resource`, options);
        array(resourceMetric.scopeMetrics, `${path}/scopeMetrics`).forEach((rawScope, scopeIndex) => {
            const scopePath = `${path}/scopeMetrics/${scopeIndex}`;
            const scope = record(rawScope, scopePath);
            array(scope.metrics, `${scopePath}/metrics`).forEach((rawMetric, metricIndex) => {
                const metricPath = `${scopePath}/metrics/${metricIndex}`;
                const metric = record(rawMetric, metricPath);
                const name = text(metric.name, `${metricPath}/name`);
                const unit = text(metric.unit, `${metricPath}/unit`);
                const gauge = record(metric.gauge, `${metricPath}/gauge`);
                array(gauge.dataPoints, `${metricPath}/gauge/dataPoints`).forEach((point, pointIndex) => {
                    measurements.push(normalizeMeasurement(point, `${metricPath}/gauge/dataPoints/${pointIndex}`, service, name, unit, options));
                });
            });
        });
    });
    return { spans, measurements };
}
export function collectRuntimeEvidence(value, options) {
    validateOptions(options);
    const { spans, measurements } = parseExport(value, options);
    spans.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
    measurements.sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
    const services = [...new Set([
            ...spans.flatMap((span) => span.peer_service === undefined ? [span.service] : [span.service, span.peer_service]),
            ...measurements.map((measurement) => measurement.service),
        ])].sort();
    return {
        contract_version: runtimeEvidenceContractVersion,
        collector: { id: "archsync-otlp-json", version: runtimeCollectorVersion },
        provenance: {
            input_sha256: sha256Canonical(value),
            options_sha256: sha256Canonical(options),
        },
        environment: options.environment,
        window: { ...options.window },
        sampling: { ...options.sampling },
        retention_days: options.retention_days,
        privacy: {
            stored_attribute_allowlist: storedRuntimeAttributeAllowlist,
            sensitive_attributes_rejected: true,
            raw_payload_retained: false,
        },
        services,
        spans,
        measurements,
    };
}
export function serializeRuntimeEvidence(snapshot) {
    return `${canonicalJson(snapshot)}\n`;
}
//# sourceMappingURL=collector.js.map