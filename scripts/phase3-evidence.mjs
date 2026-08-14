import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { loadArchitecture } from "@archsync/core";
import { checkRepositoryDiff } from "../dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = (...parts) => join(root, "test", "fixtures", ...parts);
const evidencePath = join(root, "evidence", "phase-3-evidence.json");
const writeMode = process.argv.includes("--write");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-14T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-14T00:00:00Z",
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

async function createRepository(name) {
  const repository = await mkdtemp(join(tmpdir(), `archsync-phase3-${name}-`));
  await cp(fixture("baseline"), repository, { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "phase3-evidence@archsync.invalid"]);
  git(repository, ["config", "user.name", "ArchSync Phase 3 Evidence"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "controlled baseline"]);
  return repository;
}

function stableResult(result) {
  return {
    classification: result.classification,
    decision: result.decision,
    changed_files: result.changed_files.map(({ path, status, additions, deletions, changed_lines }) => ({
      path,
      status,
      additions,
      deletions,
      changed_lines,
    })),
    affected_components: result.affected_components,
    architecture_delta: result.architecture_delta,
    introduced_findings: result.introduced_findings.map((finding) => ({
      id: finding.id,
      kind: finding.kind,
      ...(finding.rule_id ? { rule_id: finding.rule_id } : {}),
      ...(finding.edge ? { edge: finding.edge.key } : {}),
      ...(finding.component ? { component: finding.component } : {}),
      ...(finding.change ? { change: finding.change } : {}),
      source_evidence: finding.source_evidence.map(({ file, line, column, detector }) => ({
        file,
        line,
        column,
        detector,
      })),
    })),
    resolved_findings: result.resolved_findings.map(({ id, rule_id, kind }) => ({
      id,
      kind,
      ...(rule_id ? { rule_id } : {}),
    })),
    pre_existing_findings: result.pre_existing_findings,
    analyzed_components: result.analysis.analyzed_components,
    baseline_scanned_files: result.analysis.baseline_scanned_files,
    incremental_scanned_files: result.analysis.incremental_scanned_files,
    head_scanned_files: result.analysis.head_scanned_files,
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function runCase(expected, definition, collectPerformance) {
  const repository = await createRepository(definition.id);
  try {
    await definition.change(repository);
    const cold = await checkRepositoryDiff(expected, repository, { base_ref: "." });
    const warmRuns = [];
    for (let index = 0; index < (collectPerformance ? 5 : 1); index += 1) {
      warmRuns.push(await checkRepositoryDiff(expected, repository, { base_ref: "." }));
    }
    const stable = stableResult(cold);
    for (const warm of warmRuns) {
      assert.deepEqual(stableResult(warm), stable, `${definition.id} output changed after cache warm-up`);
      assert.equal(warm.cache.hit, true, `${definition.id} must reuse the baseline cache`);
    }
    assert.equal(cold.decision, definition.decision);
    return {
      stable,
      performance: {
        cold_total_ms: cold.analysis.total_ms,
        warm_total_ms: warmRuns.map((result) => result.analysis.total_ms),
        warm_median_total_ms: median(warmRuns.map((result) => result.analysis.total_ms)),
        warm_median_baseline_load_ms: median(warmRuns.map((result) => result.analysis.baseline_load_ms)),
        warm_median_incremental_scan_ms: median(warmRuns.map((result) => result.analysis.incremental_scan_ms)),
      },
    };
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

const architectureResult = await loadArchitecture(fixture("architecture.yaml"));
assert.equal(architectureResult.valid, true);
assert.ok(architectureResult.value);
const expected = architectureResult.value;

const cases = [
  {
    id: "no-impact",
    decision: "PASS",
    async change(repository) {
      await mkdir(join(repository, "service", "src"), { recursive: true });
      await writeFile(
        join(repository, "service", "src", "internal.ts"),
        "export const normalize = (value) => value.trim();\n",
        "utf8",
      );
    },
  },
  {
    id: "violation",
    decision: "BLOCK",
    async change(repository) {
      await writeFile(
        join(repository, "frontend", "src", "database.ts"),
        await readFile(fixture("violation", "frontend", "src", "database.ts"), "utf8"),
        "utf8",
      );
    },
  },
  {
    id: "evolution",
    decision: "REVIEW",
    async change(repository) {
      await writeFile(
        join(repository, "service", "src", "cache.ts"),
        `import { createClient } from "redis";
const redis = createClient({ url: "redis://redis:6379" });
export async function cache() { await redis.set("a", "b"); }
`,
        "utf8",
      );
    },
  },
];

const measured = {};
for (const definition of cases) {
  measured[definition.id] = await runCase(expected, definition, writeMode);
}

const sourceFiles = ["analyzer.ts", "bin.ts", "contracts.ts", "guardian.ts", "phase3.ts"];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [
  `src/${file}`,
  sha256(await readFile(join(root, "src", file)), "utf8"),
])));
const staticEvidence = {
  phase: 3,
  release: "v0.3",
  objective: "Git-diff architecture impact analysis, pull-request findings and deterministic merge decisions",
  contract_version: "0.1",
  source_sha256: sourceHashes,
  strategy: {
    baseline: "Observed Graph cached by base commit, architecture contract and analyzer version",
    head: "Only source components touched by the Git diff are rescanned and merged into the cached baseline",
    decision: "New violations BLOCK, new non-forbidden topology REVIEW, no new drift PASS",
    pre_existing_findings: "Reported but do not block an unrelated diff",
  },
  controlled_cases: Object.fromEntries(Object.entries(measured).map(([id, value]) => [id, value.stable])),
  gates: {
    pull_request_decisions: ["PASS", "BLOCK", "REVIEW"],
    exact_file_line_annotations: true,
    machine_readable_json: true,
    markdown_report: true,
    baseline_cache_required: true,
    component_incremental_scan_required: true,
    cli_smoke_checks: 10,
  },
  exclusions: [
    "Automatic architecture baseline updates",
    "Automatic repair or merge",
    "IaC and runtime evidence",
    "LLM authority over deterministic rules",
  ],
};

if (writeMode) {
  const evidence = {
    ...staticEvidence,
    environment: {
      platform: platform(),
      os_release: release(),
      node: process.version,
      cpu: cpus()[0]?.model ?? "unknown",
      logical_cpus: cpus().length,
    },
    performance: Object.fromEntries(Object.entries(measured).map(([id, value]) => [id, value.performance])),
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`WROTE ${evidencePath}`);
} else {
  const committed = JSON.parse(await readFile(evidencePath, "utf8"));
  const { environment: _environment, performance, ...committedStatic } = committed;
  assert.deepEqual(committedStatic, staticEvidence, "Phase 3 evidence is stale; run 'pnpm phase3:evidence:update'");
  for (const definition of cases) {
    const item = performance?.[definition.id];
    assert.ok(item?.cold_total_ms > 0, `${definition.id} cold performance measurement is missing`);
    assert.equal(item.warm_total_ms.length, 5, `${definition.id} requires five warm measurements`);
    assert.ok(item.warm_total_ms.every((value) => value > 0));
  }
  console.log(`VALID PHASE 3 EVIDENCE ${evidencePath}`);
}
