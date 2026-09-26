import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeTypeScriptRepository } from "./analyzer.js";
import { evaluateObservedArchitecture } from "./guardian.js";
import { checkRepositoryDiff, mergeIncrementalObservedArchitecture } from "./phase3.js";
import { baselineSources, testArchitecture, writeSources } from "./test-helpers.js";

const exec = promisify(execFile);
let root: string;
const bypass = 'import { Client } from "pg";\nconst db = new Client({connectionString:"postgres://postgres:5432/app"});\nexport async function bypass() { await db.query("select 1"); }\n';
async function git(...args: string[]) { await exec("git", ["-C", root, ...args]); }
async function baseline(sources = baselineSources) {
  await writeSources(root, sources);
  await git("init", "-b", "main");
  await git("config", "user.email", "validity@archsync.invalid");
  await git("config", "user.name", "Validity test");
  await git("add", ".");
  await git("commit", "-m", "baseline");
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "archsync-incremental-adversarial-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("incremental validity against full scans", () => {
  it("includes ignored untracked TypeScript that the full analyzer reads", async () => {
    await baseline({...baselineSources, ".gitignore":"frontend/src/local/\n"});
    await writeSources(root, {"frontend/src/local/direct.ts":bypass});
    const result = await checkRepositoryDiff(testArchitecture(), root);
    const full = evaluateObservedArchitecture(testArchitecture(), await analyzeTypeScriptRepository(root, testArchitecture()));
    expect(full.decision).toBe("BLOCK");
    expect(result.head.decision).toBe(full.decision);
    expect(result.decision).toBe("BLOCK");
    expect(result.repository.worktree_dirty).toBe(true);
  });

  it.each(["add", "modify", "delete", "rename-within", "rename-across", "delete-component"])("matches a fresh full scan after %s, with cold and warm caches", async (mutation) => {
    await baseline({...baselineSources, "frontend/src/direct.ts": bypass});
    if (mutation === "add") await writeSources(root, {"gateway/src/extra.ts": bypass});
    if (mutation === "modify") await writeFile(join(root, "frontend/src/direct.ts"), 'export const fixed = true;\n');
    if (mutation === "delete") await unlink(join(root, "frontend/src/direct.ts"));
    if (mutation === "rename-within") await rename(join(root, "frontend/src/direct.ts"), join(root, "frontend/src/renamed.ts"));
    if (mutation === "rename-across") await rename(join(root, "frontend/src/direct.ts"), join(root, "gateway/src/direct.ts"));
    if (mutation === "delete-component") await rm(join(root, "frontend"), {recursive:true});
    const full = await analyzeTypeScriptRepository(root, testArchitecture());
    const expected = evaluateObservedArchitecture(testArchitecture(), full);
    const cold = await checkRepositoryDiff(testArchitecture(), root);
    const warm = await checkRepositoryDiff(testArchitecture(), root);
    for (const result of [cold, warm]) {
      expect(result.head).toEqual({decision:expected.decision, classification:expected.classification, findings:expected.findings.length});
      expect(result.analysis.head_scanned_files).toBe(full.metadata.scanned_files);
    }
    expect(cold.cache.hit).toBe(false);
    expect(warm.cache.hit).toBe(true);
    expect(warm.architecture_delta).toEqual(cold.architecture_delta);
    expect(warm.introduced_findings).toEqual(cold.introduced_findings);
    expect(warm.resolved_findings).toEqual(cold.resolved_findings);
  });

  it("publishes concurrent cold cache writes without temporary-file collisions", async () => {
    await baseline();
    const results = await Promise.all(Array.from({length:4}, () => checkRepositoryDiff(testArchitecture(), root)));
    expect(results.every((result) => result.head.decision === "PASS")).toBe(true);
    expect((await checkRepositoryDiff(testArchitecture(), root)).cache.hit).toBe(true);
  });

  it("invalidates the baseline when architecture rules change", async () => {
    await baseline({...baselineSources, "frontend/src/direct.ts":bypass});
    const original = await checkRepositoryDiff(testArchitecture(), root);
    const changed = testArchitecture();
    changed.rules = changed.rules!.filter((rule) => rule.id !== "ARCH-001");
    const result = await checkRepositoryDiff(changed, root);
    expect(result.cache.hit).toBe(false);
    expect(result.cache.key).not.toBe(original.cache.key);
    expect(result.baseline.decision).toBe("REVIEW");
  });

  it.each(["café.ts", "tab\tfile.ts", "line\nfile.ts"])("detects an untracked violation with literal filename %j", async (name) => {
    await baseline();
    await writeFile(join(root, "frontend/src", name), bypass);
    const result = await checkRepositoryDiff(testArchitecture(), root);
    expect(result.decision).toBe("BLOCK");
    expect(result.changed_files).toContainEqual(expect.objectContaining({ path: `frontend/src/${name}` }));
    expect(result.head.decision).toBe(evaluateObservedArchitecture(testArchitecture(), await analyzeTypeScriptRepository(root, testArchitecture())).decision);
  });

  it.each(["café.ts", "tab\tfile.ts", "line\nfile.ts"])("detects a tracked violation with literal filename %j", async (name) => {
    await baseline({ ...baselineSources, [`frontend/src/${name}`]: "export const before = 1;\n" });
    await writeFile(join(root, "frontend/src", name), bypass);
    const result = await checkRepositoryDiff(testArchitecture(), root);
    expect(result.decision).toBe("BLOCK");
    expect(result.changed_files).toContainEqual(expect.objectContaining({ path: `frontend/src/${name}`, additions: 3, deletions: 1, changed_lines: [{start: 1, end: 3}] }));
  });

  it("isolates baseline caches between subprojects sharing the same Git commit and model", async () => {
    const sources = Object.fromEntries(Object.entries(baselineSources).flatMap(([path, source]) => [[`a/${path}`, source], [`b/${path}`, source]]));
    sources["a/frontend/src/direct.ts"] = bypass;
    await baseline(sources);
    const a = await checkRepositoryDiff(testArchitecture(), join(root, "a"));
    const b = await checkRepositoryDiff(testArchitecture(), join(root, "b"));
    expect(a.baseline.decision).toBe("BLOCK");
    expect(b.baseline.decision).toBe("PASS");
    expect(b.cache.key).not.toBe(a.cache.key);
  });

  it("rebuilds a valid-JSON cache whose observed graph is corrupted", async () => {
    await baseline();
    const first = await checkRepositoryDiff(testArchitecture(), root);
    const path = join(root, ".git/archsync-cache", `${first.cache.key}.json`);
    const envelope = JSON.parse(await readFile(path, "utf8"));
    envelope.observed.relationships = null;
    await writeFile(path, JSON.stringify(envelope));
    const rebuilt = await checkRepositoryDiff(testArchitecture(), root);
    expect(rebuilt.cache.hit).toBe(false);
    expect(rebuilt.head.decision).toBe("PASS");
  });

  it("preserves evidence from a nested component when only its parent component changes", async () => {
    const expected = testArchitecture();
    expected.components["service/nested"] = {type:"service", layer:"domain"};
    await baseline({ ...baselineSources, "service/nested/main.ts": 'export async function nested() { await fetch("http://gateway:3000"); }\n' });
    const before = await analyzeTypeScriptRepository(root, expected);
    await writeFile(join(root, "service/src/service.ts"), `${baselineSources["service/src/service.ts"]}\nexport const internal = 1;\n`);
    const partial = await analyzeTypeScriptRepository(root, expected, {component_ids:["service"]});
    const merged = mergeIncrementalObservedArchitecture(before, partial, ["service"]);
    const full = await analyzeTypeScriptRepository(root, expected);
    expect(merged).toEqual(full);
  });
});
