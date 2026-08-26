import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { coreDependencyProvenance, coreGuardianContractMatrix } from "./compatibility.js";

const packageName = "@archsync/guardian";
const provenanceFile = "provenance.json";

interface PackageManifest {
  name: string;
  version: string;
  bundledDependencies: string[];
}

export interface PackageProvenance {
  schema_version: 1;
  package_name: string;
  package_version: string;
  source_commit: string;
  package_content_sha256: string;
}

export interface VersionResult {
  cli: {
    name: "ArchSync CLI";
    package: string;
    version: string;
  };
  contracts: {
    core_model: "0.1.1";
    core_model_previous: "0.1.0";
    core_model_legacy: "0.1";
    core_model_accepted: readonly ["0.1.1", "0.1.0", "0.1"];
    core_graph: "1.0.0";
    core_finding: "1.0.0";
    core_evidence: "1.0.0";
    core_conformance: "1.0.0";
    core_cli_json: "1.0.0";
    guardian_analyzer: "0.2";
    guardian_observed_graph: "0.1";
    git_gate: "0.3";
    guardian_finding: "0.1";
    guardian_source_evidence: "0.1";
    /** @deprecated Use guardian_finding. */
    finding: "0.1";
    /** @deprecated Use guardian_source_evidence. */
    source_evidence: "0.1";
    guardian_result: "0.1";
  };
  dependencies: {
    core: {
      package: "@archsync/core";
      package_version: "0.1.1";
      repository: string;
      source_commit: string;
      vendored_artifact: string;
      vendored_sha256: string;
    };
  };
  provenance: {
    mode: "package" | "source-tree";
    source_commit: string | null;
    package_content_sha256: string;
    integrity: "verified" | "source-tree";
  };
}

export const defaultPackageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

async function walkFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  }));
  return files.flat();
}

async function readManifest(root: string): Promise<PackageManifest> {
  const value: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (
    typeof value !== "object" || value === null ||
    !("name" in value) || typeof value.name !== "string" ||
    !("version" in value) || typeof value.version !== "string"
  ) {
    throw new Error("package.json does not contain a valid name and version");
  }
  const bundledDependencies = "bundledDependencies" in value && Array.isArray(value.bundledDependencies)
    ? value.bundledDependencies.filter((dependency): dependency is string => typeof dependency === "string")
    : [];
  return { name: value.name, version: value.version, bundledDependencies };
}

const coreRuntimePackages = [
  "@archsync/core",
  "ajv",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
  "yaml",
];

