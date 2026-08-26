import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "bin.js");
const fixtures = join(root, "test", "fixtures");
const fixture = (...parts) => join(fixtures, ...parts);
const temporary = await mkdtemp(join(tmpdir(), "archsync-guardian-cli-"));
const passed = [];

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
}

function pass(name) {
  passed.push(name);
}

function git(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
}

async function gitFixture(name) {
  const repository = join(temporary, name);
  await cp(fixture("baseline"), repository, { recursive: true });
  git(repository, ["init", "-b", "main"]);
  git(repository, ["config", "user.email", "cli-smoke@archsync.invalid"]);
  git(repository, ["config", "user.name", "ArchSync CLI Smoke"]);
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "baseline"]);
  return repository;
}

try {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(packageJson.bin.archsync, "dist/bin.js");
  assert.equal(packageJson.bin["archsync-guardian"], "dist/bin.js");
  pass("unified and compatibility binaries");

  const help = run(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(`ArchSync CLI ${packageJson.version}`));
  assert.match(help.stdout, /archsync model validate/);
  assert.match(help.stdout, /archsync demo/);
  pass("help lists the complete command surface");

  const version = run(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /Core Model 0\.1\.1, Guardian Analyzer 0\.2, Git Gate 0\.3/);
  pass("version reports component contracts");

  const versionJson = run(["version", "--json"]);
  assert.equal(versionJson.status, 0, versionJson.stderr);
  const versionResult = JSON.parse(versionJson.stdout);
  assert.equal(versionResult.cli.package, "@archsync/guardian");
  assert.equal(versionResult.cli.version, packageJson.version);
  assert.equal(versionResult.contracts.core_model, "0.1.1");
  assert.equal(versionResult.contracts.core_model_previous, "0.1.0");
  assert.equal(versionResult.contracts.core_model_legacy, "0.1");
  assert.deepEqual(versionResult.contracts.core_model_accepted, ["0.1.1", "0.1.0", "0.1"]);
  assert.equal(versionResult.contracts.core_graph, "1.0.0");
  assert.equal(versionResult.contracts.core_finding, "1.0.0");
  assert.equal(versionResult.contracts.core_evidence, "1.0.0");
  assert.equal(versionResult.contracts.core_conformance, "1.0.0");
  assert.equal(versionResult.contracts.core_cli_json, "1.0.0");
  assert.equal(versionResult.contracts.guardian_observed_graph, "0.1");
  assert.equal(versionResult.contracts.guardian_finding, "0.1");
  assert.equal(versionResult.contracts.guardian_source_evidence, "0.1");
  assert.equal(versionResult.contracts.source_evidence, "0.1");
  assert.equal(versionResult.contracts.guardian_result, "0.1");
  assert.equal(versionResult.dependencies.core.package, "@archsync/core");
  assert.equal(versionResult.dependencies.core.package_version, "0.1.1");
  assert.equal(
    versionResult.dependencies.core.source_commit,
    "503b5fe97aa39a78d5e5de80b794a94508e106cc",
  );
  assert.equal(
    versionResult.dependencies.core.vendored_sha256,
    "7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9",
  );
  assert.match(versionResult.provenance.package_content_sha256, /^[0-9a-f]{64}$/);
  assert.match(versionResult.provenance.source_commit, /^[0-9a-f]{40}$/);
  pass("version JSON reports real source and package-content provenance");

  const doctor = run(["doctor", "--json"]);
  assert.equal(doctor.status, 0, doctor.stderr);
  const doctorResult = JSON.parse(doctor.stdout);
  assert.equal(doctorResult.ok, true);
  assert.ok(["win32", "darwin", "linux"].includes(doctorResult.platform));
  assert.equal(doctorResult.checks.every(({ status }) => status !== "FAIL"), true);
  assert.ok(["PASS", "WARN"].includes(doctorResult.checks.find(({ name }) => name === "CLI on PATH").status));
  pass("doctor verifies Node, operating system, Git, runtime packages and CLI PATH");

  const modelValidate = run(["model", "validate", fixture("architecture.yaml")]);
  assert.equal(modelValidate.status, 0, modelValidate.stderr);
  assert.match(modelValidate.stdout, /SUMMARY: 4 components, 3 relationships/);

  const validateAlias = run(["validate", fixture("architecture.yaml")]);
  assert.equal(validateAlias.status, 0, validateAlias.stderr);
  pass("model validation namespace and compatibility alias");

  const validateDirectory = run(["model", "validate-dir", fixtures]);
  assert.equal(validateDirectory.status, 0, validateDirectory.stderr);
  assert.match(validateDirectory.stdout, /EXPECTED INVALID/);
  pass("model directory validation");

  const modelGraph = run(["model", "graph", fixture("architecture.yaml")]);
  assert.equal(modelGraph.status, 0, modelGraph.stderr);
  const modelGraphResult = JSON.parse(modelGraph.stdout);
  assert.equal(modelGraphResult.schema_version, "1.0.0");
  assert.equal(modelGraphResult.kind, "archsync.graph");
  assert.deepEqual(modelGraphResult.contracts, { architecture_model: "0.1.1", graph: "1.0.0" });
  assert.equal(modelGraphResult.edges.length, 3);

  const modelDiff = run([
    "model",
    "diff",
    fixture("architecture.yaml"),
    fixture("architecture.yaml"),
  ]);
  assert.equal(modelDiff.status, 0, modelDiff.stderr);
  const modelDiffResult = JSON.parse(modelDiff.stdout);
  assert.equal(modelDiffResult.schema_version, "1.0.0");
  assert.equal(modelDiffResult.kind, "archsync.graph-diff");
  assert.deepEqual(modelDiffResult.addedEdges, []);

  const modelCheck = run([
    "model",
    "check-json",
    fixture("architecture.yaml"),
    fixture("architecture.yaml"),
  ]);
  assert.equal(modelCheck.status, 0, modelCheck.stderr);
  const modelCheckResult = JSON.parse(modelCheck.stdout);
  assert.equal(modelCheckResult.schema_version, "1.0.0");
  assert.equal(modelCheckResult.kind, "archsync.conformance");
  assert.deepEqual(modelCheckResult.contracts, {
    expected_architecture_model: "0.1.1",
    observed_architecture_model: "0.1.1",
    conformance: "1.0.0",
    graph: "1.0.0",
    finding: "1.0.0",
    evidence: "1.0.0",
  });
  assert.equal(modelCheckResult.classification, "no-impact");
  pass("model graph, diff and conformance commands");

  for (const format of ["mermaid", "drawio"]) {
    const extension = format === "mermaid" ? "mmd" : "drawio";
    const output = join(temporary, `model.${extension}`);
    const rendered = run(["model", format, fixture("architecture.yaml"), output]);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok((await readFile(output, "utf8")).length > 100);
  }
  const modelReport = join(temporary, "model-report.mmd");
  const report = run([
    "model",
    "report",
    fixture("architecture.yaml"),
    fixture("architecture.yaml"),
    modelReport,
  ]);
  assert.equal(report.status, 0, report.stderr);
  assert.match(await readFile(modelReport, "utf8"), /NO-IMPACT/);
  pass("model Mermaid, draw.io and annotated reports");

  const modelBenchmark = run(["model", "benchmark", fixture("ground-truth.json")]);
  assert.equal(modelBenchmark.status, 0, modelBenchmark.stderr);
  assert.match(modelBenchmark.stdout, /VALID BENCHMARK \(3\/3 engine-evaluated/);
  pass("model benchmark validation");

  const benchmarkOutput = join(temporary, "phase2-benchmark.json");
  const sourceBenchmark = run(["benchmark", fixture("ground-truth.json"), benchmarkOutput]);
  assert.equal(sourceBenchmark.status, 0, sourceBenchmark.stderr);
  assert.match(sourceBenchmark.stdout, /VALID PHASE 2 BENCHMARK/);
  assert.equal(JSON.parse(await readFile(benchmarkOutput, "utf8")).valid, true);
  pass("source benchmark evaluation and JSON artifact");

  const scan = run(["scan", fixture("architecture.yaml"), fixture("baseline")]);
  assert.equal(scan.status, 0, scan.stderr);
  const observed = JSON.parse(scan.stdout);
  assert.equal(Object.keys(observed.components).length, 4);
  assert.equal(observed.relationships.length, 3);
  pass("scan emits observed graph JSON");

  const outputPath = join(temporary, "observed.json");
  const scanOutput = run(["scan", fixture("architecture.yaml"), fixture("baseline"), outputPath]);
  assert.equal(scanOutput.status, 0, scanOutput.stderr);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).metadata.scanned_files, 3);
  pass("scan writes observed graph JSON");

  const clean = run(["check", fixture("architecture.yaml"), fixture("baseline")]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /^NO-IMPACT \/ PASS/);
  pass("no-impact exits 0");

  const violation = run(["check", fixture("architecture.yaml"), fixture("violation")]);
  assert.equal(violation.status, 1);
  assert.match(violation.stdout, /\[ARCH-001\].+frontend\/src\/database\.ts:6/);
  pass("violation exits 1 with source evidence");

  const json = run(["check-json", fixture("architecture.yaml"), fixture("violation")]);
  assert.equal(json.status, 1);
  const result = JSON.parse(json.stdout);
  assert.equal(result.classification, "violation");
  assert.equal(result.findings.find((finding) => finding.rule_id === "ARCH-001").source_evidence[0].line, 6);
  pass("machine-readable finding contract");

  const jsonOption = run(["check", fixture("architecture.yaml"), fixture("violation"), "--json"]);
  assert.equal(jsonOption.status, 1);
  assert.equal(JSON.parse(jsonOption.stdout).decision, "BLOCK");
  pass("--json option matches check-json");

  const invalid = run(["check", fixture("invalid.architecture.yaml"), fixture("baseline")]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /INVALID ARCHITECTURE MODEL/);
  pass("invalid model exits 2");

  const usage = run([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage:/);
  pass("usage exits 2");

  const noImpactRepository = await gitFixture("phase3-no-impact");
  await mkdir(join(noImpactRepository, "service", "src"), { recursive: true });
  await writeFile(
    join(noImpactRepository, "service", "src", "internal.ts"),
    "export const normalize = (value) => value.trim();\n",
    "utf8",
  );
  const reportPath = join(temporary, "phase3-no-impact.md");
  const noImpactDiff = run([
    "check",
    fixture("architecture.yaml"),
    noImpactRepository,
    "--diff",
    ".",
    "--report",
    reportPath,
  ]);
  assert.equal(noImpactDiff.status, 0, noImpactDiff.stderr);
  assert.match(noImpactDiff.stdout, /^DECISION: PASS/);
  assert.match(await readFile(reportPath, "utf8"), /\*\*Decision: PASS\*\*/);
  pass("Git diff no-impact exits 0 and writes PR report");

  const violationRepository = await gitFixture("phase3-violation");
  await writeFile(
    join(violationRepository, "frontend", "src", "database.ts"),
    await readFile(fixture("violation", "frontend", "src", "database.ts"), "utf8"),
    "utf8",
  );
  const violationDiff = run([
    "check",
    fixture("architecture.yaml"),
    violationRepository,
    "--diff",
    ".",
    "--github",
  ]);
  assert.equal(violationDiff.status, 1);
  assert.match(violationDiff.stdout, /::error file=frontend\/src\/database\.ts/);
  assert.match(violationDiff.stdout, /DECISION: BLOCK/);
  pass("Git diff violation exits 1 with GitHub annotation");

  const evolutionRepository = await gitFixture("phase3-evolution");
  await writeFile(
    join(evolutionRepository, "service", "src", "cache.ts"),
    `import { createClient } from "redis";
const redis = createClient({ url: "redis://redis:6379" });
export async function cache() { await redis.set("a", "b"); }
`,
    "utf8",
  );
  const evolutionDiff = run([
    "check-json",
    fixture("architecture.yaml"),
    evolutionRepository,
    "--diff",
    ".",
  ]);
  assert.equal(evolutionDiff.status, 3);
  assert.equal(JSON.parse(evolutionDiff.stdout).decision, "REVIEW");
  pass("Git diff evolution exits 3 with machine-readable contract");

  const demoReport = join(temporary, "demo-report.md");
  const demo = run([
    "demo",
    "--benchmark",
    fixtures,
    "--scenario",
    "all",
    "--report",
    demoReport,
    "--json",
  ]);
  assert.equal(demo.status, 0, demo.stderr);
  const demoResult = JSON.parse(demo.stdout);
  assert.equal(demoResult.ok, true);
  assert.deepEqual(demoResult.cases.map(({ actual_decision }) => actual_decision), ["PASS", "BLOCK", "REVIEW"]);
  assert.equal(demoResult.cases.every(({ match }) => match), true);
  assert.match(await readFile(demoReport, "utf8"), /\| case-block \| BLOCK \| BLOCK \|/);
  pass("demo runs real PASS, BLOCK and REVIEW Git diffs without propagating expected nonzero exits");

  console.log(`PASS GUARDIAN CLI SMOKE (${passed.length}/${passed.length}: ${passed.join(", ")})`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
