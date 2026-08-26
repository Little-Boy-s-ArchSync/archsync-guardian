import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadArchitecture } from "@archsync/core";
import {
  analyzeTypeScriptRepository,
  checkRepository,
  coreDependencyProvenance,
  coreGuardianContractMatrix,
} from "../dist/index.js";

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
      complete: true,
      percent: value.pct,
      all_items_covered: true,
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

const [currentArchitecture, previousArchitecture, unsupportedArchitecture] = await Promise.all([
  loadArchitecture(join(fixtures, "compatibility", "current.architecture.yaml")),
  loadArchitecture(join(fixtures, "compatibility", "previous.architecture.yaml")),
  loadArchitecture(join(fixtures, "compatibility", "unsupported.architecture.yaml")),
]);
assert.equal(currentArchitecture.valid, true);
assert.equal(previousArchitecture.valid, true);
assert.ok(currentArchitecture.value);
assert.ok(previousArchitecture.value);
const [currentReplay, previousReplay] = await Promise.all([
  checkRepository(currentArchitecture.value, join(fixtures, "violation")),
  checkRepository(previousArchitecture.value, join(fixtures, "violation")),
]);
assert.deepEqual(previousReplay, currentReplay, "Core current/previous Guardian replay differs");
assert.equal(unsupportedArchitecture.valid, false);
assert.equal(
  unsupportedArchitecture.issues[0]?.message,
  "Unsupported architecture contract version '9.0.0'. Supported versions: 0.1.1, 0.1.0, 0.1.",
);

const detectorArchitecture = await loadArchitecture(join(fixtures, "detectors", "architecture.yaml"));
assert.equal(detectorArchitecture.valid, true);
assert.ok(detectorArchitecture.value);
const detectorRepository = join(fixtures, "detectors", "repository");
const detectorObserved = await analyzeTypeScriptRepository(detectorRepository, detectorArchitecture.value);
const repeatedDetectorObserved = await analyzeTypeScriptRepository(detectorRepository, detectorArchitecture.value);
assert.deepEqual(repeatedDetectorObserved, detectorObserved, "Detector fixture must be deterministic");
const detectorResult = await checkRepository(detectorArchitecture.value, detectorRepository);
assert.equal(detectorResult.classification, "no-impact");
const detectorEvidence = detectorObserved.relationships.map(({ from, type, to, evidence }) => ({
  edge: `${from}|${type}|${to}`,
  source_evidence: evidence.map(({ file, line, column, detector, confidence }) => ({
    file,
    line,
    column,
    detector,
    confidence,
  })),
}));
assert.deepEqual(detectorEvidence.map(({ edge }) => edge), [
  "amqp|async|worker",
  "frontend|http|service",
  "service|async|amqp",
  "service|data|postgres",
  "service|data|redis",
]);
const sourceEvidenceRecord = ({ file, line, column, detector, confidence }) => ({
  file,
  line,
  column,
  detector,
  confidence,
});
const componentRootExample = detectorObserved.components.utility?.evidence.find(
  ({ detector }) => detector === "component-root",
);
assert.ok(componentRootExample);
const detectorExamples = {
  "component-root": sourceEvidenceRecord(componentRootExample),
};
for (const relationship of detectorObserved.relationships) {
  for (const item of relationship.evidence) {
    detectorExamples[item.detector] = sourceEvidenceRecord(item);
  }
}
assert.deepEqual(Object.keys(detectorExamples).sort(), [
  "component-root",
  "typescript-amqp-consume",
  "typescript-amqp-publish",
  "typescript-fetch",
  "typescript-pg",
  "typescript-redis",
]);
const measuredCoverage = await readMeasuredCoverage();

