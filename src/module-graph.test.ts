import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { analyzeConformance, parseArchitecture } from "@archsync/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import ts from "typescript";

import { analyzeModuleProject, moduleArchitecture, moduleDiagnosticLocation, moduleId } from "./module-graph.js";
import { writeSources } from "./test-helpers.js";

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(sources: Record<string, string>, options: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "archsync-module-development-"));
  temporary.push(root);
  await writeSources(root, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", noLib: true }, include: ["src/**/*"], ...options }),
    ...sources,
  });
  return { root, config: join(root, "tsconfig.json") };
}

describe("separate static ESM module adapter (development fixtures, not D3)", () => {
  it("emits path identities and deduplicated edges with all source locations", async () => {
    const { config, root } = await project({
      "src/a.ts": 'import { b } from "./b";\nexport { b } from "./b";\nimport "./b";\nexport const a = b;',
      "src/b.ts": "export const b = 1;",
      "src/isolated.ts": "export {};",
    });
    const graph = analyzeModuleProject(config);
    expect(graph.status).toBe("complete-within-scope");
    expect(graph.modules.map((module) => module.file)).toEqual(["src/a.ts", "src/b.ts", "src/isolated.ts"]);
    expect(graph.edges).toEqual([{
      from: "src/a.ts", to: "src/b.ts", evidence: [
        { file: "src/a.ts", line: 1, column: 19, specifier: "./b", syntax: "import", type_only: false },
        { file: "src/a.ts", line: 2, column: 19, specifier: "./b", syntax: "export", type_only: false },
        { file: "src/a.ts", line: 3, column: 8, specifier: "./b", syntax: "import", type_only: false },
      ],
    }]);
    const bytes = await readFile(join(root, "src/a.ts"));
    expect(graph.modules[0]!.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(analyzeModuleProject(config, root)).toEqual(graph);
    expect((await parseArchitecture(JSON.stringify(moduleArchitecture(graph)))).valid).toBe(true);
    expect(graph.inputs.some((input) => input.file === "tsconfig.json")).toBe(true);
  });

  it("keeps syntax-level type imports/exports distinct without claiming runtime use", async () => {
    const { config } = await project({
      "src/a.ts": [
        'import type Default from "./b";', 'import type { T } from "./b";',
        'import { type T as A } from "./b";', 'import { type T as B, b } from "./b";',
        'import DefaultValue, { type T as C } from "./b";', 'import * as ns from "./b";',
        'import {} from "./b";', 'export type { T } from "./b";',
        'export { type T } from "./b";', 'export { type T, b } from "./b";',
        'export * from "./b";', 'export {} from "./b";', 'export { b };',
      ].join("\n"),
      "src/b.ts": "export interface T {}\nexport const b = 1;\nexport default b;",
    });
    const graph = analyzeModuleProject(config);
    expect(graph.issues).toEqual([]);
    expect(graph.edges[0]!.evidence.map((value) => value.type_only)).toEqual([true, true, true, false, false, false, false, true, true, false, false, false]);
  });

  it("resolves configured aliases, directory indexes, Unicode, TSX and .js substitution", async () => {
    const { config } = await project({
      "tsconfig.base.json": JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "Bundler", target: "ES2022", noLib: true, jsx: "preserve", baseUrl: ".", paths: { "@domain/*": ["src/domain/*"] } } }),
      "src/ui.tsx": 'import { v } from "@domain/đơn hàng";\nimport "./domain/index.js";\nexport const UI = <p>{v}</p>;',
      "src/domain/đơn hàng/index.ts": "export const v = 1;",
      "src/domain/index.ts": "export {};",
    }, { compilerOptions: {}, extends: "./tsconfig.base.json" });
    const graph = analyzeModuleProject(config);
    expect(graph.status).toBe("complete-within-scope");
    expect(graph.edges.map(({ from, to }) => [from, to])).toEqual([
      ["src/ui.tsx", "src/domain/đơn hàng/index.ts"], ["src/ui.tsx", "src/domain/index.ts"],
    ]);
    expect(graph.inputs.some((input) => input.file === "tsconfig.base.json")).toBe(true);
  });

  it("uses NodeNext resolution mode with package import/export conditions", async () => {
    const { config } = await project({
      "package.json": JSON.stringify({ type: "module", imports: { "#local": "./src/b.ts" } }),
      "src/a.mts": 'import { b } from "#local";\nexport { b };',
      "src/b.ts": "export const b = 1;",
    }, { compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noLib: true } });
    const graph = analyzeModuleProject(config);
    expect(graph.status).toBe("complete-within-scope");
    expect(graph.edges.map((edge) => edge.to)).toEqual(["src/b.ts"]);
    expect(graph.inputs.some((input) => input.file === "package.json")).toBe(true);
  });

  it("accounts for builtins, installed packages and local declarations as exclusions", async () => {
    const { config } = await project({
      "src/a.ts": 'import "node:fs";\nimport "fs";\nimport { ext } from "external";\nimport type { T } from "./types";\nimport "./b";',
      "src/types.d.ts": "export interface T {}",
      "src/b.ts": "export {};",
      "node_modules/external/package.json": '{"name":"external","types":"index.d.ts"}',
      "node_modules/external/index.d.ts": "export const ext: number;",
    });
    const graph = analyzeModuleProject(config);
    expect(graph.status).toBe("complete-within-scope");
    expect(graph.exclusions.map((item) => item.reason)).toEqual(["builtin", "builtin", "external-package", "declaration-only"]);
    expect(graph.modules).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
  });

  it.each([
    ['import "./missing";', "unresolved-module"],
    ['import "missing-package";', "unresolved-module"],
    ['const promise = import("./b");', "unsupported-dynamic-import"],
    ['const name = "./b"; import(name);', "unsupported-dynamic-import"],
    ['const b = require("./b");', "unsupported-commonjs"],
    ['function require(x: string) { return x; } require("not-a-module");', "unsupported-commonjs"],
    ['import b = require("./b");', "unsupported-commonjs"],
    ['type T = import("./b").T;', "unsupported-import-type"],
    ['export const = ;', "syntax-error"],
  ])("does not turn unsupported/unresolved source into a clean observation: %s", async (text, code) => {
    const { config } = await project({ "src/a.ts": text, "src/b.ts": "export interface T {}" });
    const graph = analyzeModuleProject(config);
    expect(graph.status).toBe("incomplete");
    expect(graph.issues.some((issue) => issue.code === code)).toBe(true);
    expect(() => moduleArchitecture(graph)).toThrow("Incomplete");
    expect(() => moduleArchitecture({ ...graph, status: "complete-within-scope" })).toThrow("Incomplete");
  });

  it("retains resolved targets outside configured scope as issues instead of dropping them", async () => {
    const { config } = await project({ "src/a.ts": 'import "../other/b";', "other/b.ts": "export {};" });
    const graph = analyzeModuleProject(config);
    expect(graph.issues.map((issue) => issue.code)).toEqual(["target-outside-scope"]);
  });

  it("keeps a circular graph and a self import without collapsing direction", async () => {
    const { config } = await project({ "src/a.ts": 'import "./b"; import "./a";', "src/b.ts": 'import "./a";' });
    const graph = analyzeModuleProject(config);
    expect(graph.edges.map(({ from, to }) => [from, to])).toEqual([["src/a.ts", "src/b.ts"], ["src/a.ts", "src/a.ts"], ["src/b.ts", "src/a.ts"]]);
  });

  it("runs Core deny/require conformance on module units without service-edge remapping", async () => {
    const { root, config } = await project({ "src/a.ts": 'import "./b";', "src/b.ts": "export {};" });
    const baseline = moduleArchitecture(analyzeModuleProject(config));
    expect(analyzeConformance(baseline, baseline).classification).toBe("no-impact");
    const forbidden = { ...baseline, rules: [{ id: "NO-A-TO-B", type: "deny" as const, from: moduleId("src/a.ts"), to: moduleId("src/b.ts"), relationship_type: "dependency" as const, severity: "error" as const }] };
    expect(analyzeConformance(forbidden, baseline).findings.some((finding) => finding.kind === "deny-rule")).toBe(true);
    await writeFile(join(root, "src/a.ts"), "export {};", "utf8");
    const observed = moduleArchitecture(analyzeModuleProject(config));
    const required = { ...baseline, rules: [{ ...forbidden.rules[0]!, id: "REQUIRE-A-TO-B", type: "require" as const }] };
    expect(analyzeConformance(required, observed).findings.some((finding) => finding.kind === "required-edge")).toBe(true);
    expect(baseline.relationships[0]!.type).toBe("dependency");
  });

  it("rejects invalid/missing configs rather than returning a zero-edge success", async () => {
    const { root, config } = await project({ "src/a.ts": "export {};" });
    expect(() => analyzeModuleProject(join(root, "missing.json"))).toThrow();
    expect(() => analyzeModuleProject(root, root)).toThrow("Invalid module tsconfig");
    await writeFile(config, "{broken", "utf8");
    expect(() => analyzeModuleProject(config)).toThrow("Invalid module tsconfig");
    await writeFile(config, JSON.stringify({ extends: "./missing.json", files: ["src/a.ts"] }), "utf8");
    expect(() => analyzeModuleProject(config)).toThrow("Invalid module tsconfig");
  });

  it("rejects a config outside the declared repository", async () => {
    const { root } = await project({ "src/a.ts": "export {};" });
    const other = await project({ "src/a.ts": "export {};" });
    expect(() => analyzeModuleProject(other.config, root)).toThrow("inside repositoryRoot");
  });

  it("does not treat solution configs/referenced projects as fully scanned", async () => {
    const { config } = await project({ "src/a.ts": "export {};", "nested/tsconfig.json": '{"files":[]}' }, { references: [{ path: "./nested" }] });
    const graph = analyzeModuleProject(config);
    expect(graph.issues.map((issue) => issue.code)).toEqual(["project-references"]);
  });

  it("does not accept declarations-only and JavaScript-only projects as empty successes", async () => {
    const declarations = await project({ "src/a.d.ts": "export interface T {}" });
    expect(analyzeModuleProject(declarations.config).issues.map((issue) => issue.code)).toEqual(["empty-scope"]);
    const javascript = await project({ "src/a.js": "export {};" }, { compilerOptions: { allowJs: true } });
    expect(analyzeModuleProject(javascript.config).issues.map((issue) => issue.code)).toEqual(["unsupported-source", "empty-scope"]);
  });

  it("does not include a source file escaping the repository through config files", async () => {
    const other = await project({ "src/a.ts": "export {};" });
    const { config } = await project({}, { files: [join(other.root, "src/a.ts")], include: [] });
    const graph = analyzeModuleProject(config);
    expect(graph.issues.map((issue) => issue.code)).toEqual(["unsupported-source", "empty-scope"]);
  });

  it("records byte hashes, including BOM, rather than hashes of normalized source text", async () => {
    const { root, config } = await project({ "src/a.ts": "\ufeffexport {};\r\n" });
    const expected = createHash("sha256").update(await readFile(join(root, "src/a.ts"))).digest("hex");
    expect(analyzeModuleProject(config).modules[0]!.sha256).toBe(expected);
  });

  it("does not lose distinct punctuation/case-sensitive path identities", () => {
    expect(moduleId("src/a-b.ts")).not.toBe(moduleId("src/a_b.ts"));
    expect(moduleId("src/A.ts")).not.toBe(moduleId("src/a.ts"));
  });

  it("anchors diagnostics without an offset at the beginning of the source", () => {
    const source = ts.createSourceFile("a.ts", "export {};", ts.ScriptTarget.Latest);
    expect(moduleDiagnosticLocation(source, "a.ts", { start: undefined })).toEqual({ file: "a.ts", line: 1, column: 1 });
  });

  it("fails closed when an I/O fault prevents reading a selected source", async () => {
    const { config } = await project({ "src/a.ts": "export {};" });
    const original = ts.sys.readFile;
    vi.spyOn(ts.sys, "readFile").mockImplementation((file, encoding) => file.replaceAll("\\", "/").endsWith("/src/a.ts") ? undefined : original(file, encoding));
    const graph = analyzeModuleProject(config);
    expect(graph.status).toBe("incomplete");
    expect(graph.issues.map((issue) => issue.code)).toEqual(["unreadable-source"]);
    expect(() => moduleArchitecture(graph)).toThrow("Incomplete");
  });

  it("reports duplicate real-file source aliases instead of double-counting units", async () => {
    const { root, config } = await project({ "src/original/a.ts": "export {};" });
    // Directory junctions work on Windows without symlink privilege.
    await symlink(join(root, "src/original"), join(root, "src/alias"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(config, JSON.stringify({ files: ["src/original/a.ts", "src/alias/a.ts"], compilerOptions: { noLib: true } }), "utf8");
    const graph = analyzeModuleProject(config);
    expect(graph.issues.map((issue) => issue.code)).toEqual(["source-alias"]);
    expect(graph.modules).toHaveLength(1);
  });

  it("preserves source identities and evidence through a repository-directory alias", async () => {
    const { root, config } = await project({ "src/a.ts": 'import "./b";', "src/b.ts": "export {};" });
    const holder = await project({ "src/unrelated.ts": "export {};" });
    const alias = join(holder.root, "linked-repository");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const original = analyzeModuleProject(config);
    const aliased = analyzeModuleProject(join(alias, "tsconfig.json"), alias);
    expect(aliased).toEqual(original);
    expect(aliased.modules.map((module) => module.file)).toEqual(["src/a.ts", "src/b.ts"]);
    // Compiler-resolution inputs can legitimately include external packages.
    // The declared repository's own sources/config must keep internal names.
    expect(aliased.inputs.some((input) => input.file === "tsconfig.json")).toBe(true);
    for (const module of aliased.modules) {
      expect(aliased.inputs).toContainEqual({ file: module.file, sha256: module.sha256 });
    }
    expect(aliased.edges[0]!.evidence[0]!.file).toBe("src/a.ts");
    expect(analyzeModuleProject(join(alias, "tsconfig.json"))).toEqual(original);
    expect(analyzeModuleProject(config, alias)).toEqual(original);
  });
});
