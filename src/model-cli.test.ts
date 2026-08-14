import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelCommands, runModelCommand } from "./model-cli.js";

let root: string;
let stdout: string[];
let stderr: string[];

const expectedYaml = `version: "0.1"
metadata:
  name: model-cli-test
components:
  api:
    type: service
    layer: application
  database:
    type: database
    layer: data
  cache:
    type: cache
    layer: data
relationships:
  - from: api
    to: database
    type: data
rules:
  - id: ARCH-CLI-001
    type: deny
    from: api
    to: cache
    relationship_type: data
    severity: error
`;

const violationYaml = expectedYaml.replace(
  "rules:\n",
  "  - from: api\n    to: cache\n    type: data\nrules:\n",
);

const evolutionYaml = `version: "0.1"
metadata:
  name: model-cli-test
components:
  api:
    type: service
    layer: application
    technology: Bun
  database:
    type: database
    layer: data
  worker:
    type: worker
    layer: application
relationships:
  - from: worker
    to: database
    type: data
`;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "archsync-model-cli-test-"));
  stdout = [];
  stderr = [];
  vi.spyOn(console, "log").mockImplementation((value) => stdout.push(String(value)));
  vi.spyOn(console, "error").mockImplementation((value) => stderr.push(String(value)));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function fixture(name: string, source: string): Promise<string> {
  const path = join(root, name);
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, source, "utf8");
  return path;
}

