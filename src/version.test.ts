import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  computePackageContentSha256,
  createPackageProvenance,
  formatVersionResult,
  loadVersionResult,
} from "./version.js";

async function packageFixture(name = "@archsync/guardian") {
  const root = await mkdtemp(join(tmpdir(), "archsync-version-"));
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "README.md"), "# fixture\n", "utf8");
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "0.3.1" }), "utf8");
  await writeFile(join(root, "dist", "bin.js"), "console.log('fixture');\n", "utf8");
  await mkdir(join(root, "dist", "nested"));
  await writeFile(join(root, "dist", "nested", "index.js"), "export {};\n", "utf8");
  return root;
}

describe("CLI version provenance", () => {
  it("loads the real checkout with Git-backed source provenance", async () => {
    const result = await loadVersionResult();
    expect(result.provenance.mode).toBe("source-tree");
    expect(result.provenance.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(result.contracts).toMatchObject({
      core_model: "0.1.1",
      core_model_previous: "0.1.0",
      core_model_legacy: "0.1",
      core_model_accepted: ["0.1.1", "0.1.0", "0.1"],
      core_graph: "1.0.0",
      core_finding: "1.0.0",
      core_evidence: "1.0.0",
      core_conformance: "1.0.0",
      core_cli_json: "1.0.0",
      guardian_analyzer: "0.2",
      guardian_observed_graph: "0.1",
      guardian_finding: "0.1",
      guardian_source_evidence: "0.1",
      finding: "0.1",
      source_evidence: "0.1",
      guardian_result: "0.1",
    });
    expect(result.dependencies.core).toEqual({
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
      dependency_status: "upstream-integration-pr-open-unmerged",
    });
  });

  it("computes a deterministic content digest and reports an unpackaged source tree", async () => {
    const root = await packageFixture();
    const first = await computePackageContentSha256(root);
    const second = await computePackageContentSha256(root);
    const result = await loadVersionResult(root);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(result.cli).toEqual({ name: "ArchSync CLI", package: "@archsync/guardian", version: "0.3.1" });
    expect(result.provenance).toEqual({
      mode: "source-tree",
      source_commit: null,
      package_content_sha256: first,
      integrity: "source-tree",
    });
    expect(formatVersionResult(result)).toContain("source unavailable; source-tree");
  });

  it("creates, loads and formats verified package provenance", async () => {
    const root = await packageFixture();
    const provenance = await createPackageProvenance(root, "A".repeat(40));
    await writeFile(join(root, "dist", "provenance.json"), JSON.stringify(provenance), "utf8");
    const result = await loadVersionResult(root);

    expect(provenance.source_commit).toBe("a".repeat(40));
    expect(result.provenance.mode).toBe("package");
    expect(result.provenance.integrity).toBe("verified");
    expect(formatVersionResult(result)).toContain("source aaaaaaaaaaaa; verified");
  });

  it("rejects the wrong package and missing source commit during packaging", async () => {
    await expect(createPackageProvenance(await packageFixture("wrong"), "a".repeat(40)))
      .rejects.toThrow("expected package");
    await expect(createPackageProvenance(await packageFixture(), null))
      .rejects.toThrow("40-character Git source commit");
  });

  it("rejects malformed, mismatched and tampered packaged provenance", async () => {
    const malformed = await packageFixture();
    await writeFile(join(malformed, "dist", "provenance.json"), "{}", "utf8");
    await expect(loadVersionResult(malformed)).rejects.toThrow("packaged provenance is invalid");

    const mismatched = await packageFixture();
    const mismatchProvenance = await createPackageProvenance(mismatched, "b".repeat(40));
    await writeFile(join(mismatched, "dist", "provenance.json"), JSON.stringify({
      ...mismatchProvenance,
      package_version: "9.9.9",
    }), "utf8");
    await expect(loadVersionResult(mismatched)).rejects.toThrow("does not match package.json");

    const tampered = await packageFixture();
    const tamperedProvenance = await createPackageProvenance(tampered, "c".repeat(40));
    await writeFile(join(tampered, "dist", "provenance.json"), JSON.stringify(tamperedProvenance), "utf8");
    await writeFile(join(tampered, "README.md"), "tampered\n", "utf8");
    await expect(loadVersionResult(tampered)).rejects.toThrow("failed its SHA-256 integrity check");
  });

  it("rejects a package manifest without string name and version", async () => {
    const root = await packageFixture();
    await writeFile(join(root, "package.json"), JSON.stringify({ name: 1 }), "utf8");
    await expect(loadVersionResult(root)).rejects.toThrow("valid name and version");
  });
});
