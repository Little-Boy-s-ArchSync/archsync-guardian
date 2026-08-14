#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadArchitecture } from "@archsync/core";

import { analyzeTypeScriptRepository } from "./analyzer.js";
import { evaluatePhase2Benchmark, formatBenchmarkResult } from "./benchmark.js";
import { checkRepository, formatGuardianResult } from "./guardian.js";
import {
  appendGitHubStepSummary,
  checkRepositoryDiff,
  formatGitHubAnnotations,
  formatPhase3Markdown,
  formatPhase3Result,
} from "./phase3.js";

function usage(): never {
  console.error(`Usage:
  archsync-guardian scan <architecture.yaml> <repository> [observed.json]
  archsync-guardian check <architecture.yaml> <repository> [--diff <base-ref>] [--github] [--report <file>]
  archsync-guardian check-json <architecture.yaml> <repository> [--diff <base-ref>]
  archsync-guardian benchmark <ground-truth.json> [result.json]`);
  process.exit(2);
}

async function writeJson(output: string, value: unknown): Promise<void> {
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`WROTE ${outputPath}`);
}

async function writeText(output: string, value: string): Promise<void> {
  const outputPath = resolve(output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, value.endsWith("\n") ? value : `${value}\n`, "utf8");
  console.error(`WROTE ${outputPath}`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function requiredArchitecture(filePath: string) {
  const result = await loadArchitecture(resolve(filePath));
  if (!result.valid || !result.value) {
    console.error("INVALID ARCHITECTURE MODEL");
    console.error(result.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"));
    process.exitCode = 2;
    return undefined;
  }
  return result.value;
}

async function main(): Promise<void> {
  const [, , command, input, repository, ...args] = process.argv;
  if (!command || !input) usage();

  if (command === "benchmark") {
    const result = await evaluatePhase2Benchmark(input);
    if (repository) await writeJson(repository, result);
    console.log(formatBenchmarkResult(result));
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (!repository) usage();
  const architecture = await requiredArchitecture(input);
  if (!architecture) return;

  if (command === "scan") {
    const observed = await analyzeTypeScriptRepository(repository, architecture);
    if (args[0]) {
      await writeJson(args[0], observed);
    } else {
      console.log(JSON.stringify(observed, null, 2));
    }
    return;
  }

  if (command === "check" || command === "check-json") {
    if (args.includes("--diff")) {
      const baseRef = optionValue(args, "--diff");
      if (!baseRef) usage();
      const cacheDirectory = optionValue(args, "--cache-dir");
      const result = await checkRepositoryDiff(architecture, repository, {
        base_ref: baseRef,
        ...(cacheDirectory ? { cache_dir: cacheDirectory } : {}),
        use_cache: !args.includes("--no-cache"),
      });
      const report = optionValue(args, "--report");
      if (report) await writeText(report, formatPhase3Markdown(result));
      if (args.includes("--github")) {
        const annotations = formatGitHubAnnotations(result);
        if (annotations) console.log(annotations);
        await appendGitHubStepSummary(result);
      }
      console.log(command === "check-json" ? JSON.stringify(result, null, 2) : formatPhase3Result(result));
      process.exitCode = result.decision === "PASS" ? 0 : result.decision === "BLOCK" ? 1 : 3;
      return;
    }
    const result = await checkRepository(architecture, repository);
    console.log(command === "check-json" ? JSON.stringify(result, null, 2) : formatGuardianResult(result));
    process.exitCode = result.classification === "no-impact"
      ? 0
      : result.classification === "violation"
        ? 1
        : 3;
    return;
  }

  usage();
}

try {
  await main();
} catch (error) {
  console.error(`ARCHSYNC ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
