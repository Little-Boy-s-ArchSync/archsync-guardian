import { describe, expect, it } from "vitest";

import {
  collectRuntimeEvidence,
  RuntimeEvidenceError,
  serializeRuntimeEvidence,
} from "./collector.js";
import { canonicalJson, canonicalize, sha256Canonical } from "./canonical.js";
import type { OtlpAttribute, OtlpExport, RuntimeCollectionOptions } from "./contracts.js";

function stringAttribute(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}

function resource(service: string): { attributes: OtlpAttribute[] } {
  return {
    attributes: [
      stringAttribute("service.name", service),
      stringAttribute("deployment.environment.name", "test"),
    ],
  };
}

function span(
  id: number,
  kind: number,
  attributes: OtlpAttribute[],
  status: { code?: number } | undefined = undefined,
) {
  return {
    traceId: id.toString(16).padStart(32, "a"),
    spanId: id.toString(16).padStart(16, "b"),
    name: `span-${id}-contains-no-output`,
    kind,
    startTimeUnixNano: String(1_000_000_000 + id * 100_000_000),
    endTimeUnixNano: String(1_050_000_000 + id * 100_000_000),
    attributes,
    ...(status === undefined ? {} : { status }),
  };
}

function fixture(): OtlpExport {
  return {
    resourceSpans: [{
      resource: resource("order-service"),
      scopeSpans: [{
        spans: [
          span(5, 1, [{ key: "fixture.flag", value: { boolValue: true } }]),
          span(4, 5, [
            stringAttribute("peer.service", "producer"),
            stringAttribute("messaging.system", "amqp"),
          ]),
          span(3, 4, [
            stringAttribute("messaging.destination.name", "events"),
            stringAttribute("messaging.system", "amqp"),
          ]),
          span(2, 3, [
            stringAttribute("server.address", "postgres"),
            stringAttribute("db.system", "postgresql"),
          ], { code: 2 }),
          span(1, 3, [
            stringAttribute("peer.service", "inventory-service"),
            stringAttribute("http.request.method", "GET"),
          ], { code: 1 }),
          span(6, 2, [
            stringAttribute("peer.service", "api-gateway"),
            stringAttribute("rpc.system", "grpc"),
          ]),
          span(7, 0, []),
        ],
      }],
    }],
    resourceMetrics: [{
      resource: resource("order-service"),
      scopeMetrics: [{
        metrics: [
          {
            name: "archsync.goal.p95_latency",
            unit: "ms",
            gauge: { dataPoints: [{
              timeUnixNano: "3000000000",
              attributes: [stringAttribute("archsync.goal.id", "LAT-001")],
              asDouble: "180.5",
            }] },
          },
          {
            name: "archsync.goal.availability_ratio",
            unit: "ratio",
            gauge: { dataPoints: [{
              timeUnixNano: "3000000001",
              attributes: [stringAttribute("archsync.goal.id", "AVL-001")],
              asInt: 1,
            }] },
          },
        ],
      }],
    }],
  };
}

function options(): RuntimeCollectionOptions {
  return {
    environment: "test",
    window: { start_unix_nano: "1000000000", end_unix_nano: "4000000000" },
    sampling: { strategy: "fixture-replay", rate: 1 },
    retention_days: 14,
  };
}

