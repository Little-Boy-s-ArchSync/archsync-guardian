import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { loadArchitecture } from "@archsync/core";

import { checkRepositoryDiff, formatPhase3Result, type Phase3Result } from "./phase3.js";

type DemoDecision = "PASS" | "BLOCK" | "REVIEW";

interface DemoScenario {
  id: string;
  title: string;
  category: "no-impact" | "violation" | "evolution";
  patch: string;
  changed_files: string[];
}

interface DemoManifest {
  benchmark: {
    architecture: string;
    repository: string;
  };
  cases: DemoScenario[];
}

export interface DemoOptions {
  benchmark?: string;
  scenario?: string;
  json?: boolean;
  verbose?: boolean;
  report?: string;
  interactive?: boolean;
}

export interface DemoCaseResult {
  case_id: string;
  title: string;
  expected_decision: DemoDecision;
  actual_decision: DemoDecision;
  match: boolean;
  cache: { cold: "HIT" | "MISS"; warm: "HIT" | "MISS" };
  changed_files_match: boolean;
  result: Phase3Result;
}

export interface DemoResult {
  ok: boolean;
  benchmark: string;
  cases: DemoCaseResult[];
}

function expectedDecision(category: DemoScenario["category"]): DemoDecision {
  return category === "violation" ? "BLOCK" : category === "evolution" ? "REVIEW" : "PASS";
}

function git(repository: string, args: string[]): void {
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
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveBenchmark(input?: string): Promise<string> {
  if (input) return resolve(input);
  const cwd = process.cwd();
  if (await exists(join(cwd, "ground-truth.json"))) return cwd;
  if (await exists(join(cwd, "order-platform", "ground-truth.json"))) {
    return join(cwd, "order-platform");
  }
  throw new Error(
    "Benchmark not found. Run this command from archsync-benchmark or pass --benchmark <order-platform-directory>.",
  );
}

async function chooseScenario(manifest: DemoManifest): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`
ARCHSYNC MVP DEMO

  1. PASS   - no architecture impact
  2. BLOCK  - architecture rule violation
  3. REVIEW - valid architecture evolution
  4. ALL    - run all three scenarios
`);
    const answer = (await readline.question("Choose a scenario [1-4]: ")).trim();
    return ({ "1": "pass", "2": "block", "3": "review", "4": "all" } as Record<string, string>)[answer]
      ?? manifest.cases.find(({ id }) => id === answer)?.id
      ?? "all";
  } finally {
    readline.close();
  }
}

function scenarioForAlias(manifest: DemoManifest, alias: string): DemoScenario[] {
  const aliases: Record<string, DemoScenario["category"]> = {
    pass: "no-impact",
    block: "violation",
    review: "evolution",
  };
  if (alias === "all") {
    return ["no-impact", "violation", "evolution"].map((category) => {
      const scenario = manifest.cases.find((candidate) => candidate.category === category);
      if (!scenario) throw new Error(`Benchmark has no ${category} demo case`);
      return scenario;
    });
  }
  const category = aliases[alias];
  const scenario = category
    ? manifest.cases.find((candidate) => candidate.category === category)
    : manifest.cases.find((candidate) => candidate.id === alias);
  if (!scenario) {
    throw new Error(`Unknown demo scenario '${alias}'. Use pass, block, review, all, or a case id.`);
  }
  return [scenario];
}

