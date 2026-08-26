import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  analyzeConformance,
  ARCHITECTURE_CONTRACT_CURRENT_VERSION,
  ARCHITECTURE_CONTRACT_PREVIOUS_VERSION,
  loadArchitecture,
  serializeConformanceResult,
} from "@archsync/core";
import {
  checkRepository,
  coreDependencyProvenance,
  coreGuardianContractMatrix,
  guardianContractsForCoreArchitecture,
  toArchitectureDocument,
} from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (...parts) => join(root, "test", "fixtures", ...parts);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const provenance = JSON.parse(await readFile(
  join(root, coreDependencyProvenance.provenance_artifact),
  "utf8",
));
assert.deepEqual(provenance, {
  schema_version: 1,
  repository: coreDependencyProvenance.repository,
  source_commit: coreDependencyProvenance.source_commit,
  source_pull_request: coreDependencyProvenance.source_pull_request,
  included_source_commits: coreDependencyProvenance.included_source_commits,
  package_name: coreDependencyProvenance.package,
  package_version: coreDependencyProvenance.package_version,
  artifact: coreDependencyProvenance.vendored_artifact,
  sha256: coreDependencyProvenance.vendored_sha256,
  build_command: "pnpm pack",
  verification_command: "pnpm phase1:verify",
  build_environment: {
    node: "26.0.0",
    pnpm: "11.16.0",
  },
  reproducibility: {
    independent_pack_runs: 2,
    byte_identical: true,
  },
  dependency_status: coreDependencyProvenance.dependency_status,
});

const artifact = await readFile(join(root, coreDependencyProvenance.vendored_artifact));
assert.equal(sha256(artifact), coreDependencyProvenance.vendored_sha256);

const guardianManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
assert.equal(
  guardianManifest.dependencies?.["@archsync/core"],
  `file:${coreDependencyProvenance.vendored_artifact}`,
);
assert.ok(guardianManifest.bundledDependencies?.includes("@archsync/core"));
const coreManifest = JSON.parse(await readFile(
  join(root, "node_modules", "@archsync", "core", "package.json"),
  "utf8",
));
assert.equal(coreManifest.name, coreDependencyProvenance.package);
assert.equal(coreManifest.version, coreDependencyProvenance.package_version);

const [current, previous] = await Promise.all([
  loadArchitecture(fixture("compatibility", "current.architecture.yaml")),
  loadArchitecture(fixture("compatibility", "previous.architecture.yaml")),
]);
assert.equal(current.valid, true);
assert.equal(previous.valid, true);
assert.ok(current.value);
assert.ok(previous.value);
assert.equal(current.value.version, ARCHITECTURE_CONTRACT_CURRENT_VERSION);
assert.equal(previous.value.version, ARCHITECTURE_CONTRACT_PREVIOUS_VERSION);
assert.equal(
  guardianContractsForCoreArchitecture(current.value.version).guardian_result,
  coreGuardianContractMatrix.guardian.result,
);
assert.equal(
  guardianContractsForCoreArchitecture(previous.value.version).guardian_result,
  coreGuardianContractMatrix.guardian.result,
);

const [currentResult, previousResult] = await Promise.all([
  checkRepository(current.value, fixture("violation")),
  checkRepository(previous.value, fixture("violation")),
]);
assert.deepEqual(
  previousResult,
  currentResult,
  "Current and previous Core models must replay to the same Guardian result",
);
assert.equal(currentResult.contract_version, coreGuardianContractMatrix.guardian.result);
assert.equal(currentResult.observed.version, coreGuardianContractMatrix.guardian.observed_graph);
assert.equal(currentResult.observed.analyzer.version, coreGuardianContractMatrix.guardian.analyzer);
assert.ok(currentResult.findings.length > 0);
assert.ok(currentResult.findings.every(({ contract_version }) =>
  contract_version === coreGuardianContractMatrix.guardian.finding
));
assert.ok(currentResult.findings.every(({ model_evidence }) =>
  model_evidence.schema_version === coreGuardianContractMatrix.core.evidence
));

const observedDocument = toArchitectureDocument(current.value, currentResult.observed);
const coreResult = analyzeConformance(current.value, observedDocument);
const serialized = serializeConformanceResult(current.value.version, observedDocument.version, coreResult);
assert.equal(coreResult.schema_version, coreGuardianContractMatrix.core.conformance);
assert.equal(coreResult.diff.schema_version, coreGuardianContractMatrix.core.graph);
assert.ok(coreResult.findings.every(({ schema_version }) =>
  schema_version === coreGuardianContractMatrix.core.finding
));
assert.ok(coreResult.findings.every(({ evidence }) =>
  evidence.schema_version === coreGuardianContractMatrix.core.evidence
));
assert.equal(serialized.schema_version, coreGuardianContractMatrix.core.cli_json);
assert.deepEqual(serialized.contracts, {
  expected_architecture_model: "0.1.1",
  observed_architecture_model: "0.1.1",
  conformance: "1.0.0",
  graph: "1.0.0",
  finding: "1.0.0",
  evidence: "1.0.0",
});
assert.equal(coreResult.classification, currentResult.classification);
assert.deepEqual(coreResult.summary, currentResult.summary);

const unsupported = await loadArchitecture(fixture("compatibility", "unsupported.architecture.yaml"));
assert.equal(unsupported.valid, false);
assert.equal(unsupported.value, undefined);
assert.equal(
  unsupported.issues[0]?.message,
  "Unsupported architecture contract version '9.0.0'. Supported versions: 0.1.1, 0.1.0, 0.1.",
);
assert.throws(
  () => guardianContractsForCoreArchitecture("9.0.0"),
  /Unsupported architecture contract version '9\.0\.0'/,
);

console.log(
  `PASS CORE/GUARDIAN COMPATIBILITY ` +
  `(Core ${current.value.version}/${previous.value.version}; ` +
  `Guardian result ${currentResult.contract_version}; Core ${coreDependencyProvenance.source_commit}; ` +
  `SHA-256 ${coreDependencyProvenance.vendored_sha256})`,
);
