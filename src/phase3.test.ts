import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendGitHubStepSummary,
  checkRepositoryDiff,
  formatGitHubAnnotations,
  formatPhase3Markdown,
  formatPhase3Result,
  mergeIncrementalObservedArchitecture,
} from "./phase3.js";
import { baselineSources, testArchitecture, writeSources } from "./test-helpers.js";

const execFileAsync = promisify(execFile);
let repository: string;

async function git(...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", repository, ...args], { windowsHide: true });
}

async function commitBaseline(sources = baselineSources): Promise<void> {
  await writeSources(repository, sources);
  await git("init", "-b", "main");
  await git("config", "user.email", "phase3-test@archsync.invalid");
  await git("config", "user.name", "ArchSync Phase 3 Test");
  await git("add", ".");
  await git("commit", "-m", "baseline");
}

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "archsync-phase3-test-"));
});

afterEach(async () => {
  await rm(repository, { recursive: true, force: true });
});

describe("Phase 3 Git diff architecture gate", () => {
  it("passes an internal source change and reuses the baseline cache", async () => {
    await commitBaseline();
    await writeFile(
      join(repository, "service", "src", "internal.ts"),
      "export const normalize = (value: string): string => value.trim();\n",
      "utf8",
    );

    const cold = await checkRepositoryDiff(testArchitecture(), repository);
    const warm = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(cold.decision).toBe("PASS");
    expect(cold.classification).toBe("no-impact");
    expect(cold.affected_components).toEqual(["service"]);
    expect(cold.introduced_findings).toEqual([]);
    expect(cold.architecture_delta).toEqual({
      added_nodes: [],
      removed_nodes: [],
      changed_nodes: [],
      added_edges: [],
      removed_edges: [],
    });
    expect(cold.cache.hit).toBe(false);
    expect(warm.cache.hit).toBe(true);
    expect(warm.analysis.analyzed_components).toBe(1);
    expect(warm.analysis.incremental_scanned_files).toBe(2);
    expect(warm.analysis.head_scanned_files).toBe(4);
    expect(formatPhase3Result(warm)).toContain("Baseline cache: HIT");
    expect(formatPhase3Markdown(cold)).toContain("No new architecture finding was introduced");
    expect(formatPhase3Markdown(cold)).toContain("Baseline cache: **miss**");
    expect(formatPhase3Markdown(warm)).toContain("Baseline cache: **hit**");
    expect(formatPhase3Markdown(warm)).toContain("**Decision: PASS**");
  });

  it("passes a documentation-only diff without parsing a source component", async () => {
    await commitBaseline();
    await writeFile(join(repository, "README.md"), "Documentation only.\n", "utf8");

    const result = await checkRepositoryDiff(testArchitecture(), repository, {
      base_ref: ".",
      use_cache: false,
    });

    expect(result.decision).toBe("PASS");
    expect(result.affected_components).toEqual([]);
    expect(result.analysis.analyzed_components).toBe(0);
    expect(result.analysis.incremental_scanned_files).toBe(0);
    expect(result.cache.hit).toBe(false);
  });

  it("rebuilds a corrupt custom baseline cache safely", async () => {
    await commitBaseline();
    await writeFile(
      join(repository, "service", "src", "internal.ts"),
      "export const normalize = (value: string): string => value.trim();\n",
      "utf8",
    );
    const options = { base_ref: ".", cache_dir: ".archsync-test-cache" } as const;
    const cold = await checkRepositoryDiff(testArchitecture(), repository, options);
    const cacheFile = join(repository, ".archsync-test-cache", `${cold.cache.key}.json`);
    await writeFile(cacheFile, "not-json", "utf8");

    const rebuilt = await checkRepositoryDiff(testArchitecture(), repository, options);

    expect(rebuilt.cache.hit).toBe(false);
    expect(JSON.parse(await readFile(cacheFile, "utf8")).key).toBe(rebuilt.cache.key);
  });

  it("blocks a rule violation introduced on a changed line", async () => {
    await commitBaseline();
    await writeFile(
      join(repository, "frontend", "src", "database.ts"),
      `import { Client } from "pg";
const database = new Client({ connectionString: "postgres://postgres:5432/app" });
export async function bypass(): Promise<void> {
  await database.query("select 1");
}
`,
      "utf8",
    );

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(result.decision).toBe("BLOCK");
    expect(result.classification).toBe("violation");
    expect(result.architecture_delta.added_edges).toEqual(["frontend|data|postgres"]);
    expect(result.introduced_findings).toEqual([
      expect.objectContaining({
        rule_id: "ARCH-001",
        source_evidence: [expect.objectContaining({ file: "frontend/src/database.ts", line: 4 })],
      }),
      expect.objectContaining({ kind: "architecture-evolution" }),
    ]);
    expect(result.changed_files[0]).toMatchObject({
      path: "frontend/src/database.ts",
      status: "added",
      changed_lines: [{ start: 1, end: 5 }],
    });
    expect(formatGitHubAnnotations(result)).toContain(
      "::error file=frontend/src/database.ts,line=4,col=9,title=ArchSync ARCH-001::",
    );
    expect(formatPhase3Result(result)).toContain("Fix the new rule violations before merging");
    expect(formatPhase3Markdown(result)).toContain("frontend\\|data\\|postgres");
  });

  it("requests review for a non-forbidden topology evolution", async () => {
    await commitBaseline();
    await writeFile(
      join(repository, "service", "src", "cache.ts"),
      `import { createClient } from "redis";
const redis = createClient({ url: "redis://redis:6379" });
export async function cache(): Promise<void> {
  await redis.set("a", "b");
}
`,
      "utf8",
    );

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(result.decision).toBe("REVIEW");
    expect(result.classification).toBe("evolution");
    expect(result.architecture_delta.added_nodes).toEqual(["redis"]);
    expect(result.architecture_delta.added_edges).toEqual(["service|data|redis"]);
    expect(result.introduced_findings).toHaveLength(2);
    expect(formatGitHubAnnotations(result)).toContain("::warning");
    expect(formatPhase3Markdown(result)).toContain("**Decision: REVIEW**");
    expect(formatPhase3Result(result)).toContain("Request architecture approval");
    expect(formatPhase3Result(result)).toContain("EXIT CODE: 3 (REVIEW)");
  });

  it("writes a GitHub step summary and supports model-only evidence", async () => {
    await commitBaseline();
    await writeFile(
      join(repository, "service", "src", "cache.ts"),
      `import { createClient } from "redis";
const redis = createClient({ url: "redis://redis:6379" });
export async function cache(): Promise<void> { await redis.set("a", "b"); }
`,
      "utf8",
    );
    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });
    const summary = join(repository, "summary.md");

    expect(await appendGitHubStepSummary(result, summary)).toBe(true);
    expect(await appendGitHubStepSummary(result, "")).toBe(false);
    expect(await readFile(summary, "utf8")).toContain("ArchSync architecture gate");

    const modelOnly = structuredClone(result);
    modelOnly.introduced_findings[0]!.source_evidence = [];
    expect(formatGitHubAnnotations(modelOnly)).toContain("title=ArchSync EVOLUTION-001");
    expect(formatPhase3Markdown(modelOnly)).toContain("observed:/components/redis");
  });

  it("tracks a same-component TypeScript rename", async () => {
    await commitBaseline();
    await git("mv", "service/src/service.ts", "service/src/store.ts");

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(result.decision).toBe("PASS");
    expect(result.affected_components).toEqual(["service"]);
    expect(result.changed_files).toEqual([
      expect.objectContaining({
        path: "service/src/store.ts",
        previous_path: "service/src/service.ts",
        status: "renamed",
      }),
    ]);
  });

  it("compares a committed feature branch with its merge base", async () => {
    await commitBaseline();
    await git("checkout", "-b", "feature/frontend-bypass");
    await writeFile(
      join(repository, "frontend", "src", "direct.ts"),
      `import { Client } from "pg";
const database = new Client({ connectionString: "postgres://postgres:5432/app" });
export async function bypass(): Promise<void> {
  await database.query("select 1");
}
`,
      "utf8",
    );
    await git("add", ".");
    await git("commit", "-m", "add forbidden frontend database call");

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "main" });

    expect(result.repository.worktree_dirty).toBe(false);
    expect(result.repository.base_ref).toBe("main");
    expect(result.changed_files).toEqual([
      expect.objectContaining({ path: "frontend/src/direct.ts", status: "added", additions: 5 }),
    ]);
    expect(result.decision).toBe("BLOCK");
    expect(result.introduced_findings.some(({ rule_id }) => rule_id === "ARCH-001")).toBe(true);
  });

  it("does not block an unrelated diff for a pre-existing baseline violation", async () => {
    await commitBaseline({
      ...baselineSources,
      "frontend/src/database.ts": `import { Client } from "pg";
const database = new Client({ connectionString: "postgres://postgres:5432/app" });
export async function bypass(): Promise<void> { await database.query("select 1"); }
`,
    });
    await writeFile(
      join(repository, "service", "src", "internal.ts"),
      "export const normalize = (value: string): string => value.trim();\n",
      "utf8",
    );

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(result.baseline.decision).toBe("BLOCK");
    expect(result.head.decision).toBe("BLOCK");
    expect(result.decision).toBe("PASS");
    expect(result.pre_existing_findings).toBeGreaterThan(0);
    expect(result.introduced_findings).toEqual([]);
  });

  it("reports a resolved baseline violation without blocking the fix", async () => {
    await commitBaseline({
      ...baselineSources,
      "frontend/src/database.ts": `import { Client } from "pg";
const database = new Client({ connectionString: "postgres://postgres:5432/app" });
export async function bypass(): Promise<void> { await database.query("select 1"); }
`,
    });
    await unlink(join(repository, "frontend", "src", "database.ts"));

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(result.decision).toBe("PASS");
    expect(result.introduced_findings).toEqual([]);
    expect(result.resolved_findings.some(({ rule_id }) => rule_id === "ARCH-001")).toBe(true);
    expect(result.architecture_delta.removed_edges).toEqual(["frontend|data|postgres"]);
    expect(formatPhase3Result(result)).toContain("RESOLVED FINDINGS");
  });

  it("tracks modified and empty untracked TypeScript files in a newly inferred component", async () => {
    await commitBaseline();
    await writeFile(
      join(repository, "service", "src", "service.ts"),
      `${baselineSources["service/src/service.ts"]}\nexport const changed = true;\n`,
      "utf8",
    );
    await mkdir(join(repository, "new-tool", "src"), { recursive: true });
    await writeFile(join(repository, "new-tool", "src", "main.ts"), "export const tool = true;\n", "utf8");
    await writeFile(join(repository, "new-tool", "src", "empty.ts"), "", "utf8");

    const result = await checkRepositoryDiff(testArchitecture(), repository, { base_ref: "." });

    expect(result.affected_components).toEqual(["new-tool", "service"]);
    expect(result.changed_files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "service/src/service.ts", status: "modified" }),
      expect.objectContaining({ path: "new-tool/src/main.ts", status: "added", additions: 1 }),
      expect.objectContaining({ path: "new-tool/src/empty.ts", status: "added", additions: 0, changed_lines: [] }),
    ]));
    expect(result.architecture_delta.added_nodes).toContain("new-tool");
  });

  it("merges retained and incremental evidence for the same relationship deterministically", () => {
    const rootEvidence = {
      kind: "source-location" as const,
      line: 1,
      column: 1,
      snippet: "source",
      detector: "component-root" as const,
      confidence: 1,
    };
    const baseline = {
      version: "0.1" as const,
      analyzer: { id: "archsync-typescript" as const, version: "0.2" as const, stack: "typescript-node" as const },
      metadata: { name: "baseline", scanned_files: 1 },
      components: {
        postgres: {
          component: { type: "database" as const, layer: "data" as const },
          evidence: [{ ...rootEvidence, file: "gateway/src/shared.ts" }],
        },
      },
      relationships: [{
        from: "service",
        to: "postgres",
        type: "data" as const,
        evidence: [{ ...rootEvidence, file: "gateway/src/shared.ts", detector: "typescript-pg" as const }],
      }],
    };
    const partial = {
      ...baseline,
      metadata: { name: "partial", scanned_files: 1 },
      components: {
        postgres: {
          component: { type: "database" as const, layer: "data" as const },
          evidence: [{ ...rootEvidence, file: "service/src/service.ts" }],
        },
      },
      relationships: [{
        from: "service",
        to: "postgres",
        type: "data" as const,
        evidence: [{ ...rootEvidence, file: "service/src/service.ts", detector: "typescript-pg" as const }],
      }],
    };

    const merged = mergeIncrementalObservedArchitecture(baseline, partial, ["service"]);

    expect(merged.components.postgres?.evidence).toHaveLength(2);
    expect(merged.relationships[0]?.evidence).toHaveLength(2);
  });
});
