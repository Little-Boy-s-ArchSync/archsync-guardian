import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// Reproducible engineering verification only. No D3/comparator/approval inputs.
const root = resolve(import.meta.dirname, "..");
const started = new Date().toISOString();
const output = join(root, ".artifacts/module-development", started.replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  "src/module-graph.ts", "src/module-graph.test.ts", "src/index.ts",
  "src/phase3-git.ts", "src/phase3-git.test.ts", "src/phase3-adversarial.test.ts", "src/phase3.ts",
  "scripts/module-preflight.mjs", "scripts/module-preflight.node-tests.mjs",
  "scripts/verify-module-development.mjs", "package.json", "pnpm-lock.yaml",
  "test/module-preflight/tsconfig.json", "test/module-preflight/src/app.ts",
  "test/module-preflight/src/pricing.ts",
];
const sourceHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, hash(await readFile(join(root, file)))])));
const commands = [
  ["build", ["node_modules/typescript/bin/tsc", "-b", "--pretty", "false"]],
  ["typecheck-tests", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.test.json", "--noEmit", "--pretty", "false"]],
  ["all-tests-coverage", ["node_modules/vitest/vitest.mjs", "run", "--coverage", "--reporter=default", "--reporter=json", `--outputFile=${join(output, "vitest.json")}`]],
  ["module-cli", ["--test", "scripts/module-preflight.node-tests.mjs"]],
  ["module-example", ["scripts/module-preflight.mjs", "test/module-preflight/tsconfig.json", "test/module-preflight"]],
  ["offline", ["scripts/verify-offline.mjs"]],
];
const results = [];
for (const [name, args] of commands) {
  const before = new Date().toISOString();
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  const stdout = run.stdout ?? "";
  const stderr = `${run.stderr ?? ""}${run.error ? `\n${run.error.message}\n` : ""}`;
  await writeFile(join(output, `${name}.stdout.txt`), stdout);
  await writeFile(join(output, `${name}.stderr.txt`), stderr);
  results.push({ name, executable: process.version, args, started_utc: before, finished_utc: new Date().toISOString(), exit_code: run.status, signal: run.signal, stdout_sha256: hash(stdout), stderr_sha256: hash(stderr) });
  console.log(`${run.status === 0 ? "PASS" : "FAIL"} ${name}`);
  if (run.status !== 0) console.error(stderr || stdout);
}
const afterHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, hash(await readFile(join(root, file)))])));
const sourcesUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(afterHashes);
const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
const status = spawnSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8", windowsHide: true });
const passed = results.every((result) => result.exit_code === 0) && sourcesUnchanged;
const receipt = {
  purpose: "development-verification-not-independent-evaluation", started_utc: started,
  finished_utc: new Date().toISOString(), node: process.version, os: process.platform, arch: process.arch,
  parent_commit: commit.status === 0 ? commit.stdout.trim() : null,
  worktree_status: status.status === 0 ? status.stdout : null,
  source_sha256: sourceHashes, sources_unchanged_during_run: sourcesUnchanged,
  commands: results, passed,
  boundaries: ["No external comparator executed", "No independent holdout or labels", "Coverage is an engineering measure, not research accuracy", "Platform skips remain visible in vitest.json"],
};
await writeFile(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`Receipt: ${join(output, "receipt.json")}`);
process.exitCode = passed ? 0 : 1;
