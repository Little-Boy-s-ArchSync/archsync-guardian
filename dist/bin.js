#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadArchitecture } from "@archsync/core";
import { analyzeTypeScriptRepository } from "./analyzer.js";
import { evaluatePhase2Benchmark, formatBenchmarkResult } from "./benchmark.js";
import { checkRepository, formatGuardianResult } from "./guardian.js";
function usage() {
    console.error(`Usage:
  archsync-guardian scan <architecture.yaml> <repository> [observed.json]
  archsync-guardian check <architecture.yaml> <repository>
  archsync-guardian check-json <architecture.yaml> <repository>
  archsync-guardian benchmark <ground-truth.json> [result.json]`);
    process.exit(2);
}
async function writeJson(output, value) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    console.log(`WROTE ${outputPath}`);
}
async function requiredArchitecture(filePath) {
    const result = await loadArchitecture(resolve(filePath));
    if (!result.valid || !result.value) {
        console.error("INVALID ARCHITECTURE MODEL");
        console.error(result.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n"));
        process.exitCode = 2;
        return undefined;
    }
    return result.value;
}
async function main() {
    const [, , command, input, repository, output] = process.argv;
    if (!command || !input)
        usage();
    if (command === "benchmark") {
        const result = await evaluatePhase2Benchmark(input);
        if (repository)
            await writeJson(repository, result);
        console.log(formatBenchmarkResult(result));
        process.exitCode = result.valid ? 0 : 1;
        return;
    }
    if (!repository)
        usage();
    const architecture = await requiredArchitecture(input);
    if (!architecture)
        return;
    if (command === "scan") {
        const observed = await analyzeTypeScriptRepository(repository, architecture);
        if (output) {
            await writeJson(output, observed);
        }
        else {
            console.log(JSON.stringify(observed, null, 2));
        }
        return;
    }
    if (command === "check" || command === "check-json") {
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
await main();
//# sourceMappingURL=bin.js.map