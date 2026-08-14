import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import {
  buildGraph,
  diffGraphs,
  edgeKey,
  type ArchitectureDocument,
} from "@archsync/core";

import { analyzeTypeScriptRepository } from "./analyzer.js";
import {
  type GuardianFinding,
  type ObservedArchitecture,
  type SourceEvidence,
  toArchitectureDocument,
} from "./contracts.js";
import { evaluateObservedArchitecture } from "./guardian.js";
import {
  parseChangedLines,
  parseNameStatus,
  parseNumStat,
  portablePath,
  repositoryRelativePath,
  sourceComponent,
  sourceExtensions,
} from "./phase3-git.js";

const execFileAsync = promisify(execFile);

export interface ChangedLineRange {
  start: number;
  end: number;
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  previous_path?: string;
  additions: number;
  deletions: number;
  changed_lines: ChangedLineRange[];
}

export interface Phase3Options {
  base_ref?: string;
  cache_dir?: string;
  use_cache?: boolean;
}

export interface Phase3Result {
  contract_version: "0.1";
  mode: "git-diff";
  classification: "no-impact" | "violation" | "evolution";
  decision: "PASS" | "BLOCK" | "REVIEW";
  repository: {
    root: string;
    base_ref: string;
    base_sha: string;
    head_sha: string;
    worktree_dirty: boolean;
  };
  changed_files: ChangedFile[];
  affected_components: string[];
  architecture_delta: {
    added_nodes: string[];
    removed_nodes: string[];
    changed_nodes: string[];
    added_edges: string[];
    removed_edges: string[];
  };
  introduced_findings: GuardianFinding[];
  resolved_findings: GuardianFinding[];
  baseline: {
    classification: "no-impact" | "violation" | "evolution";
    decision: "PASS" | "BLOCK" | "REVIEW";
    findings: number;
  };
  head: {
    classification: "no-impact" | "violation" | "evolution";
    decision: "PASS" | "BLOCK" | "REVIEW";
    findings: number;
  };
  pre_existing_findings: number;
  cache: {
    hit: boolean;
    key: string;
  };
  analysis: {
    strategy: "cached-component-incremental";
    baseline_scanned_files: number;
    incremental_scanned_files: number;
    head_scanned_files: number;
    analyzed_components: number;
    baseline_load_ms: number;
    incremental_scan_ms: number;
    total_ms: number;
  };
}

interface CacheEnvelope {
  contract_version: "0.1";
  key: string;
  base_sha: string;
  architecture_sha256: string;
  observed: ObservedArchitecture;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

async function git(repository: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function architectureHash(expected: ArchitectureDocument): string {
  return createHash("sha256").update(JSON.stringify(expected)).digest("hex");
}

function findingKey(finding: GuardianFinding): string {
  return [
    finding.kind,
    finding.rule_id ?? "",
    finding.change ?? "",
    finding.component ?? "",
    finding.edge?.key ?? "",
  ].join("|");
}

function evidenceKey(evidence: SourceEvidence): string {
  return [
    evidence.file,
    evidence.line,
    evidence.column,
    evidence.detector,
    evidence.snippet,
  ].join("\0");
}

function uniqueEvidence(values: SourceEvidence[]): SourceEvidence[] {
  return [...new Map(values.map((value) => [evidenceKey(value), value])).values()].sort((a, b) =>
    evidenceKey(a).localeCompare(evidenceKey(b)),
  );
}

function evidenceFromComponents(
  observed: ObservedArchitecture,
  affected: Set<string>,
): number {
  const files = new Set<string>();
  for (const component of affected) {
    for (const evidence of observed.components[component]?.evidence ?? []) {
      if (evidence.detector === "component-root") files.add(evidence.file);
    }
  }
  return files.size;
}

function evidenceBelongsToAffectedSource(
  evidence: SourceEvidence,
  affected: Set<string>,
): boolean {
  return [...affected].some((component) =>
    evidence.file === component || evidence.file.startsWith(`${component}/`),
  );
}

export function mergeIncrementalObservedArchitecture(
  baseline: ObservedArchitecture,
  partial: ObservedArchitecture,
  affectedComponents: readonly string[],
): ObservedArchitecture {
  const affected = new Set(affectedComponents);
  const components = new Map<string, ObservedArchitecture["components"][string]>();
  const relationships = new Map<string, ObservedArchitecture["relationships"][number]>();

  for (const [id, component] of Object.entries(baseline.components)) {
    if (affected.has(id)) continue;
    const evidence = component.evidence.filter((item) =>
      !evidenceBelongsToAffectedSource(item, affected),
    );
    if (evidence.length > 0) {
      components.set(id, { component: component.component, evidence: uniqueEvidence(evidence) });
    }
  }

  for (const relationship of baseline.relationships) {
    const evidence = relationship.evidence.filter((item) =>
      !evidenceBelongsToAffectedSource(item, affected),
    );
    if (evidence.length > 0) {
      relationships.set(edgeKey(relationship), { ...relationship, evidence: uniqueEvidence(evidence) });
    }
  }

  for (const [id, component] of Object.entries(partial.components)) {
    const current = components.get(id);
    components.set(id, {
      component: component.component,
      evidence: uniqueEvidence([...(current?.evidence ?? []), ...component.evidence]),
    });
  }

  for (const relationship of partial.relationships) {
    const key = edgeKey(relationship);
    const current = relationships.get(key);
    relationships.set(key, {
      ...relationship,
      evidence: uniqueEvidence([...(current?.evidence ?? []), ...relationship.evidence]),
    });
  }

  const baselineAffectedFiles = evidenceFromComponents(baseline, affected);
  return {
    ...baseline,
    metadata: {
      ...baseline.metadata,
      scanned_files: baseline.metadata.scanned_files - baselineAffectedFiles + partial.metadata.scanned_files,
    },
    components: Object.fromEntries([...components.entries()].sort(([a], [b]) => a.localeCompare(b))),
    relationships: [...relationships.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, relationship]) => relationship),
  };
}

