#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { loadArchitecture } from "@archsync/core";

import { analyzeTypeScriptRepository } from "./analyzer.js";
import { evaluatePhase2Benchmark, formatBenchmarkResult } from "./benchmark.js";
import { formatDemoResult, runDemo } from "./demo.js";
import { formatDoctorResult, runDoctor } from "./doctor.js";
import { checkRepository, formatGuardianResult } from "./guardian.js";
import { runModelCommand } from "./model-cli.js";
import { formatVersionResult, loadVersionResult } from "./version.js";
import {
  appendGitHubStepSummary,
  checkRepositoryDiff,
  formatGitHubAnnotations,
  formatPhase3Markdown,
  formatPhase3Result,
} from "./phase3.js";

const cliVersion = "0.3.2";

function usage(error = true): number {
  const output = `ArchSync CLI ${cliVersion}

Usage:
  archsync <command> [options]

Source and Git commands:
  archsync scan <architecture.yaml> <repository> [observed.json]
  archsync check <architecture.yaml> <repository> [--diff <base-ref>] [--json] [--github] [--report <file>]
  archsync check-json <architecture.yaml> <repository> [--diff <base-ref>]
  archsync benchmark <ground-truth.json> [result.json]

Architecture Model commands:
  archsync model validate <architecture.yaml>
  archsync model validate-dir <directory>
  archsync model graph <architecture.yaml>
  archsync model diff <expected.yaml> <observed.yaml>
  archsync model check <expected.yaml> <observed.yaml>
  archsync model check-json <expected.yaml> <observed.yaml>
  archsync model report <expected.yaml> <observed.yaml> <output.mmd|output.drawio>
  archsync model mermaid <architecture.yaml> [output.mmd]
  archsync model drawio <architecture.yaml> [output.drawio]
  archsync model benchmark <ground-truth.json>

Demo and diagnostics:
  archsync demo [--benchmark <directory>] [--scenario pass|block|review|all] [--report <file>] [--json] [--verbose]
  archsync doctor [--json]
  archsync version [--json]
  archsync help

Compatibility:
  archsync-guardian remains available. Model-only commands such as validate,
  graph, diff, report, mermaid and drawio also work without the 'model' prefix.`;
  (error ? console.error : console.log)(output);
  return error ? 2 : 0;
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
  const [command, ...commandArgs] = process.argv.slice(2);
  if (!command) {
    process.exitCode = usage();
    return;
  }

  if (["help", "--help", "-h"].includes(command)) {
    process.exitCode = usage(false);
    return;
  }

  if (["version", "--version", "-v"].includes(command)) {
    const result = await loadVersionResult();
    console.log(commandArgs.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatVersionResult(result));
    return;
  }

  if (command === "doctor") {
    const result = runDoctor();
    console.log(commandArgs.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatDoctorResult(result));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "demo") {
    const benchmark = optionValue(commandArgs, "--benchmark");
    const scenario = optionValue(commandArgs, "--scenario");
    const report = optionValue(commandArgs, "--report");
    const result = await runDemo({
      ...(benchmark ? { benchmark } : {}),
      ...(scenario ? { scenario } : {}),
      ...(report ? { report } : {}),
      json: commandArgs.includes("--json"),
      verbose: commandArgs.includes("--verbose"),
      interactive: !commandArgs.includes("--no-interactive"),
    });
    console.log(commandArgs.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatDemoResult(result, commandArgs.includes("--verbose")));
    process.exitCode = result.ok ? 0 : 2;
    return;
  }

  if (command === "model") {
    const [modelCommand, ...modelArgs] = commandArgs;
    if (!modelCommand) {
      process.exitCode = usage();
      return;
    }
    const exitCode = await runModelCommand(modelCommand, modelArgs);
    process.exitCode = exitCode ?? usage();
    return;
  }

  const modelAliases = new Set(["validate", "validate-dir", "graph", "diff", "report", "mermaid", "drawio"]);
  if (modelAliases.has(command) || command === "validate-benchmark") {
    const exitCode = await runModelCommand(
      command === "validate-benchmark" ? "benchmark" : command,
      commandArgs,
    );
    process.exitCode = exitCode ?? usage();
    return;
  }

  const [input, repository, ...args] = commandArgs;
  const modelCheckCompatibility = ["check", "check-json"].includes(command) &&
    repository !== undefined && /\.ya?ml$/i.test(repository);
  if (modelCheckCompatibility) {
    const exitCode = await runModelCommand(command, commandArgs);
    process.exitCode = exitCode ?? usage();
    return;
  }

  if (!input) {
    process.exitCode = usage();
    return;
  }

  if (command === "benchmark") {
    const result = await evaluatePhase2Benchmark(input);
    if (repository) await writeJson(repository, result);
    console.log(formatBenchmarkResult(result));
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (!repository) {
    process.exitCode = usage();
    return;
  }
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
    const jsonOutput = command === "check-json" || args.includes("--json");
    if (args.includes("--diff")) {
      const baseRef = optionValue(args, "--diff");
      if (!baseRef) {
        process.exitCode = usage();
        return;
      }
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
      console.log(jsonOutput ? JSON.stringify(result, null, 2) : formatPhase3Result(result));
      process.exitCode = result.decision === "PASS" ? 0 : result.decision === "BLOCK" ? 1 : 3;
      return;
    }
    const result = await checkRepository(architecture, repository);
    console.log(jsonOutput ? JSON.stringify(result, null, 2) : formatGuardianResult(result));
    process.exitCode = result.classification === "no-impact"
      ? 0
      : result.classification === "violation"
        ? 1
        : 3;
    return;
  }

  process.exitCode = usage();
}

try {
  await main();
} catch (error) {
  console.error(`ARCHSYNC ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
