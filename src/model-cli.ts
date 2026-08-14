import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import {
  analyzeConformance,
  buildGraph,
  diffGraphs,
  formatConformanceResult,
  formatValidationIssues,
  generateConformanceDrawio,
  generateConformanceMermaid,
  generateDrawio,
  generateMermaid,
  loadArchitecture,
  validateBenchmark,
  type ConformanceResult,
  type ValidationIssue,
} from "@archsync/core";

export const modelCommands = new Set([
  "validate",
  "validate-dir",
  "graph",
  "diff",
  "check",
  "check-json",
  "report",
  "mermaid",
  "drawio",
  "benchmark",
]);

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatInvalidArchitecture(
  filePath: string,
  issues: ValidationIssue[],
  role?: "EXPECTED" | "OBSERVED",
): string {
  return [
    "RESULT: INVALID",
    ...(role ? [`MODEL: ${role}`] : []),
    `FILE: ${filePath}`,
    "",
    formatValidationIssues(issues),
    "",
    "NEXT STEP: Fix the listed problems, then run validation again.",
    "EXIT CODE: 1 (INVALID)",
  ].join("\n");
}

async function validateFile(filePath: string): Promise<boolean> {
  const result = await loadArchitecture(filePath);
  if (!result.valid || !result.value) {
    console.error(formatInvalidArchitecture(filePath, result.issues));
    return false;
  }

  const graph = buildGraph(result.value);
  console.log([
    "RESULT: VALID",
    `FILE: ${filePath}`,
    `SUMMARY: ${counted(graph.nodes.size, "component")}, ${counted(graph.edges.length, "relationship")}`,
  ].join("\n"));
  return true;
}

function serializeConformance(result: ConformanceResult): object {
  return {
    classification: result.classification,
    summary: result.summary,
    findings: result.findings,
    diff: {
      addedNodes: result.diff.addedNodes.map(({ id }) => id),
      removedNodes: result.diff.removedNodes.map(({ id }) => id),
      changedNodes: result.diff.changedNodes.map(({ id, expected, observed }) => ({
        id,
        expected: expected.component,
        observed: observed.component,
      })),
      addedEdges: result.diff.addedEdges.map(({ key }) => key),
      removedEdges: result.diff.removedEdges.map(({ key }) => key),
    },
  };
}

export async function runModelCommand(command: string, args: string[]): Promise<number | undefined> {
  if (!modelCommands.has(command)) return undefined;
  const [input, output, reportOutput] = args;
  if (!input) return 2;

  if (command === "validate") {
    return (await validateFile(resolve(input))) ? 0 : 1;
  }

  if (command === "validate-dir") {
    const directory = resolve(input);
    const files = (await readdir(directory))
      .filter((file) => [".yaml", ".yml"].includes(extname(file)))
      .sort();
    let valid = true;
    for (const file of files) {
      const expectedInvalid = file.startsWith("invalid-") || file.startsWith("invalid.");
      const filePath = join(directory, file);
      if (expectedInvalid) {
        const result = await loadArchitecture(filePath);
        if (result.valid) {
          console.error(`UNEXPECTED VALID ${filePath}`);
          valid = false;
        } else {
          console.log(`EXPECTED INVALID ${filePath} (${result.issues.length} issues)`);
        }
      } else if (!(await validateFile(filePath))) {
        valid = false;
      }
    }
    return valid ? 0 : 1;
  }

  if (command === "diff" || command === "check" || command === "check-json" || command === "report") {
    if (!output) return 2;
    const expectedPath = resolve(input);
    const observedPath = resolve(output);
    const [expected, observed] = await Promise.all([
      loadArchitecture(expectedPath),
      loadArchitecture(observedPath),
    ]);

    if (!expected.valid || !expected.value) {
      console.error(formatInvalidArchitecture(expectedPath, expected.issues, "EXPECTED"));
      return 1;
    }
    if (!observed.valid || !observed.value) {
      console.error(formatInvalidArchitecture(observedPath, observed.issues, "OBSERVED"));
      return 1;
    }

    if (command === "diff") {
      const diff = diffGraphs(buildGraph(expected.value), buildGraph(observed.value));
      console.log(JSON.stringify({
        addedNodes: diff.addedNodes.map(({ id }) => id),
        removedNodes: diff.removedNodes.map(({ id }) => id),
        changedNodes: diff.changedNodes.map(({ id, expected: before, observed: after }) => ({
          id,
          expected: before.component,
          observed: after.component,
        })),
        addedEdges: diff.addedEdges.map(({ key, from, to, type }) => ({ key, from, to, type })),
        removedEdges: diff.removedEdges.map(({ key, from, to, type }) => ({ key, from, to, type })),
      }, null, 2));
      return 0;
    }

    const result = analyzeConformance(expected.value, observed.value);
    if (command === "report") {
      if (!reportOutput) return 2;
      const outputPath = resolve(reportOutput);
      const extension = extname(outputPath).toLowerCase();
      const rendered = extension === ".mmd"
        ? generateConformanceMermaid(expected.value, observed.value, result)
        : extension === ".drawio"
          ? generateConformanceDrawio(expected.value, observed.value, result)
          : undefined;
      if (!rendered) {
        console.error("Report output must end with .mmd or .drawio");
        return 2;
      }
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered, "utf8");
      console.log(`WROTE ${outputPath} (${result.classification.toUpperCase()})`);
      return 0;
    }

    console.log(command === "check-json"
      ? JSON.stringify(serializeConformance(result), null, 2)
      : formatConformanceResult(result));
    return result.classification === "no-impact" ? 0 : result.classification === "violation" ? 1 : 3;
  }

  if (command === "graph" || command === "mermaid" || command === "drawio") {
    const filePath = resolve(input);
    const result = await loadArchitecture(filePath);
    if (!result.valid || !result.value) {
      console.error(formatInvalidArchitecture(filePath, result.issues));
      return 1;
    }

    if (command === "graph") {
      const graph = buildGraph(result.value);
      console.log(JSON.stringify({
        nodes: [...graph.nodes.keys()],
        edges: graph.edges.map(({ key, from, to, type }) => ({ key, from, to, type })),
      }, null, 2));
      return 0;
    }

    const rendered = command === "drawio" ? generateDrawio(result.value) : generateMermaid(result.value);
    if (output) {
      const outputPath = resolve(output);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, rendered, "utf8");
      console.log(`WROTE ${outputPath}`);
    } else {
      console.log(rendered);
    }
    return 0;
  }

  const result = await validateBenchmark(input);
  if (!result.valid) {
    console.error("INVALID BENCHMARK");
    console.error(result.issues.map((issue) => `- ${issue}`).join("\n"));
    return 1;
  }
  console.log(
    `VALID BENCHMARK (${result.evaluatedCases}/${result.totalCases} engine-evaluated: ${result.summary["no-impact"]} no-impact, ${result.summary.violation} violation, ${result.summary.evolution} evolution)`,
  );
  return 0;
}
