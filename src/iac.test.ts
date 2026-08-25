import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  InfrastructureEvidence,
  InfrastructureObservation,
  InfrastructureSource,
} from "./iac-contracts.js";
import { analyzeInfrastructureSources } from "./iac.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (...parts: string[]) => join(root, "test", "fixtures", "iac", ...parts);

function evidence(source: InfrastructureSource, file: string): InfrastructureEvidence {
  return {
    source,
    file,
    range: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 2, offset: 1 },
    },
    snippet: file,
    detector: `${source}-architecture`,
    confidence: 1,
  };
}

function architectureObservation(
  source: "spec" | "code",
  nativeId: string,
  name: string,
  kind: InfrastructureObservation["kind"],
  boundary: string,
): InfrastructureObservation {
  return {
    source,
    source_class: source,
    native_id: nativeId,
    name,
    namespace: "orders",
    aliases: [name],
    kind,
    exposure: kind === "database" ? "private" : "internal",
    approved: true,
    trust_boundary: boundary,
    attributes: {},
    evidence: [evidence(source, `${source}/${nativeId}`)],
  };
}

describe("Phase 5 infrastructure analysis orchestration", () => {
  it("joins Terraform, Kubernetes, spec and code into one reproducible result", async () => {
    const terraform = await readFile(fixture("terraform", "positive.tf"), "utf8");
    const kubernetes = await readFile(fixture("kubernetes", "positive.yaml"), "utf8");
    const architectureObservations = [
      architectureObservation("spec", "spec-api", "orders-api", "service", "application"),
      architectureObservation("code", "code-api", "orders-api", "service", "application"),
      architectureObservation("spec", "spec-db", "orders-db", "database", "data"),
      architectureObservation("code", "code-db", "orders-db", "database", "data"),
    ];
    const input = {
      terraform_files: { "infra/main.tf": terraform },
      kubernetes_files: { "deploy/orders.yaml": kubernetes },
      architecture_observations: architectureObservations,
      architecture_references: [],
      alias_rules: [
        {
          canonical_id: "orders/orders-api",
          namespace: "any",
          aliases: ["orders-api"],
        },
        {
          canonical_id: "orders/orders-db",
          namespace: "any",
          aliases: ["orders-db", "orders"],
        },
      ],
    } as const;

    const first = analyzeInfrastructureSources(input);
    const second = analyzeInfrastructureSources(input);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.contract_version).toBe("0.1");
    expect(first.terraform.resources).toHaveLength(5);
    expect(first.kubernetes.resources).toHaveLength(4);
    expect(first.graph.nodes.find(({ id }) => id === "orders/orders-api")?.sources).toEqual([
      "spec",
      "code",
      "iac",
    ]);
    expect(first.graph.nodes.find(({ id }) => id === "orders/orders-db")?.sources).toEqual([
      "spec",
      "code",
      "iac",
    ]);
    expect(first.claims.some(({ classification }) => classification === "contradiction")).toBe(true);
    expect(first.security_findings.map(({ rule_id }) => rule_id)).toEqual(
      expect.arrayContaining([
        "IAC-PUBLIC-DATABASE",
        "IAC-TRUST-BOUNDARY",
        "IAC-UNAPPROVED-DATA-SERVICE",
        "IAC-UNEXPECTED-INGRESS",
      ]),
    );
  });
});