const sourceFiles = [
  "contracts.ts",
  "compatibility.ts",
  "analyzer.ts",
  "guardian.ts",
  "benchmark.ts",
  "bin.ts",
  "demo.ts",
  "doctor.ts",
  "model-cli.ts",
  "phase3-git.ts",
  "phase3.ts",
  "privacy.ts",
  "index.ts",
  "version.ts",
];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
  `src/${file}`,
  sha256(await readFile(join(root, "src", file))),
])));
const fixtureTree = await treeSha256(fixtures);
const verificationSource = await hashFiles([
  join(root, "scripts", "cli-smoke.mjs"),
  join(root, "scripts", "core-compatibility.mjs"),
  join(root, "scripts", "phase2-evidence.mjs"),
  join(root, "src", "analyzer.test.ts"),
  join(root, "src", "benchmark.test.ts"),
  join(root, "src", "compatibility.test.ts"),
  join(root, "src", "doctor.test.ts"),
  join(root, "src", "guardian.test.ts"),
  join(root, "src", "model-cli.test.ts"),
  join(root, "src", "phase3-git.test.ts"),
  join(root, "src", "phase3.test.ts"),
  join(root, "src", "version.test.ts"),
  join(root, "scripts", "package-install-e2e.mjs"),
  join(root, "scripts", "package-provenance.mjs"),
  join(root, "scripts", "verify-clean-worktree.mjs"),
  join(root, "scripts", "verify-offline.mjs"),
  join(root, "src", "privacy.test.ts"),
  join(root, "docs", "OPERATIONS-PRIVACY.md"),
  join(root, "docs", "contract-compatibility.md"),
  join(root, "docs", "support-matrix.md"),
  join(root, "docs", "migrations", "core-0.1.0-to-0.1.1.md"),
  join(root, ".github", "workflows", "ci.yml"),
  join(root, "src", "test-helpers.ts"),
  join(root, "tsconfig.json"),
  join(root, "tsconfig.test.json"),
  join(root, "vitest.config.ts"),
]);
const dependencySource = await hashFiles([
  join(root, "pnpm-workspace.yaml"),
  join(root, "package.json"),
  join(root, "pnpm-lock.yaml"),
  join(root, coreDependencyProvenance.vendored_artifact),
  join(root, coreDependencyProvenance.provenance_artifact),
  join(root, "vendor", "archsync-core-0.1.1.tgz"),
  join(root, "vendor", "archsync-core-0.1.1.provenance.json"),
  join(root, "vendor", "README.md"),
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
    core_guardian_matrix: coreGuardianContractMatrix,
    source_sha256: sourceHashes,
  },
  core_dependency: {
    repository: coreDependencyProvenance.repository,
    repository_commit: coreDependencyProvenance.source_commit,
    source_pull_request: coreDependencyProvenance.source_pull_request,
    included_source_commits: coreDependencyProvenance.included_source_commits,
    vendored_package: coreDependencyProvenance.vendored_artifact,
    vendored_package_sha256: sha256(await readFile(join(root, coreDependencyProvenance.vendored_artifact))),
    consumption_contract: "bundled runtime dependency @archsync/core 0.1.1 with compatibility contracts and proposed quality-goal v0.2 contract",
    dependency_status: coreDependencyProvenance.dependency_status,
    reproducibility: {
      independent_pack_runs: 2,
      byte_identical: true,
    },
  },
  analyzer: {
    id: baseline.analyzer.id,
    version: baseline.analyzer.version,
    stack: baseline.analyzer.stack,
    supported_detectors: [
      "component-root",
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
  compatibility_replay: {
    current_core_architecture_model: currentArchitecture.value.version,
    previous_core_architecture_model: previousArchitecture.value.version,
    normalized_guardian_result_sha256: sha256(JSON.stringify(currentReplay)),
    exact_current_previous_match: true,
    unsupported_version: "9.0.0",
    unsupported_message: unsupportedArchitecture.issues[0].message,
  },
  detector_fixture: {
    architecture: "test/fixtures/detectors/architecture.yaml",
    repository: "test/fixtures/detectors/repository",
    deterministic: true,
    classification: detectorResult.classification,
    detector_examples: detectorExamples,
    source_evidence: detectorEvidence,
    normalized_observed_sha256: sha256(JSON.stringify(detectorObserved)),
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
    coverage_count_policy: "Raw V8 item counts are verified covered=total at runtime but omitted because they vary across supported Node majors",
    cli_smoke_checks: 23,
    clean_package_install: "required on Windows, macOS and Linux",
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
