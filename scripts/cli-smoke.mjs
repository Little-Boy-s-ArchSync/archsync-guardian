import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "bin.js");
const fixture = (...parts) => join(root, "test", "fixtures", ...parts);
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

  console.log(`PASS GUARDIAN CLI SMOKE (${passed.length}/${passed.length}: ${passed.join(", ")})`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
