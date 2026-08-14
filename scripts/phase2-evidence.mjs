import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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

function relativePath(filePath) {
  return relative(root, filePath).replaceAll("\\", "/");
}

async function hashFiles(filePaths) {
  const entries = [];
  for (const filePath of [...filePaths].sort()) {
    entries.push({
      file: relativePath(filePath),
      sha256: sha256(await readFile(filePath)),
    });
  }
  return entries;
}

async function treeSha256(directory) {
  const files = [];
  async function visit(currentDirectory) {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await visit(directory);
  const manifest = await hashFiles(files);
  return {
    files: manifest,
    sha256: sha256(JSON.stringify(manifest)),
  };
}

async function readMeasuredCoverage() {
  const summary = JSON.parse(await readFile(join(root, "coverage", "coverage-summary.json"), "utf8"));
  const measured = {};
  for (const metric of ["statements", "branches", "functions", "lines"]) {
    const value = summary.total?.[metric];
    assert.ok(value, `Coverage summary is missing '${metric}'`);
    assert.equal(value.pct, 100, `${metric} coverage must be 100%`);
    assert.equal(value.covered, value.total, `${metric} coverage contains uncovered items`);
    measured[metric] = {
      covered: value.covered,
      total: value.total,
      percent: value.pct,
    };
  }
  return measured;
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
const measuredCoverage = await readMeasuredCoverage();

const sourceFiles = [
  "contracts.ts",
  "analyzer.ts",
  "guardian.ts",
  "benchmark.ts",
  "bin.ts",
  "demo.ts",
  "doctor.ts",
  "model-cli.ts",
  "phase3-git.ts",
  "phase3.ts",
  "index.ts",
];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
  `src/${file}`,
  sha256(await readFile(join(root, "src", file))),
])));
const fixtureTree = await treeSha256(fixtures);
const verificationSource = await hashFiles([
  join(root, "scripts", "cli-smoke.mjs"),
  join(root, "scripts", "phase2-evidence.mjs"),
  join(root, "src", "analyzer.test.ts"),
  join(root, "src", "benchmark.test.ts"),
  join(root, "src", "doctor.test.ts"),
  join(root, "src", "guardian.test.ts"),
  join(root, "src", "model-cli.test.ts"),
  join(root, "src", "phase3-git.test.ts"),
  join(root, "src", "phase3.test.ts"),
  join(root, "src", "test-helpers.ts"),
  join(root, "tsconfig.json"),
  join(root, "tsconfig.test.json"),
  join(root, "vitest.config.ts"),
]);
const dependencySource = await hashFiles([
  join(root, "package.json"),
  join(root, "pnpm-lock.yaml"),
  join(root, "vendor", "archsync-core-0.1.0.tgz"),
]);

const evidence = {
  phase: 2,
  release: "v0.2",
  objective: "Deterministic TypeScript source analysis into evidence-rich observed architecture findings",
  provenance: {
    implementation_source_sha256: sha256(JSON.stringify(sourceHashes)),
    fixture_tree: fixtureTree,
    verification_source: verificationSource,
    verification_source_sha256: sha256(JSON.stringify(verificationSource)),
    dependency_source: dependencySource,
    dependency_source_sha256: sha256(JSON.stringify(dependencySource)),
  },
  contracts: {
    observed_graph_version: baseline.version,
    finding_contract_version: violation.contract_version,
    source_sha256: sourceHashes,
  },
  core_dependency: {
    repository_commit: "2affbbb0da859a32b9b9079b4bf718fc7b14993b",
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
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    measured_engine_coverage: measuredCoverage,
    cli_smoke_checks: 22,
    canonical_benchmark: {
      repository: "archsync-benchmark",
      command: "pnpm phase2:verify",
      cases: 20,
      minimum_node_precision: 0.85,
      minimum_node_recall: 0.85,
      minimum_edge_precision: 0.85,
      minimum_edge_recall: 0.85,
      exact_classification_required: true,
      source_file_and_line_required: true,
    },
    detector_challenge_corpus: {
      repository: "archsync-benchmark",
      command: "pnpm patterns:verify",
      positive_signals: 20,
      hard_negative_signals: 20,
      exact_signal_classification_required: true,
      repeated_analysis_required: true,
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