async function runScenario(
  benchmark: string,
  manifest: DemoManifest,
  scenario: DemoScenario,
): Promise<DemoCaseResult> {
  const architectureResult = await loadArchitecture(join(benchmark, manifest.benchmark.architecture));
  if (!architectureResult.valid || !architectureResult.value) {
    throw new Error("Benchmark architecture is invalid");
  }
  const repository = await mkdtemp(join(tmpdir(), `archsync-demo-${scenario.id}-`));
  try {
    await cp(join(benchmark, manifest.benchmark.repository), repository, { recursive: true });
    git(repository, ["init", "-b", "main"]);
    git(repository, ["config", "user.email", "demo@archsync.invalid"]);
    git(repository, ["config", "user.name", "ArchSync CLI Demo"]);
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "controlled architecture baseline"]);
    git(repository, ["apply", "--whitespace=nowarn", join(benchmark, scenario.patch)]);

    const cold = await checkRepositoryDiff(architectureResult.value, repository, { base_ref: "." });
    const warm = await checkRepositoryDiff(architectureResult.value, repository, { base_ref: "." });
    const expected = expectedDecision(scenario.category);
    const changedFilesMatch = JSON.stringify(warm.changed_files.map(({ path }) => path).sort()) ===
      JSON.stringify([...scenario.changed_files].sort());
    return {
      case_id: scenario.id,
      title: scenario.title,
      expected_decision: expected,
      actual_decision: warm.decision,
      match: warm.classification === scenario.category && warm.decision === expected && changedFilesMatch &&
        !cold.cache.hit && warm.cache.hit,
      cache: { cold: cold.cache.hit ? "HIT" : "MISS", warm: warm.cache.hit ? "HIT" : "MISS" },
      changed_files_match: changedFilesMatch,
      result: warm,
    };
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
}

export async function runDemo(options: DemoOptions = {}): Promise<DemoResult> {
  const benchmark = await resolveBenchmark(options.benchmark);
  const manifest = JSON.parse(await readFile(join(benchmark, "ground-truth.json"), "utf8")) as DemoManifest;
  const selected = options.scenario ?? (
    options.interactive && process.stdin.isTTY ? await chooseScenario(manifest) : "all"
  );
  const scenarios = scenarioForAlias(manifest, selected.toLowerCase());
  const cases: DemoCaseResult[] = [];
  for (const scenario of scenarios) {
    cases.push(await runScenario(benchmark, manifest, scenario));
  }
  const result = { ok: cases.every(({ match }) => match), benchmark, cases };
  if (options.report) {
    const outputPath = resolve(options.report);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${formatDemoMarkdown(result)}\n`, "utf8");
  }
  return result;
}

function firstEvidence(result: Phase3Result): string {
  const evidence = result.introduced_findings.flatMap(({ source_evidence }) => source_evidence)[0];
  return evidence ? `${evidence.file}:${evidence.line}:${evidence.column}` : "No new architecture finding";
}

export function formatDemoResult(result: DemoResult, verbose = false): string {
  const sections = result.cases.map((demoCase) => [
    "────────────────────────────────────────────────────────────",
    `SCENARIO: ${demoCase.case_id} - ${demoCase.title}`,
    `DECISION: ${demoCase.actual_decision}`,
    `EVIDENCE: ${firstEvidence(demoCase.result)}`,
    `CACHE: cold ${demoCase.cache.cold}, warm ${demoCase.cache.warm}`,
    `EXPECTED: ${demoCase.expected_decision}`,
    `RESULT: ${demoCase.match ? "MATCH" : "MISMATCH"}`,
    ...(verbose ? ["", formatPhase3Result(demoCase.result)] : []),
  ].join("\n"));
  return [
    "ARCHSYNC MVP DEMO",
    "Real source patches, real Git diffs, deterministic decisions",
    "",
    ...sections,
    "────────────────────────────────────────────────────────────",
    result.ok
      ? `DEMO COMPLETE: ${result.cases.length}/${result.cases.length} scenarios matched ground truth.`
      : "DEMO FAILED: At least one scenario did not match ground truth.",
  ].join("\n");
}

export function formatDemoMarkdown(result: DemoResult): string {
  return [
    "# ArchSync CLI demo report",
    "",
    `Overall result: **${result.ok ? "PASS" : "FAIL"}**`,
    "",
    "| Case | Expected | Actual | Cache | Evidence | Match |",
    "| --- | --- | --- | --- | --- | --- |",
    ...result.cases.map((demoCase) =>
      `| ${demoCase.case_id} | ${demoCase.expected_decision} | ${demoCase.actual_decision} | ${demoCase.cache.cold} -> ${demoCase.cache.warm} | ${firstEvidence(demoCase.result)} | ${demoCase.match ? "YES" : "NO"} |`,
    ),
  ].join("\n");
}