export async function computePackageContentSha256(root: string): Promise<string> {
  const dist = join(root, "dist");
  const manifest = await readManifest(root);
  const bundledFiles = manifest.bundledDependencies.includes("@archsync/core")
    ? (await Promise.all(coreRuntimePackages.map((dependency) =>
        walkFiles(join(root, "node_modules", ...dependency.split("/"))),
      ))).flat()
    : [];
  const files = [
    join(root, "README.md"),
    ...(await walkFiles(dist)),
    ...bundledFiles,
  ].filter((file) => {
    const name = relative(root, file).replaceAll("\\", "/");
    return file !== join(dist, provenanceFile) &&
      basename(file) !== "package.json" &&
      !name.split("/").includes(".bin") &&
      name !== "node_modules/yaml/bin.mjs";
  });
  const digest = createHash("sha256");
  for (const file of files.sort()) {
    const name = relative(root, file).replaceAll("\\", "/");
    const bytes = await readFile(file);
    digest.update(`${name}\0${bytes.byteLength}\0`);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

function gitCommit(root: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : null;
}

export async function createPackageProvenance(
  root = defaultPackageRoot,
  sourceCommit = gitCommit(root),
): Promise<PackageProvenance> {
  const manifest = await readManifest(root);
  if (manifest.name !== packageName) {
    throw new Error(`expected package '${packageName}', received '${manifest.name}'`);
  }
  if (!sourceCommit || !/^[0-9a-f]{40}$/i.test(sourceCommit)) {
    throw new Error("a 40-character Git source commit is required to package ArchSync");
  }
  return {
    schema_version: 1,
    package_name: manifest.name,
    package_version: manifest.version,
    source_commit: sourceCommit.toLowerCase(),
    package_content_sha256: await computePackageContentSha256(root),
  };
}

function parseProvenance(value: unknown): PackageProvenance {
  if (
    typeof value !== "object" || value === null ||
    !("schema_version" in value) || value.schema_version !== 1 ||
    !("package_name" in value) || typeof value.package_name !== "string" ||
    !("package_version" in value) || typeof value.package_version !== "string" ||
    !("source_commit" in value) || typeof value.source_commit !== "string" ||
    !("package_content_sha256" in value) || typeof value.package_content_sha256 !== "string" ||
    !/^[0-9a-f]{40}$/i.test(value.source_commit) ||
    !/^[0-9a-f]{64}$/i.test(value.package_content_sha256)
  ) {
    throw new Error("packaged provenance is invalid");
  }
  return {
    schema_version: 1,
    package_name: value.package_name,
    package_version: value.package_version,
    source_commit: value.source_commit.toLowerCase(),
    package_content_sha256: value.package_content_sha256.toLowerCase(),
  };
}

async function readPackagedProvenance(root: string): Promise<PackageProvenance | undefined> {
  try {
    return parseProvenance(JSON.parse(await readFile(join(root, "dist", provenanceFile), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadVersionResult(root = defaultPackageRoot): Promise<VersionResult> {
  const manifest = await readManifest(root);
  const contentSha = await computePackageContentSha256(root);
  const packaged = await readPackagedProvenance(root);
  if (packaged) {
    if (packaged.package_name !== manifest.name || packaged.package_version !== manifest.version) {
      throw new Error("packaged provenance does not match package.json");
    }
    if (packaged.package_content_sha256 !== contentSha) {
      throw new Error(
        `packaged content failed its SHA-256 integrity check ` +
        `(expected ${packaged.package_content_sha256}, received ${contentSha})`,
      );
    }
  }
  return {
    cli: {
      name: "ArchSync CLI",
      package: manifest.name,
      version: manifest.version,
    },
    contracts: {
      core_model: coreGuardianContractMatrix.core.architecture_model.current,
      core_model_previous: coreGuardianContractMatrix.core.architecture_model.previous,
      core_model_legacy: coreGuardianContractMatrix.core.architecture_model.legacy,
      core_model_accepted: coreGuardianContractMatrix.core.architecture_model.accepted,
      core_graph: coreGuardianContractMatrix.core.graph,
      core_finding: coreGuardianContractMatrix.core.finding,
      core_evidence: coreGuardianContractMatrix.core.evidence,
      core_conformance: coreGuardianContractMatrix.core.conformance,
      core_cli_json: coreGuardianContractMatrix.core.cli_json,
      guardian_analyzer: coreGuardianContractMatrix.guardian.analyzer,
      guardian_observed_graph: coreGuardianContractMatrix.guardian.observed_graph,
      git_gate: "0.3",
      guardian_finding: coreGuardianContractMatrix.guardian.finding,
      guardian_source_evidence: coreGuardianContractMatrix.guardian.source_evidence,
      finding: coreGuardianContractMatrix.guardian.finding,
      source_evidence: coreGuardianContractMatrix.guardian.source_evidence,
      guardian_result: coreGuardianContractMatrix.guardian.result,
    },
    dependencies: {
      core: coreDependencyProvenance,
    },
    provenance: packaged
      ? {
          mode: "package",
          source_commit: packaged.source_commit,
          package_content_sha256: contentSha,
          integrity: "verified",
        }
      : {
          mode: "source-tree",
          source_commit: gitCommit(root),
          package_content_sha256: contentSha,
          integrity: "source-tree",
        },
  };
}

export function formatVersionResult(result: VersionResult): string {
  const source = result.provenance.source_commit?.slice(0, 12) ?? "unavailable";
  return `${result.cli.name} ${result.cli.version} ` +
    `(Core Model ${result.contracts.core_model}, Guardian Analyzer ${result.contracts.guardian_analyzer}, ` +
    `Git Gate ${result.contracts.git_gate}; source ${source}; ${result.provenance.integrity})`;
}
