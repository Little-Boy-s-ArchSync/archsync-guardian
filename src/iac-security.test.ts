import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  InfrastructureEvidence,
  InfrastructureExposure,
  InfrastructureKind,
  InfrastructureReferenceType,
  NormalizedInfrastructureGraph,
} from "./iac-contracts.js";
import { evaluateInfrastructureSecurity } from "./iac-security.js";

interface SecurityFixture {
  nodes: Array<{
    id: string;
    kind: InfrastructureKind;
    exposure: InfrastructureExposure;
    approved: boolean;
    trust_boundary: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: InfrastructureReferenceType;
    approved_trust_transition: boolean;
    resolved?: boolean;
  }>;
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (...parts: string[]) => join(root, "test", "fixtures", "iac", "security", ...parts);

function evidence(file: string, offset: number): InfrastructureEvidence {
  return {
    source: "kubernetes",
    file,
    range: {
      start: { line: 1, column: offset + 1, offset },
      end: { line: 1, column: offset + 2, offset: offset + 1 },
    },
    snippet: file,
    detector: "security-fixture",
    confidence: 1,
  };
}

async function loadGraph(name: string): Promise<NormalizedInfrastructureGraph> {
  const fixtureValue = JSON.parse(await readFile(fixture(name), "utf8")) as SecurityFixture;
  return {
    version: "0.1",
    identity_contract_version: "0.1",
    nodes: fixtureValue.nodes.map((node, index) => ({
      ...node,
      namespace: node.id.split("/")[0]!,
      aliases: [node.id],
      sources: ["iac"],
      observations: [],
      evidence: [evidence(index % 2 === 0 ? "z.yaml" : "a.yaml", index)],
    })),
    edges: fixtureValue.edges.map((edge, index) => ({
      ...edge,
      key: `${edge.from}|${edge.type}|${edge.to}`,
      resolved: edge.resolved ?? true,
      sources: ["kubernetes"],
      evidence: [evidence("edge.yaml", index)],
    })),
    diagnostics: [],
  };
}

describe("Phase 5 infrastructure security rules", () => {
  it("detects every governed positive fixture deterministically", async () => {
    const graph = await loadGraph("positive.json");
    const first = evaluateInfrastructureSecurity(graph);
    const second = evaluateInfrastructureSecurity(graph);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.map(({ rule_id }) => rule_id)).toEqual([
      "IAC-PUBLIC-DATABASE",
      "IAC-TRUST-BOUNDARY",
      "IAC-UNAPPROVED-DATA-SERVICE",
      "IAC-UNAPPROVED-DATA-SERVICE",
      "IAC-UNEXPECTED-INGRESS",
    ]);
    expect(first.map(({ severity }) => severity)).toEqual([
      "critical",
      "critical",
      "high",
      "high",
      "high",
    ]);
    const transition = first.find(({ rule_id }) => rule_id === "IAC-TRUST-BOUNDARY");
    expect(transition).toMatchObject({
      subject: "public/orders-ingress",
      edge: "public/orders-ingress|routes-to|application/orders-api",
    });
    expect(transition?.evidence.map(({ file }) => file)).toEqual([
      "a.yaml",
      "edge.yaml",
      "z.yaml",
    ]);
  });

  it("keeps approved, private, same-boundary, unknown-target and irrelevant-edge fixtures clean", async () => {
    const graph = await loadGraph("hard-negative.json");

    expect(evaluateInfrastructureSecurity(graph)).toEqual([]);
  });

  it("produces stable sanitized finding identities", async () => {
    const graph = await loadGraph("positive.json");
    graph.nodes[0]!.id = "Data/Orders DB@primary";

    const finding = evaluateInfrastructureSecurity(graph).find(
      ({ rule_id }) => rule_id === "IAC-PUBLIC-DATABASE",
    );
    expect(finding?.id).toBe("iac-public-database:data/orders-db-primary");
  });
});
