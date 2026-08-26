import { describe, expect, it } from "vitest";

import type {
  IdentityAliasRule,
  InfrastructureDiagnostic,
  InfrastructureEvidence,
  InfrastructureExposure,
  InfrastructureKind,
  InfrastructureObservation,
  InfrastructureSource,
  ParsedInfrastructureReference,
} from "./iac-contracts.js";
import {
  buildCrossSourceEvidenceClaims,
  buildNormalizedInfrastructureGraph,
  classifyEvidenceClaim,
  classifyEvidenceClaims,
  mapCrossSourceIdentities,
  observationsFromParseResult,
} from "./iac-normalize.js";
import { parseTerraform } from "./iac-terraform.js";

function sourceClass(source: InfrastructureSource): "spec" | "code" | "iac" {
  return source === "spec" || source === "code" ? source : "iac";
}

function evidence(source: InfrastructureSource, file: string, offset = 0): InfrastructureEvidence {
  return {
    source,
    file,
    range: {
      start: { line: 1, column: offset + 1, offset },
      end: { line: 1, column: offset + 2, offset: offset + 1 },
    },
    snippet: file,
    detector: `${source}-fixture`,
    confidence: 1,
  };
}

function observation(
  source: InfrastructureSource,
  nativeId: string,
  name: string,
  namespace: string,
  options: {
    aliases?: string[];
    kind?: InfrastructureKind;
    exposure?: InfrastructureExposure;
    approved?: boolean;
    boundary?: string;
    offset?: number;
  } = {},
): InfrastructureObservation {
  return {
    source,
    source_class: sourceClass(source),
    native_id: nativeId,
    name,
    namespace,
    aliases: options.aliases ?? [],
    kind: options.kind ?? "service",
    exposure: options.exposure ?? "internal",
    approved: options.approved ?? false,
    trust_boundary: options.boundary ?? "application",
    attributes: {},
    evidence: [evidence(source, `${source}/${nativeId}`, options.offset)],
  };
}

describe("Phase 5 cross-source identity mapping", () => {
  it("resolves explicit aliases, namespace matches, name-only joins, ambiguity and unknowns", () => {
    const values = [
      observation("spec", "spec-orders", "Orders API", "orders"),
      observation("code", "code-orders", "service", "orders", { aliases: ["orders-service"] }),
      observation("kubernetes", "k8s-orders", "orders-api", "orders"),
      observation("spec", "spec-exact", "billing", "finance"),
      observation("code", "code-exact", "billing", "finance"),
      observation("spec", "spec-name", "worker", "unknown"),
      observation("code", "code-name", "worker", "orders"),
      observation("spec", "spec-ambiguous", "shared", "alpha"),
      observation("code", "code-ambiguous", "shared", "beta"),
      observation("terraform", "tf-unknown", "isolated", "terraform"),
      observation("terraform", "raw-id", "", ""),
      observation("terraform", "", "", ""),
      observation("spec", "spec-global", "payments", "payments"),
    ];
    const aliases: IdentityAliasRule[] = [
      {
        canonical_id: "orders/orders-api",
        namespace: "orders",
        aliases: ["orders-api", "orders-service", "orders api"],
      },
      { canonical_id: "global/payments", namespace: "any", aliases: ["payments"] },
    ];
    const mapped = mapCrossSourceIdentities(values, aliases);
    const byKey = new Map(mapped.resolutions.map((resolution) => [resolution.observation_key, resolution]));

    expect(byKey.get("spec:spec-orders")).toMatchObject({
      canonical_id: "orders/orders-api",
      method: "explicit-alias",
      confidence: 1,
    });
    expect(byKey.get("spec:spec-global")?.canonical_id).toBe("global/payments");
    expect(byKey.get("spec:spec-exact")).toMatchObject({
      canonical_id: "finance/billing",
      method: "namespace-and-name",
      confidence: 0.99,
    });
    expect(byKey.get("code:code-name")).toMatchObject({
      canonical_id: "orders/worker",
      method: "name-only",
      confidence: 0.75,
    });
    expect(byKey.get("spec:spec-ambiguous")?.method).toBe("ambiguous");
    expect(byKey.get("terraform:tf-unknown")?.method).toBe("unknown");
    expect(byKey.get("terraform:raw-id")?.canonical_id).toBe(
      "unknown:iac:global/raw-id@raw-id",
    );
    expect(byKey.get("terraform:")?.canonical_id).toBe(
      "unknown:iac:global/unnamed@unnamed",
    );
    expect(mapped.unknowns).toHaveLength(5);
  });

  it("does not choose between multiple explicit aliases", () => {
    const value = observation("code", "service", "orders", "orders");
    const mapped = mapCrossSourceIdentities([value], [
      { canonical_id: "orders/a", namespace: "orders", aliases: ["orders"] },
      { canonical_id: "orders/b", namespace: "orders", aliases: ["orders"] },
      { canonical_id: "other/ignored", namespace: "other", aliases: ["orders"] },
    ]);

    expect(mapped.resolutions[0]).toMatchObject({
      canonical_id: "ambiguous:code:orders/orders@service",
      method: "ambiguous",
      confidence: 0,
    });
  });
});