async function addUntrackedFiles(
  repositoryPath: string,
  gitRoot: string,
  repositoryRelative: string,
  files: Map<string, ChangedFile>,
): Promise<void> {
  const pathspec = repositoryRelative || ".";
  const output = await git(gitRoot, ["ls-files", "--others", "--exclude-standard", "--", pathspec]);
  for (const raw of output.split(/\r?\n/u).filter(Boolean)) {
    const path = repositoryRelativePath(raw, repositoryRelative)!;
    const absolute = resolve(repositoryPath, ...path.split("/"));
    const source = await readFile(absolute, "utf8");
    const additions = source.length === 0
      ? 0
      : source.split(/\r?\n/u).length - (/\r?\n$/u.test(source) ? 1 : 0);
    files.set(path, {
      path,
      status: "added",
      additions,
      deletions: 0,
      changed_lines: additions > 0 ? [{ start: 1, end: additions }] : [],
    });
  }
}

async function changedFiles(
  repositoryPath: string,
  gitRoot: string,
  repositoryRelative: string,
  baseSha: string,
): Promise<ChangedFile[]> {
  const pathspec = repositoryRelative || ".";
  const args = [baseSha, "--", pathspec];
  const files = parseNameStatus(
    await git(gitRoot, ["diff", "--name-status", "--find-renames", ...args]),
    repositoryRelative,
  );
  parseNumStat(
    await git(gitRoot, ["diff", "--numstat", "--find-renames", ...args]),
    repositoryRelative,
    files,
  );
  parseChangedLines(
    await git(gitRoot, ["diff", "--unified=0", "--no-color", ...args]),
    repositoryRelative,
    files,
  );
  await addUntrackedFiles(repositoryPath, gitRoot, repositoryRelative, files);
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function materializeBaseSnapshot(
  gitRoot: string,
  repositoryRelative: string,
  baseSha: string,
): Promise<string> {
  const snapshot = await mkdtemp(resolve(tmpdir(), "archsync-phase3-base-"));
  const pathspec = repositoryRelative || ".";
  const output = await git(gitRoot, ["ls-tree", "-r", "--name-only", "-z", baseSha, "--", pathspec]);
  const files = output.split("\0").filter((file) =>
    sourceExtensions.some((extension) => file.endsWith(extension)) && !file.endsWith(".d.ts"),
  );
  for (const gitPath of files) {
    const path = repositoryRelativePath(gitPath, repositoryRelative)!;
    const source = await git(gitRoot, ["show", `${baseSha}:${portablePath(gitPath)}`]);
    const outputPath = resolve(snapshot, ...path.split("/"));
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, source, "utf8");
  }
  return snapshot;
}