describe("runtime evidence collector", () => {
  it("normalizes spans and metrics deterministically without retaining arbitrary attributes", () => {
    const first = collectRuntimeEvidence(fixture(), options());
    const second = collectRuntimeEvidence(fixture(), options());

    expect(first).toEqual(second);
    expect(first.services).toEqual([
      "api-gateway",
      "events",
      "inventory-service",
      "order-service",
      "postgres",
      "producer",
    ]);
    expect(first.spans).toHaveLength(7);
    expect(first.measurements.map((measurement) => measurement.value).sort()).toEqual([1, 180.5]);
    expect(first.spans.map((item) => item.direction)).toEqual(
      expect.arrayContaining(["outbound", "inbound", "internal"]),
    );
    expect(first.spans.map((item) => item.relationship_type)).toEqual(
      expect.arrayContaining(["http", "async", "data", "dependency"]),
    );
    expect(first.spans.some((item) => item.error)).toBe(true);
    expect(JSON.stringify(first)).not.toContain("contains-no-output");
    expect(JSON.stringify(first)).not.toContain("fixture.flag");
    expect(serializeRuntimeEvidence(first)).toBe(`${canonicalJson(first)}\n`);
    expect(first.provenance.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.provenance.options_sha256).toBe(sha256Canonical(options()));
  });

  it("canonicalizes nested objects while preserving array order and primitives", () => {
    expect(canonicalize({ z: [{ b: 2, a: 1 }], a: null })).toEqual({
      a: null,
      z: [{ a: 1, b: 2 }],
    });
    expect(canonicalize("value")).toBe("value");
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("rejects invalid collection options", () => {
    const cases: Array<[RuntimeCollectionOptions, string]> = [
      [{ ...options(), environment: "" }, "/options/environment"],
      [{ ...options(), window: { ...options().window, start_unix_nano: "x" } }, "unsigned unix"],
      [{ ...options(), window: { start_unix_nano: "3", end_unix_nano: "2" } }, "start must"],
      [{ ...options(), sampling: { strategy: "other" as "head", rate: 1 } }, "strategy"],
      [{ ...options(), sampling: { strategy: "head", rate: 0 } }, "sampling rate"],
      [{ ...options(), sampling: { strategy: "tail", rate: 1.1 } }, "sampling rate"],
      [{ ...options(), retention_days: 0 }, "retention"],
      [{ ...options(), retention_days: 31 }, "retention"],
      [{ ...options(), retention_days: 1.5 }, "retention"],
    ];
    cases.forEach(([input, expected]) => {
      expect(() => collectRuntimeEvidence(fixture(), input)).toThrow(expected);
    });
  });

  it("rejects malformed and privacy-unsafe OTLP data with an exact path", () => {
    const cases: Array<[(input: Record<string, unknown>) => void, string]> = [
      [(input) => { input.resourceSpans = {}; }, "/resourceSpans"],
      [(input) => { input.resourceMetrics = {}; }, "/resourceMetrics"],
      [(input) => { (input.resourceSpans as unknown[])[0] = null; }, "/resourceSpans/0"],
      [(input) => { ((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes = {}; }, "/attributes"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as unknown[]); attrs[0] = null; }, "/attributes/0"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs[0]!.key = ""; }, "non-empty string"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs.push(stringAttribute("authorization.token", "do-not-print") as unknown as Record<string, unknown>); }, "sensitive attribute key"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs.push(stringAttribute("service.name", "duplicate") as unknown as Record<string, unknown>); }, "duplicate attribute"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs[0]!.value = {}; }, "exactly one scalar"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs[0]!.value = { stringValue: "a", intValue: 1 }; }, "exactly one scalar"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs[0]!.value = { boolValue: "yes" }; }, "expected a boolean"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs[0]!.value = { doubleValue: "many" }; }, "finite number"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); attrs.splice(0, 1); }, "service.name"],
      [(input) => { const attrs = (((input.resourceSpans as Array<Record<string, unknown>>)[0]!.resource as Record<string, unknown>).attributes as Array<Record<string, unknown>>); (attrs[1]!.value as Record<string, unknown>).stringValue = "prod"; }, "environment mismatch"],
    ];
    cases.forEach(([mutate, expected]) => {
      const input = structuredClone(fixture()) as unknown as Record<string, unknown>;
      mutate(input);
      try {
        collectRuntimeEvidence(input, options());
        throw new Error("expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeEvidenceError);
        expect((error as Error).message).toContain(expected);
        expect((error as Error).message).not.toContain("do-not-print");
      }
    });
  });

  it("rejects malformed spans and gauge points", () => {
    const spanCases: Array<[(item: Record<string, unknown>) => void, string]> = [
      [(item) => { item.traceId = "not-hex"; }, "hexadecimal"],
      [(item) => { item.name = ""; }, "non-empty string"],
      [(item) => { item.kind = 1.5; }, "span kind"],
      [(item) => { item.kind = 6; }, "span kind"],
      [(item) => { item.startTimeUnixNano = "bad"; }, "unsigned unix"],
      [(item) => { item.startTimeUnixNano = "999999999"; }, "outside"],
      [(item) => { item.endTimeUnixNano = "1000000000"; }, "must not precede"],
      [(item) => { item.attributes = {}; }, "expected an array"],
      [(item) => { item.status = null; }, "expected an object"],
      [(item) => { item.status = { code: 3 }; }, "status code"],
    ];
    spanCases.forEach(([mutate, expected]) => {
      const input = structuredClone(fixture());
      const item = input.resourceSpans[0]!.scopeSpans[0]!.spans[0]! as unknown as Record<string, unknown>;
      mutate(item);
      expect(() => collectRuntimeEvidence(input, options())).toThrow(expected);
    });

    const metricCases: Array<[(point: Record<string, unknown>) => void, string]> = [
      [(point) => { point.timeUnixNano = "999999999"; }, "outside"],
      [(point) => { point.attributes = []; }, "archsync.goal.id"],
      [(point) => { delete point.asDouble; }, "exactly one numeric"],
      [(point) => { point.asInt = 2; }, "exactly one numeric"],
      [(point) => { point.asDouble = "many"; }, "finite number"],
    ];
    metricCases.forEach(([mutate, expected]) => {
      const input = structuredClone(fixture());
      const point = input.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge.dataPoints[0]! as unknown as Record<string, unknown>;
      mutate(point);
      expect(() => collectRuntimeEvidence(input, options())).toThrow(expected);
    });
  });
});