describe("unified Architecture Model CLI adapter", () => {
  it("exposes every legacy model command and rejects unknown or incomplete invocations", async () => {
    expect([...modelCommands]).toEqual([
      "validate", "validate-dir", "graph", "diff", "check", "check-json",
      "report", "mermaid", "drawio", "benchmark",
    ]);
    expect(await runModelCommand("unknown", [])).toBeUndefined();
    expect(await runModelCommand("validate", [])).toBe(2);
    expect(await runModelCommand("diff", ["expected.yaml"])).toBe(2);
  });

  it("validates singular/plural models and prints actionable invalid-model output", async () => {
    const minimal = await fixture("minimal.yaml", `version: "0.1"
metadata:
  name: minimal
components:
  only:
    type: service
    layer: application
relationships: []
`);
    const expected = await fixture("expected.yaml", expectedYaml);
    const invalid = await fixture("invalid.yaml", "version: invalid\n");

    expect(await runModelCommand("validate", [minimal])).toBe(0);
    expect(await runModelCommand("validate", [expected])).toBe(0);
    expect(await runModelCommand("validate", [invalid])).toBe(1);
    expect(stdout.join("\n")).toContain("1 component, 0 relationships");
    expect(stdout.join("\n")).toContain("3 components, 1 relationship");
    expect(stderr.join("\n")).toContain("RESULT: INVALID");
  });

  it("validates a directory including expected-invalid, unexpected-valid and ordinary invalid files", async () => {
    const goodDirectory = join(root, "all-good");
    await mkdir(goodDirectory);
    await writeFile(join(goodDirectory, "valid.yaml"), expectedYaml, "utf8");
    expect(await runModelCommand("validate-dir", [goodDirectory])).toBe(0);

    const mixedDirectory = join(root, "mixed");
    await mkdir(mixedDirectory);
    await writeFile(join(mixedDirectory, "invalid-expected.yaml"), "version: invalid\n", "utf8");
    await writeFile(join(mixedDirectory, "invalid.case.yml"), "version: invalid\n", "utf8");
    await writeFile(join(mixedDirectory, "invalid-unexpected.yaml"), expectedYaml, "utf8");
    await writeFile(join(mixedDirectory, "broken.yaml"), "version: invalid\n", "utf8");
    await writeFile(join(mixedDirectory, "ignored.txt"), "not yaml", "utf8");

    expect(await runModelCommand("validate-dir", [mixedDirectory])).toBe(1);
    expect(stdout.join("\n")).toContain("EXPECTED INVALID");
    expect(stderr.join("\n")).toContain("UNEXPECTED VALID");
  });

  it("diffs models and rejects invalid expected or observed inputs with their roles", async () => {
    const expected = await fixture("expected.yaml", expectedYaml);
    const evolution = await fixture("evolution.yaml", evolutionYaml);
    const invalid = await fixture("invalid.yaml", "version: invalid\n");

    expect(await runModelCommand("diff", [expected, evolution])).toBe(0);
    expect(stdout.join("\n")).toContain('"changedNodes"');
    expect(stdout.join("\n")).toContain('"removedNodes"');
    expect(stdout.join("\n")).toContain('"addedNodes"');
    expect(await runModelCommand("diff", [invalid, evolution])).toBe(1);
    expect(stderr.join("\n")).toContain("MODEL: EXPECTED");
    expect(await runModelCommand("diff", [expected, invalid])).toBe(1);
    expect(stderr.join("\n")).toContain("MODEL: OBSERVED");
  });

  it("returns PASS, BLOCK and REVIEW exit contracts in human and JSON modes", async () => {
    const expected = await fixture("expected.yaml", expectedYaml);
    const violation = await fixture("violation.yaml", violationYaml);
    const evolution = await fixture("evolution.yaml", evolutionYaml);

    expect(await runModelCommand("check", [expected, expected])).toBe(0);
    expect(await runModelCommand("check", [expected, violation])).toBe(1);
    expect(await runModelCommand("check-json", [expected, evolution])).toBe(3);
    expect(stdout.join("\n")).toContain("DECISION: PASS");
    expect(stdout.join("\n")).toContain("DECISION: BLOCK");
    expect(stdout.join("\n")).toContain('"changedNodes"');
  });

  it("writes Mermaid/draw.io model and conformance reports and rejects unsupported report extensions", async () => {
    const expected = await fixture("expected.yaml", expectedYaml);
    const violation = await fixture("violation.yaml", violationYaml);
    const mermaid = join(root, "output", "model.mmd");
    const drawio = join(root, "output", "model.drawio");
    const reportMermaid = join(root, "reports", "violation.mmd");
    const reportDrawio = join(root, "reports", "violation.drawio");

    expect(await runModelCommand("mermaid", [expected])).toBe(0);
    expect(await runModelCommand("drawio", [expected])).toBe(0);
    expect(await runModelCommand("mermaid", [expected, mermaid])).toBe(0);
    expect(await runModelCommand("drawio", [expected, drawio])).toBe(0);
    expect(await runModelCommand("report", [expected, violation])).toBe(2);
    expect(await runModelCommand("report", [expected, violation, reportMermaid])).toBe(0);
    expect(await runModelCommand("report", [expected, violation, reportDrawio])).toBe(0);
    expect(await runModelCommand("report", [expected, violation, join(root, "report.txt")])).toBe(2);
    expect(await readFile(mermaid, "utf8")).toContain("flowchart LR");
    expect(await readFile(drawio, "utf8")).toContain("<mxfile");
    expect(await readFile(reportMermaid, "utf8")).toContain("ArchSync: VIOLATION");
    expect(await readFile(reportDrawio, "utf8")).toContain("VIOLATION");
    expect(stderr.join("\n")).toContain("Report output must end with .mmd or .drawio");
  });

  it("prints graph JSON, rejects an invalid graph model and validates benchmark manifests", async () => {
    const expected = await fixture("expected.yaml", expectedYaml);
    const invalid = await fixture("invalid.yaml", "version: invalid\n");
    const benchmark = resolve("test/fixtures/ground-truth.json");
    const invalidBenchmark = await fixture("invalid-benchmark.json", "cases: [unterminated");

    expect(await runModelCommand("graph", [expected])).toBe(0);
    expect(await runModelCommand("graph", [invalid])).toBe(1);
    expect(await runModelCommand("benchmark", [benchmark])).toBe(0);
    expect(await runModelCommand("benchmark", [invalidBenchmark])).toBe(1);
    expect(stdout.join("\n")).toContain('"edges"');
    expect(stdout.join("\n")).toContain("VALID BENCHMARK");
    expect(stderr.join("\n")).toContain("INVALID BENCHMARK");
  });
});