async function baselineObserved(
  expected: ArchitectureDocument,
  repositoryPath: string,
  gitRoot: string,
  repositoryRelative: string,
  baseSha: string,
  options: Phase3Options,
): Promise<{ observed: ObservedArchitecture; cacheHit: boolean; cacheKey: string }> {
  const expectedHash = architectureHash(expected);
  const cacheKey = createHash("sha256")
    .update(`${baseSha}\0${expectedHash}\0archsync-typescript@0.2`)
    .digest("hex");
  const gitCachePath = (await git(gitRoot, ["rev-parse", "--git-path", "archsync-cache"])).trim();
  const cacheDirectory = options.cache_dir
    ? resolve(repositoryPath, options.cache_dir)
    : resolve(gitRoot, gitCachePath);
  const cachePath = resolve(cacheDirectory, `${cacheKey}.json`);

  if (options.use_cache !== false) {
    try {
      const cached = JSON.parse(await readFile(cachePath, "utf8")) as CacheEnvelope;
      if (
        cached.contract_version === "0.1" &&
        cached.key === cacheKey &&
        cached.base_sha === baseSha &&
        cached.architecture_sha256 === expectedHash &&
        cached.observed?.analyzer?.version === "0.2"
      ) {
        return { observed: cached.observed, cacheHit: true, cacheKey };
      }
    } catch {
      // Cache misses and stale/corrupt local cache entries are rebuilt safely.
    }
  }

  const snapshot = await materializeBaseSnapshot(gitRoot, repositoryRelative, baseSha);
  try {
    const observed = await analyzeTypeScriptRepository(snapshot, expected);
    if (options.use_cache !== false) {
      const envelope: CacheEnvelope = {
        contract_version: "0.1",
        key: cacheKey,
        base_sha: baseSha,
        architecture_sha256: expectedHash,
        observed,
      };
      await mkdir(cacheDirectory, { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      await rename(temporary, cachePath);
    }
    return { observed, cacheHit: false, cacheKey };
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

function architectureDelta(
  expected: ArchitectureDocument,
  baseline: ObservedArchitecture,
  head: ObservedArchitecture,
): Phase3Result["architecture_delta"] {
  const diff = diffGraphs(
    buildGraph(toArchitectureDocument(expected, baseline)),
    buildGraph(toArchitectureDocument(expected, head)),
  );
  return {
    added_nodes: diff.addedNodes.map(({ id }) => id),
    removed_nodes: diff.removedNodes.map(({ id }) => id),
    changed_nodes: diff.changedNodes.map(({ id }) => id),
    added_edges: diff.addedEdges.map(({ key }) => key),
    removed_edges: diff.removedEdges.map(({ key }) => key),
  };
}

export async function checkRepositoryDiff(
  expected: ArchitectureDocument,
  repositoryPath: string,
  options: Phase3Options = {},
): Promise<Phase3Result> {
  const started = performance.now();
  const repository = resolve(repositoryPath);
  const gitRoot = resolve((await git(repository, ["rev-parse", "--show-toplevel"])).trim());
  const repositoryRelative = portablePath(
    (await git(repository, ["rev-parse", "--show-prefix"])).trim().replace(/\/$/u, ""),
  );

  const baseRef = options.base_ref ?? ".";
  const headSha = (await git(gitRoot, ["rev-parse", "HEAD"])).trim();
  const baseSha = baseRef === "."
    ? headSha
    : (await git(gitRoot, ["merge-base", baseRef, "HEAD"])).trim();
  const pathspec = repositoryRelative || ".";
  const worktreeDirty = (await git(gitRoot, ["status", "--porcelain", "--untracked-files=all", "--", pathspec])).trim().length > 0;
  const files = await changedFiles(repository, gitRoot, repositoryRelative, baseSha);
  const affectedComponents = [...new Set(files.flatMap((file) => {
    const current = sourceComponent(file.path, expected);
    const previous = file.previous_path ? sourceComponent(file.previous_path, expected) : undefined;
    return [current, previous].filter((value): value is string => Boolean(value));
  }))].sort();

  const baselineStarted = performance.now();
  const baseline = await baselineObserved(
    expected,
    repository,
    gitRoot,
    repositoryRelative,
    baseSha,
    options,
  );
  const baselineLoadMs = performance.now() - baselineStarted;

  const incrementalStarted = performance.now();
  const partial = affectedComponents.length > 0
    ? await analyzeTypeScriptRepository(repository, expected, { component_ids: affectedComponents })
    : undefined;
  const headObserved = partial
    ? mergeIncrementalObservedArchitecture(baseline.observed, partial, affectedComponents)
    : baseline.observed;
  const incrementalScanMs = performance.now() - incrementalStarted;

  const baselineResult = evaluateObservedArchitecture(expected, baseline.observed);
  const headResult = evaluateObservedArchitecture(expected, headObserved);
  const baselineByKey = new Map(baselineResult.findings.map((finding) => [findingKey(finding), finding]));
  const headByKey = new Map(headResult.findings.map((finding) => [findingKey(finding), finding]));
  const introduced = [...headByKey.entries()]
    .filter(([key]) => !baselineByKey.has(key))
    .map(([, finding]) => finding);
  const resolved = [...baselineByKey.entries()]
    .filter(([key]) => !headByKey.has(key))
    .map(([, finding]) => finding);
  const violations = introduced.filter((finding) => finding.kind !== "architecture-evolution");
  const evolutions = introduced.filter((finding) => finding.kind === "architecture-evolution");
  const classification = violations.length > 0
    ? "violation"
    : evolutions.length > 0
      ? "evolution"
      : "no-impact";
  const decision = classification === "violation"
    ? "BLOCK"
    : classification === "evolution"
      ? "REVIEW"
      : "PASS";
  const preExisting = [...headByKey.keys()].filter((key) => baselineByKey.has(key)).length;

  return {
    contract_version: "0.1",
    mode: "git-diff",
    classification,
    decision,
    repository: {
      root: portablePath(repository),
      base_ref: baseRef,
      base_sha: baseSha,
      head_sha: headSha,
      worktree_dirty: worktreeDirty,
    },
    changed_files: files,
    affected_components: affectedComponents,
    architecture_delta: architectureDelta(expected, baseline.observed, headObserved),
    introduced_findings: introduced,
    resolved_findings: resolved,
    baseline: {
      classification: baselineResult.classification,
      decision: baselineResult.decision,
      findings: baselineResult.findings.length,
    },
    head: {
      classification: headResult.classification,
      decision: headResult.decision,
      findings: headResult.findings.length,
    },
    pre_existing_findings: preExisting,
    cache: { hit: baseline.cacheHit, key: baseline.cacheKey },
    analysis: {
      strategy: "cached-component-incremental",
      baseline_scanned_files: baseline.observed.metadata.scanned_files,
      incremental_scanned_files: partial?.metadata.scanned_files ?? 0,
      head_scanned_files: headObserved.metadata.scanned_files,
      analyzed_components: affectedComponents.length,
      baseline_load_ms: roundMilliseconds(baselineLoadMs),
      incremental_scan_ms: roundMilliseconds(incrementalScanMs),
      total_ms: roundMilliseconds(performance.now() - started),
    },
  };
}

function findingLocation(finding: GuardianFinding): string {
  const evidence = finding.source_evidence[0];
  return evidence
    ? `${evidence.file}:${evidence.line}:${evidence.column}`
    : `${finding.model_evidence.document}:${finding.model_evidence.path}`;
}

export function formatPhase3Result(result: Phase3Result): string {
  const lines = [
    `DECISION: ${result.decision}`,
    `MODE: Git diff against ${result.repository.base_ref} (${result.repository.base_sha.slice(0, 12)})`,
    `SCOPE: ${result.changed_files.length} changed files, ${result.affected_components.length} affected components`,
  ];

  if (result.introduced_findings.length > 0) {
    lines.push("", `NEW ARCHITECTURE FINDINGS (${result.introduced_findings.length})`);
    result.introduced_findings.forEach((finding, index) => {
      lines.push(
        `${index + 1}. [${finding.id}] ${finding.kind === "architecture-evolution" ? "Architecture evolution" : "Rule violation"}`,
        `   Location: ${findingLocation(finding)}`,
        `   Detail: ${finding.message}`,
      );
    });
  } else {
    lines.push("", "NEW ARCHITECTURE FINDINGS (0)", "No architecture drift was introduced by this diff.");
  }

  if (result.resolved_findings.length > 0) {
    lines.push("", `RESOLVED FINDINGS (${result.resolved_findings.length})`);
    for (const finding of result.resolved_findings) lines.push(`- [${finding.id}] ${finding.message}`);
  }

  lines.push(
    "",
    "ARCHITECTURE DELTA",
    `Components: +${result.architecture_delta.added_nodes.length}, -${result.architecture_delta.removed_nodes.length}, ~${result.architecture_delta.changed_nodes.length}`,
    `Relationships: +${result.architecture_delta.added_edges.length}, -${result.architecture_delta.removed_edges.length}`,
    "",
    "INCREMENTAL ANALYSIS",
    `Components analyzed: ${result.analysis.analyzed_components}`,
    `TypeScript files parsed: ${result.analysis.incremental_scanned_files} of ${result.analysis.head_scanned_files}`,
    `Baseline cache: ${result.cache.hit ? "HIT" : "MISS"}`,
    `Total time: ${result.analysis.total_ms.toFixed(2)} ms`,
    "",
    result.decision === "BLOCK"
      ? "NEXT STEP: Fix the new rule violations before merging."
      : result.decision === "REVIEW"
        ? "NEXT STEP: Request architecture approval before merging or updating the model."
        : "NEXT STEP: No architecture approval is required for this diff.",
    `EXIT CODE: ${result.decision === "PASS" ? 0 : result.decision === "BLOCK" ? 1 : 3} (${result.decision})`,
  );
  return lines.join("\n");
}

function markdownEscape(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function formatPhase3Markdown(result: Phase3Result): string {
  const icon = result.decision === "PASS" ? "PASS" : result.decision === "BLOCK" ? "BLOCK" : "REVIEW";
  const lines = [
    "## ArchSync architecture gate",
    "",
    `**Decision: ${icon}**`,
    "",
    `Compared this change with \`${result.repository.base_ref}\` at \`${result.repository.base_sha.slice(0, 12)}\`. ` +
      `${result.changed_files.length} files changed and ${result.affected_components.length} source components were analyzed incrementally.`,
    "",
  ];
  if (result.introduced_findings.length > 0) {
    lines.push("| Finding | Kind | Location | Detail |", "|---|---|---|---|");
    for (const finding of result.introduced_findings) {
      lines.push(
        `| \`${markdownEscape(finding.id)}\` | ${markdownEscape(finding.kind)} | ` +
        `\`${markdownEscape(findingLocation(finding))}\` | ${markdownEscape(finding.message)} |`,
      );
    }
    lines.push("");
  } else {
    lines.push("No new architecture finding was introduced by this diff.", "");
  }
  lines.push(
    `Architecture delta: **+${result.architecture_delta.added_nodes.length}/-${result.architecture_delta.removed_nodes.length} components**, ` +
      `**+${result.architecture_delta.added_edges.length}/-${result.architecture_delta.removed_edges.length} relationships**.`,
    "",
    `Baseline cache: **${result.cache.hit ? "hit" : "miss"}**; analysis time: **${result.analysis.total_ms.toFixed(2)} ms**.`,
    "",
  );
  return lines.join("\n");
}

function githubEscape(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function githubPropertyEscape(value: string): string {
  return githubEscape(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function formatGitHubAnnotations(result: Phase3Result): string {
  return result.introduced_findings.map((finding) => {
    const evidence = finding.source_evidence[0];
    const level = finding.kind === "architecture-evolution" ? "warning" : "error";
    const properties = [
      evidence ? `file=${githubPropertyEscape(evidence.file)}` : undefined,
      evidence ? `line=${evidence.line}` : undefined,
      evidence ? `col=${evidence.column}` : undefined,
      `title=${githubPropertyEscape(`ArchSync ${finding.id}`)}`,
    ].filter(Boolean).join(",");
    return `::${level} ${properties}::${githubEscape(finding.message)}`;
  }).join("\n");
}

export async function appendGitHubStepSummary(
  result: Phase3Result,
  outputPath = process.env.GITHUB_STEP_SUMMARY,
): Promise<boolean> {
  if (!outputPath) return false;
  await appendFile(outputPath, `${formatPhase3Markdown(result)}\n`, "utf8");
  return true;
}
