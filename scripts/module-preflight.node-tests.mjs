import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = join(root, "scripts/module-preflight.mjs");
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

test("built CLI returns a scoped graph and a Core-schema-validated model", async () => {
  const result = run("test/module-preflight/tsconfig.json", "test/module-preflight");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.purpose, "development-preflight-not-independent-evaluation");
  assert.equal(output.graph.status, "complete-within-scope");
  assert.deepEqual(output.graph.edges.map(({ from, to }) => [from, to]), [["src/app.ts", "src/pricing.ts"]]);
  assert.equal(output.graph.modules.length, 2);
  const { parseArchitecture } = await import("@archsync/core");
  assert.equal((await parseArchitecture(JSON.stringify(output.architecture))).valid, true);
});

test("built CLI preserves incomplete accounting with no architecture/PASS output", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "archsync-module-cli-development-"));
  try {
    await writeFile(join(temporary, "tsconfig.json"), '{"files":["a.ts"],"compilerOptions":{"noLib":true}}');
    await writeFile(join(temporary, "a.ts"), 'import "./missing";');
    const result = run(join(temporary, "tsconfig.json"));
    assert.equal(result.status, 2, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.graph.status, "incomplete");
    assert.equal(output.graph.issues[0].code, "unresolved-module");
    assert.equal(output.architecture, null);
    assert.equal(result.stdout.includes('"PASS"'), false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("built CLI rejects missing/extra arguments and invalid configuration", () => {
  for (const args of [[], ["a", "b", "c"], ["does-not-exist.json"]]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.notEqual(result.stderr, "");
  }
});
