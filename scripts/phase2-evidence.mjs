import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadArchitecture } from "@archsync/core";
import { analyzeTypeScriptRepository, checkRepository } from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidencePath = join(root, "evidence", "phase-2-evidence.json");
const fixtures = join(root, "test", "fixtures");
const writeMode = process.argv.includes("--write");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const architectureResult = await loadArchitecture(join(fixtures, "architecture.yaml"));
assert.equal(architectureResult.valid, true);
assert.ok(architectureResult.value);
const expected = architectureResult.value;
const baseline = await analyzeTypeScriptRepository(join(fixtures, "baseline"), expected);
const repeated = await analyzeTypeScriptRepository(join(fixtures, "baseline"), expected);
assert.equal(JSON.stringify(baseline), JSON.stringify(repeated), "Analyzer must be deterministic");
const clean = await checkRepository(expected, join(fixtures, "baseline"));
assert.equal(clean.classification, "no-impact");
const violation = await checkRepository(expected, join(fixtures, "violation"));
assert.equal(violation.classification, "violation");
const arch001 = violation.findings.find(({ rule_id }) => rule_id === "ARCH-001");
assert.ok(arch001);
assert.deepEqual(
  arch001.source_evidence.map(({ file, line, detector }) => ({ file, line, detector })),
  [{ file: "frontend/src/database.ts", line: 6, detector: "typescript-pg" }],
);

const sourceFiles = ["contracts.ts", "analyzer.ts", "guardian.ts", "benchmark.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
  `src/${file}`,
  sha256(await readFile(join(root, "src", file))),
])));

const evidence = {
  phase: 2,
  release: "v0.1",
  objective: "Deterministic TypeScript source analysis into evidence-rich observed architecture findings",
  contracts: {
    observed_graph_version: baseline.version,
    finding_contract_version: violation.contract_version,
    source_sha256: sourceHashes,
  },
  core_dependency: {
    repository_commit: "304f4ac48137e011ec5f7fd85071a89502c02ada",
    vendored_package: "vendor/archsync-core-0.1.0.tgz",
    vendored_package_sha256: sha256(await readFile(join(root, "vendor", "archsync-core-0.1.0.tgz"))),
    consumption_contract: "peerDependency ^0.1.0",
  },
  analyzer: {
    id: baseline.analyzer.id,
    version: baseline.analyzer.version,
    stack: baseline.analyzer.stack,
    supported_detectors: [
      "typescript-fetch",
      "typescript-pg",
      "typescript-redis",
      "typescript-amqp-publish",
      "typescript-amqp-consume",
    ],
    deterministic: true,
    baseline_components: Object.keys(baseline.components),
    baseline_relationships: baseline.relationships.map(({ from, type, to }) => `${from}|${type}|${to}`),
    normalized_observed_sha256: sha256(JSON.stringify(baseline)),
  },
  finding_demo: {
    classification: violation.classification,
    decision: violation.decision,
    rule_id: arch001.rule_id,
    edge: arch001.edge?.key,
    source_evidence: arch001.source_evidence.map(({ file, line, column, detector, confidence }) => ({
      file,
      line,
      column,
      detector,
      confidence,
    })),
    normalized_result_sha256: sha256(JSON.stringify(violation)),
  },
  enforced_gates: {
    coverage_thresholds_percent: {
      statements: 90,
      branches: 85,
      functions: 90,
      lines: 90,
    },
    cli_smoke_checks: 7,
    canonical_benchmark: {
      repository: "archsync-benchmark",
      command: "pnpm phase2:verify",
      cases: 10,
      minimum_node_precision: 0.85,
      minimum_node_recall: 0.85,
      minimum_edge_precision: 0.85,
      minimum_edge_recall: 0.85,
      exact_classification_required: true,
      source_file_and_line_required: true,
    },
  },
  exclusions: [
    "Git diff and pull-request annotation (Phase 3)",
    "LLM, MCP, IaC and runtime analysis",
    "Automatic repair or architecture baseline updates",
  ],
};

const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
if (writeMode) {
  await writeFile(evidencePath, serialized, "utf8");
  console.log(`WROTE ${evidencePath}`);
} else {
  assert.equal(
    await readFile(evidencePath, "utf8"),
    serialized,
    "Phase 2 evidence is stale; run 'pnpm evidence:update' and commit the result",
  );
  console.log(`VALID PHASE 2 EVIDENCE ${evidencePath}`);
}
