import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

  console.log(`PASS GUARDIAN CLI SMOKE (${passed.length}/${passed.length}: ${passed.join(", ")})`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
