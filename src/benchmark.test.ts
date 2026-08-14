import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { evaluatePhase2Benchmark, formatBenchmarkResult } from "./benchmark.js";
import { checkRepository } from "./guardian.js";
import { baselineSources, writeSources } from "./test-helpers.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "archsync-phase2-benchmark-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeBenchmark(options: { invalidArchitecture?: boolean; invalidPatch?: boolean } = {}): Promise<string> {
  const repository = join(root, "repository");
  await writeSources(repository, baselineSources);
  const architecture = options.invalidArchitecture
    ? "version: invalid\n"
    : `version: "0.1"
metadata:
  name: phase2-test
components:
  frontend:
    type: frontend
    layer: experience
  gateway:
    type: gateway
    layer: edge
  service:
    type: service
    layer: domain
  postgres:
    type: database
    layer: data
relationships:
  - from: frontend
    to: gateway
    type: http
  - from: gateway
    to: service
    type: http
  - from: service
    to: postgres
    type: data
rules:
  - id: ARCH-001
    type: deny
    from: frontend
    to: postgres
    relationship_type: data
    severity: critical
`;
  await writeFile(join(root, "architecture.yaml"), architecture, "utf8");
  await mkdir(join(root, "changes"), { recursive: true });
  const patch = options.invalidPatch
    ? "not a patch\n"
    : `diff --git a/frontend/src/database.ts b/frontend/src/database.ts
new file mode 100644
--- /dev/null
+++ b/frontend/src/database.ts
@@ -0,0 +1,5 @@
+import { Client } from "pg";
+const database = new Client({ connectionString: process.env.DATABASE_URL });
+export async function load(): Promise<void> {
+  await database.query("select 1");
+}
`;
  await writeFile(join(root, "changes", "case-01.patch"), patch, "utf8");
  const manifest = {
    version: "0.1",
    benchmark: {
      id: "phase2-test",
      architecture: "architecture.yaml",
      repository: "repository",
      stack: "TypeScript/Node.js",
      expected_distribution: { "no-impact": 0, violation: 1, evolution: 0 },
    },
    cases: [
      {
        id: "case-01",
        title: "Frontend database access",
        owner: "frontend-team",
        category: "violation",
        risk: "high",
        description: "Adds forbidden data access",
        patch: "changes/case-01.patch",
        changed_files: ["frontend/src/database.ts"],
        delta: {
          relationships_added: [{ from: "frontend", to: "postgres", type: "data" }],
        },
        acceptance_criteria: ["ARCH-001 is reported"],
        expected: {
          classification: "violation",
          findings: [{ id: "ARCH-001", kind: "deny-rule", severity: "critical", from: "frontend", to: "postgres" }],
          evidence: [{ file: "frontend/src/database.ts", line: 4, kind: "source-location" }],
          approval_required: false,
        },
      },
    ],
  };
  const manifestPath = join(root, "ground-truth.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifestPath;
}

describe("Phase 2 benchmark evaluator", () => {
  it("measures classification, graph detection, evidence and determinism", async () => {
    const result = await evaluatePhase2Benchmark(await writeBenchmark());

    expect(result.valid).toBe(true);
    expect(result.metrics).toMatchObject({
      classification_accuracy: 1,
      evidence_file_accuracy: 1,
      evidence_line_accuracy: 1,
      deterministic_cases: 1,
      total_cases: 1,
    });
    expect(result.metrics.full_graph_nodes).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.metrics.full_graph_edges).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.metrics.changed_nodes).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.metrics.changed_edges).toMatchObject({ precision: 1, recall: 1, f1: 1 });
    expect(result.cases[0]).toMatchObject({
      classification_match: true,
      rule_match: true,
      actual_rule_ids: ["ARCH-001"],
      evidence_line_match: true,
    });
    expect(formatBenchmarkResult(result)).toContain("VALID PHASE 2 BENCHMARK phase2-test");
  });

  it("rejects an invalid benchmark architecture", async () => {
    await expect(evaluatePhase2Benchmark(await writeBenchmark({ invalidArchitecture: true })))
      .rejects.toThrow(/Invalid benchmark architecture/);
  });

  it("reports a patch that cannot be applied", async () => {
    await expect(evaluatePhase2Benchmark(await writeBenchmark({ invalidPatch: true })))
      .rejects.toThrow(/patch failed/);
  });

  it("reports classification and rule-contract disagreements", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].expected.classification = "no-impact";
    manifest.cases[0].expected.findings = [];
    manifest.cases[0].expected.evidence = [];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.issues.join("\n")).toMatch(/classification violation != no-impact/);
    expect(result.issues.join("\n")).toMatch(/rule findings \[ARCH-001\] != \[\]/);
    expect(formatBenchmarkResult(result)).toContain("INVALID PHASE 2 BENCHMARK");
  });

  it("fails the precision and recall gate for an incorrect declared delta", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].delta = {};
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.metrics.full_graph_edges.precision).toBeLessThan(0.85);
    expect(result.metrics.changed_edges.precision).toBeLessThan(0.85);
    expect(result.issues).toContain("metrics: full graph edge precision/recall is below 0.85");
    expect(result.issues).toContain("metrics: changed edge precision/recall is below 0.85");
  });

  it("fails node precision and recall gates for an incorrect component delta", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].delta.components_added = {
      redis: { type: "cache", layer: "data" },
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.metrics.full_graph_nodes.recall).toBeLessThan(0.85);
    expect(result.metrics.changed_nodes.recall).toBeLessThan(0.85);
    expect(result.issues).toContain("metrics: full graph node precision/recall is below 0.85");
    expect(result.issues).toContain("metrics: changed node precision/recall is below 0.85");
  });

  it("reports evidence that does not match the expected file and line", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].expected.evidence = [
      { file: "frontend/src/other.ts", line: 99, kind: "source-location" },
    ];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.metrics.evidence_file_accuracy).toBe(0);
    expect(result.metrics.evidence_line_accuracy).toBe(0);
    expect(result.issues.join("\n")).toMatch(/source evidence file does not match/);
    expect(result.issues.join("\n")).toMatch(/source evidence line does not match/);
  });

  it("reports a missing expected evidence location without crashing", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].expected.evidence = [];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.valid).toBe(false);
    expect(result.cases[0]).toMatchObject({ evidence_file_match: false, evidence_line_match: false });
  });

  it("reports when no actual finding matches the expected finding identity", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].expected.findings[0] = {
      id: "ARCH-404",
      kind: "deny-rule",
      severity: "critical",
      from: "gateway",
      to: "service",
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.cases[0]).toMatchObject({ actual_evidence: [], evidence_file_match: false });
  });

  it("matches evidence by finding kind and edge when the declared rule id differs", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].expected.findings[0].id = "RENAMED-RULE";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.cases[0]).toMatchObject({ evidence_file_match: true, evidence_line_match: true });
  });

  it("calculates zero F1 for disjoint expected and actual changed-edge sets", async () => {
    const manifestPath = await writeBenchmark();
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.cases[0].delta.relationships_added = [
      { from: "service", to: "gateway", type: "http" },
    ];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const result = await evaluatePhase2Benchmark(manifestPath);

    expect(result.metrics.changed_edges).toMatchObject({ precision: 0, recall: 0, f1: 0 });
  });

  it("detects nondeterminism in both baseline and patched-case replays", async () => {
    const manifestPath = await writeBenchmark();
    let invocation = 0;
    const nondeterministicChecker: typeof checkRepository = async (expected, repository) => {
      invocation += 1;
      const result = await checkRepository(expected, repository);
      if (invocation === 1) {
        return { ...result, classification: "violation", decision: "BLOCK" };
      }
      if (invocation === 4) {
        return {
          ...result,
          observed: {
            ...result.observed,
            metadata: { ...result.observed.metadata, name: "nondeterministic-repeat" },
          },
        };
      }
      return result;
    };

    const result = await evaluatePhase2Benchmark(manifestPath, {
      checkRepository: nondeterministicChecker,
    });

    expect(result.valid).toBe(false);
    expect(result.issues).toContain("baseline: expected no-impact, found violation");
    expect(result.issues).toContain("baseline: analyzer output is nondeterministic");
    expect(result.issues).toContain("case-01: analyzer output is nondeterministic");
  });
});