describe("Phase 5 normalized infrastructure graph and claims", () => {
  const aliases: IdentityAliasRule[] = [
    {
      canonical_id: "orders/orders-api",
      namespace: "orders",
      aliases: ["orders-api", "orders-service"],
    },
    {
      canonical_id: "orders/orders-cache",
      namespace: "any",
      aliases: ["orders-cache", "cache"],
    },
  ];

  it("builds a stable, de-duplicated graph with mapped and unmapped edges", () => {
    const values = [
      observation("spec", "spec-api", "orders-api", "orders", {
        kind: "service",
        exposure: "internal",
        approved: true,
      }),
      observation("code", "code-api", "orders-service", "orders", {
        kind: "service",
        exposure: "internal",
        offset: 2,
      }),
      observation("kubernetes", "k8s-api", "orders-api", "orders", {
        kind: "workload",
        exposure: "public",
        offset: 3,
      }),
      observation("terraform", "tf-cache", "orders-cache", "terraform", {
        kind: "cache",
        exposure: "private",
        boundary: "data",
      }),
      observation("terraform", "tf-unknown", "mystery", "terraform", {
        kind: "unknown",
        exposure: "unknown",
        boundary: "unknown",
      }),
    ];
    const references: ParsedInfrastructureReference[] = [
      {
        source: "kubernetes",
        from: "k8s-api",
        to: "tf-cache",
        type: "connects-to",
        resolved: false,
        approved_trust_transition: false,
        evidence: [values[2]!.evidence[0]!],
      },
      {
        source: "terraform",
        from: "k8s-api",
        to: "tf-cache",
        type: "connects-to",
        resolved: true,
        approved_trust_transition: true,
        evidence: [values[3]!.evidence[0]!],
      },
      {
        source: "terraform",
        from: "missing-native",
        to: "tf-cache",
        type: "depends-on",
        resolved: false,
        approved_trust_transition: false,
        evidence: [values[3]!.evidence[0]!],
      },
    ];
    const diagnostics: InfrastructureDiagnostic[] = [
      {
        code: "missing-reference",
        severity: "warning",
        message: "same file later",
        evidence: evidence("kubernetes", "a.tf", 4),
      },
      {
        code: "unsupported-resource",
        severity: "warning",
        message: "first",
        evidence: evidence("terraform", "a.tf", 2),
      },
      {
        code: "missing-reference",
        severity: "warning",
        message: "other file",
        evidence: evidence("kubernetes", "z.yaml", 1),
      },
    ];

    const first = buildNormalizedInfrastructureGraph(values, references, diagnostics, aliases);
    const second = buildNormalizedInfrastructureGraph(values, references, diagnostics, aliases);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toMatchObject({ version: "0.1", identity_contract_version: "0.1" });
    expect(first.nodes).toHaveLength(3);
    const api = first.nodes.find(({ id }) => id === "orders/orders-api");
    expect(api).toMatchObject({
      kind: "service",
      exposure: "internal",
      approved: true,
      sources: ["spec", "code", "iac"],
    });
    expect(api?.observations).toHaveLength(3);
    expect(first.edges).toHaveLength(2);
    expect(first.edges.find(({ type }) => type === "connects-to")).toMatchObject({
      from: "orders/orders-api",
      to: "orders/orders-cache",
      resolved: true,
      approved_trust_transition: true,
      sources: ["kubernetes", "terraform"],
    });
    expect(first.edges.find(({ type }) => type === "depends-on")?.from).toBe(
      "unmapped:missing-native",
    );
    expect(first.diagnostics.map(({ message }) => message)).toEqual([
      "first",
      "same file later",
      "other file",
    ]);
  });

  it("creates spec-code-IaC claims and classifies every deterministic outcome", () => {
    const values = [
      observation("spec", "spec-api", "orders-api", "orders", {
        kind: "service",
        exposure: "internal",
      }),
      observation("code", "code-api", "orders-service", "orders", {
        kind: "service",
        exposure: "internal",
      }),
      observation("kubernetes", "k8s-api", "orders-api", "orders", {
        kind: "workload",
        exposure: "public",
      }),
      observation("terraform", "tf-cache", "orders-cache", "terraform", {
        kind: "cache",
        exposure: "private",
        boundary: "data",
      }),
      observation("terraform", "tf-unknown", "mystery", "terraform", {
        kind: "unknown",
        exposure: "unknown",
        boundary: "unknown",
      }),
    ];
    const graph = buildNormalizedInfrastructureGraph(values, [], [], aliases);
    const claims = buildCrossSourceEvidenceClaims(graph);
    const classified = classifyEvidenceClaims([...claims].reverse());

    expect(claims).toHaveLength(12);
    expect(classified.map(({ id }) => id)).toEqual([...classified.map(({ id }) => id)].sort());
    expect(
      classified.find(({ id }) => id === "claim:orders/orders-api:identity"),
    ).toMatchObject({ classification: "aligned", confidence: 1, missing_sources: [] });
    expect(classified.find(({ id }) => id === "claim:orders/orders-api:kind")).toMatchObject({
      classification: "contradiction",
      confidence: 1,
    });
    expect(
      classified.find(({ id }) => id === "claim:orders/orders-cache:exposure"),
    ).toMatchObject({ classification: "missing-source", confidence: 0.33 });
    expect(
      classified.find(({ subject }) => subject.startsWith("unknown:")),
    ).toMatchObject({ classification: "identity-uncertain", confidence: 0.25 });

    const aligned = claims.find(({ id }) => id === "claim:orders/orders-api:trust-boundary")!;
    expect(classifyEvidenceClaim(aligned).reason).toBe(
      "Spec, code and IaC report the same value",
    );
  });

  it("adapts parser resources into IaC observations without losing evidence", () => {
    const parsed = parseTerraform(
      'resource "aws_db_instance" "orders" { name = "orders-db"\n publicly_accessible = true }',
      "infra.tf",
    );
    const adapted = observationsFromParseResult(parsed);

    expect(adapted).toHaveLength(1);
    expect(adapted[0]).toMatchObject({
      source: "terraform",
      source_class: "iac",
      native_id: "terraform:aws:aws_db_instance:orders",
      name: "orders-db",
      kind: "database",
      exposure: "public",
    });
    expect(adapted[0]?.evidence[0]?.file).toBe("infra.tf");
  });
});
