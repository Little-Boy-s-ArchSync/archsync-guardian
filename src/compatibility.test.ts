import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ARCHITECTURE_CONTRACT_CURRENT_VERSION,
  ARCHITECTURE_CONTRACT_LEGACY_VERSION,
  ARCHITECTURE_CONTRACT_PREVIOUS_VERSION,
  loadArchitecture,
  SUPPORTED_ARCHITECTURE_CONTRACT_VERSIONS,
  type ArchitectureDocument,
} from "@archsync/core";
import { describe, expect, it } from "vitest";

import { analyzeTypeScriptRepository } from "./analyzer.js";
import {
  coreDependencyProvenance,
  coreGuardianContractMatrix,
  guardianContractsForCoreArchitecture,
} from "./compatibility.js";
import { checkRepository, evaluateObservedArchitecture } from "./guardian.js";

const fixtures = join(process.cwd(), "test", "fixtures");

describe("Core and Guardian contract compatibility", () => {
  it("publishes the exact Core dependency and owned contract mapping", () => {
    expect(coreDependencyProvenance).toEqual({
      package: "@archsync/core",
      package_version: "0.1.1",
      repository: "https://github.com/Little-Boy-s-ArchSync/archsync-core",
      source_commit: "503b5fe97aa39a78d5e5de80b794a94508e106cc",
      source_pull_request: "https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/3",
      included_source_commits: {
        contract_compatibility: "a1f0143aa8eb917aa0d93e28101b1893347453e2",
        quality_goals: "783716d7961690b1e8c1cda4acb956777977a853",
      },
      vendored_artifact: "vendor/archsync-core-0.1.1-integration-503b5fe.tgz",
      vendored_sha256: "7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9",
      provenance_artifact: "vendor/archsync-core-0.1.1-integration-503b5fe.provenance.json",
      dependency_status: "upstream-integration-pr-merged",
    });
    expect(coreGuardianContractMatrix).toEqual({
      schema_version: 1,
      core: {
        architecture_model: {
          current: "0.1.1",
          previous: "0.1.0",
          legacy: "0.1",
          accepted: ["0.1.1", "0.1.0", "0.1"],
        },
        graph: "1.0.0",
        finding: "1.0.0",
        evidence: "1.0.0",
        conformance: "1.0.0",
        cli_json: "1.0.0",
      },
      guardian: {
        analyzer: "0.2",
        observed_graph: "0.1",
        finding: "0.1",
        source_evidence: "0.1",
        source_evidence_version_carrier: "observed-or-finding-envelope",
        result: "0.1",
      },
      ownership: {
        architecture_model_graph_and_decisions: "core",
        source_detection_observed_graph_and_enrichment: "guardian",
      },
    });
  });

  it.each([
    ARCHITECTURE_CONTRACT_CURRENT_VERSION,
    ARCHITECTURE_CONTRACT_PREVIOUS_VERSION,
    ARCHITECTURE_CONTRACT_LEGACY_VERSION,
  ])("maps supported Core architecture contract %s without changing Guardian ownership", (version) => {
    expect(guardianContractsForCoreArchitecture(version)).toEqual({
      core_architecture_model: version,
      core_graph: "1.0.0",
      core_finding: "1.0.0",
      core_evidence: "1.0.0",
      core_conformance: "1.0.0",
      core_cli_json: "1.0.0",
      guardian_analyzer: "0.2",
      guardian_observed_graph: "0.1",
      guardian_finding: "0.1",
      guardian_source_evidence: "0.1",
      guardian_result: "0.1",
    });
  });

  it("replays current and previous Core models through the same Guardian result", async () => {
    const [current, previous] = await Promise.all([
      loadArchitecture(join(fixtures, "compatibility", "current.architecture.yaml")),
      loadArchitecture(join(fixtures, "compatibility", "previous.architecture.yaml")),
    ]);
    expect(current.valid).toBe(true);
    expect(previous.valid).toBe(true);
    expect(current.value?.version).toBe(ARCHITECTURE_CONTRACT_CURRENT_VERSION);
    expect(previous.value?.version).toBe(ARCHITECTURE_CONTRACT_PREVIOUS_VERSION);

    const currentResult = await checkRepository(current.value!, join(fixtures, "violation"));
    const previousResult = await checkRepository(previous.value!, join(fixtures, "violation"));

    expect(previousResult).toEqual(currentResult);
    expect(currentResult).toMatchObject({
      contract_version: "0.1",
      classification: "violation",
      decision: "BLOCK",
      observed: {
        version: "0.1",
        analyzer: { version: "0.2" },
      },
    });
    expect(currentResult.findings).not.toHaveLength(0);
    expect(currentResult.findings.every(({ contract_version }) => contract_version === "0.1")).toBe(true);
    expect(currentResult.findings.every(({ model_evidence }) =>
      model_evidence.schema_version === "1.0.0"
    )).toBe(true);
    expect(currentResult.findings.some(({ source_evidence }) =>
      source_evidence.some(({ detector }) => detector === "typescript-pg")
    )).toBe(true);
  });

  it("rejects unsupported versions in both Core loading and the Guardian API", async () => {
    const unsupported = await loadArchitecture(
      join(fixtures, "compatibility", "unsupported.architecture.yaml"),
    );
    expect(unsupported.valid).toBe(false);
    expect(unsupported.issues).toEqual([
      {
        path: "/version",
        message: `Unsupported architecture contract version '9.0.0'. Supported versions: ${
          SUPPORTED_ARCHITECTURE_CONTRACT_VERSIONS.join(", ")
        }.`,
        keyword: "version",
      },
    ]);

    expect(() => guardianContractsForCoreArchitecture("9.0.0")).toThrow(
      "Unsupported architecture contract version '9.0.0'. Supported versions: 0.1.1, 0.1.0, 0.1.",
    );
    expect(() => guardianContractsForCoreArchitecture(9)).toThrow(
      "Unsupported architecture contract version '9'. Supported versions: 0.1.1, 0.1.0, 0.1.",
    );

    const current = await loadArchitecture(
      join(fixtures, "compatibility", "current.architecture.yaml"),
    );
    const observed = await analyzeTypeScriptRepository(join(fixtures, "violation"), current.value!);
    const invalid = { ...current.value!, version: "9.0.0" } as unknown as ArchitectureDocument;
    expect(() => evaluateObservedArchitecture(invalid, observed)).toThrow(
      "Unsupported architecture contract version '9.0.0'",
    );
  });

  it("binds every detector to a checked source fixture and exact evidence location", async () => {
    const loaded = await loadArchitecture(join(fixtures, "detectors", "architecture.yaml"));
    expect(loaded.valid).toBe(true);
    const repository = join(fixtures, "detectors", "repository");
    const observed = await analyzeTypeScriptRepository(repository, loaded.value!);
    const result = await checkRepository(loaded.value!, repository);

    expect(result.classification).toBe("no-impact");
    expect(Object.keys(observed.components)).toEqual([
      "amqp",
      "frontend",
      "postgres",
      "redis",
      "service",
      "utility",
      "worker",
    ]);
    expect(observed.relationships.map(({ from, type, to, evidence }) => ({
      edge: `${from}|${type}|${to}`,
      evidence: evidence.map(({ file, line, detector }) => ({ file, line, detector })),
    }))).toEqual([
      {
        edge: "amqp|async|worker",
        evidence: [{ file: "worker/src/consumer.ts", line: 7, detector: "typescript-amqp-consume" }],
      },
      {
        edge: "frontend|http|service",
        evidence: [{ file: "frontend/src/app.ts", line: 4, detector: "typescript-fetch" }],
      },
      {
        edge: "service|async|amqp",
        evidence: [{ file: "service/src/publisher.ts", line: 7, detector: "typescript-amqp-publish" }],
      },
      {
        edge: "service|data|postgres",
        evidence: [{ file: "service/src/postgres.ts", line: 6, detector: "typescript-pg" }],
      },
      {
        edge: "service|data|redis",
        evidence: [{ file: "service/src/redis.ts", line: 6, detector: "typescript-redis" }],
      },
    ]);
    const detectors = new Set([
      ...Object.values(observed.components).flatMap(({ evidence }) => evidence.map(({ detector }) => detector)),
      ...observed.relationships.flatMap(({ evidence }) => evidence.map(({ detector }) => detector)),
    ]);
    expect([...detectors].sort()).toEqual([
      "component-root",
      "typescript-amqp-consume",
      "typescript-amqp-publish",
      "typescript-fetch",
      "typescript-pg",
      "typescript-redis",
    ]);
  });

  it("keeps contract, detector, limitation, configuration and migration docs directly linked", async () => {
    const [contracts, support, migration] = await Promise.all([
      readFile(join(process.cwd(), "docs", "contract-compatibility.md"), "utf8"),
      readFile(join(process.cwd(), "docs", "support-matrix.md"), "utf8"),
      readFile(join(process.cwd(), "docs", "migrations", "core-0.1.0-to-0.1.1.md"), "utf8"),
    ]);
    expect(contracts).toContain(coreDependencyProvenance.source_commit);
    expect(contracts).toContain(coreDependencyProvenance.vendored_sha256);
    expect(contracts).toContain("Core continues to own");
    for (const link of [
      "../test/fixtures/detectors/repository/utility/src/index.ts",
      "../test/fixtures/detectors/repository/frontend/src/app.ts",
      "../test/fixtures/detectors/repository/service/src/postgres.ts",
      "../test/fixtures/detectors/repository/service/src/redis.ts",
      "../test/fixtures/detectors/repository/service/src/publisher.ts",
      "../test/fixtures/detectors/repository/worker/src/consumer.ts",
    ]) {
      expect(support).toContain(link);
    }
    for (const detector of [
      "component-root",
      "typescript-fetch",
      "typescript-pg",
      "typescript-redis",
      "typescript-amqp-publish",
      "typescript-amqp-consume",
    ]) {
      expect(support).toContain(`\`${detector}\``);
    }
    expect(support).toContain("../evidence/phase-2-evidence.json");
    expect(support).toContain("## Explicit limitations");
    expect(support).toContain("## CLI exits");
    expect(support).toContain("## Configuration and precedence");
    expect(migration).toContain('-version: "0.1.0"');
    expect(migration).toContain('+version: "0.1.1"');
    expect(migration).toContain("pnpm core:compatibility:verify");
  });
});
