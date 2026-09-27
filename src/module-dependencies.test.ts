import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyzeModuleDependencies } from "./module-dependencies.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archsync-module-dev-"));
  roots.push(root);
  await mkdir(join(root, "src", "models"), { recursive: true });
  await mkdir(join(root, "src", "routers"), { recursive: true });
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  await writeFile(join(root, "src", "routers", "route.ts"), "export const route = 1;\nexport type Route = number;\n");
  await writeFile(join(root, "src", "models", "helper.ts"), "export const helper = 1;\n");
  await writeFile(join(root, "src", "misc.ts"), "export const misc = 1;\n");
  await writeFile(join(root, "src", "models", "model.ts"), [
    "import type { Route } from '../routers/route';",
    "import { type Route as AnotherType } from '../routers/route';",
    "import { route } from '@/routers/route';",
    "export { route as alternate } from '../routers/route';",
    "export type { Route } from '../routers/route';",
    "import '../routers/route';",
    "void import('../routers/route');",
    "require('../routers/route');",
    "void import('./missing');",
    "void import('/missing');",
    "void import('not-installed');",
    "import './types';",
    "import './helper';",
    "import '../misc';",
    "export const value = route;",
    "",
  ].join("\n"));
  await writeFile(join(root, "src", "models", "model.test.ts"), "import {route} from '../routers/route';\n");
  await writeFile(join(root, "src", "models", "generated.d.ts"), "import {route} from '../routers/route';\n");
  await writeFile(join(root, "src", "models", "types.d.ts"), "declare const value: number; export = value;\n");
  return root;
}

describe("development-only module dependency adapter", () => {
  it("resolves value imports, re-exports and literal calls while excluding type-only/test imports", async () => {
    const root = await fixture();
    const result = await analyzeModuleDependencies(root, [
      { component: "api-models", prefix: "src/models/" },
      { component: "api-routers", prefix: "src/routers/" },
    ]);
    expect(result.analyzer.version).toBe("0.1.0-development");
    expect(result.scanned_files).toBe(4);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ from: "api-models", to: "api-routers", type: "dependency" });
    expect(result.edges[0]?.evidence.map((item) => item.syntax)).toEqual(["import", "export", "import", "dynamic-import", "require"]);
    expect(result.edges[0]?.evidence.every((item) => item.target_file === "src/routers/route.ts")).toBe(true);
    expect(result.unresolved.map((item) => [item.specifier, item.reason])).toEqual([
      ["./missing", "unresolved-local-target"],
      ["/missing", "unresolved-local-target"],
      ["not-installed", "unresolved-package-or-alias"],
      ["./types", "resolved-outside-verified-tree"],
    ]);
  });

  it("rejects unsafe or duplicate mapping prefixes", async () => {
    const root = await fixture();
    await expect(analyzeModuleDependencies(root, [{ component: "api-models", prefix: "../outside/" }])).rejects.toThrow(/Unsafe module prefix/);
    await expect(analyzeModuleDependencies(root, [])).rejects.toThrow(/At least one module group/);
    await expect(analyzeModuleDependencies(root, [{ component: "Bad_ID", prefix: "src/models/" }])).rejects.toThrow(/Unsafe module group/);
    await expect(analyzeModuleDependencies(root, [
      { component: "api-models", prefix: "src/models/" },
      { component: "other", prefix: "src/models/" },
    ])).rejects.toThrow(/Duplicate module prefix/);
    await analyzeModuleDependencies(root, [
      { component: "alpha", prefix: "src/alpha/" },
      { component: "bravo", prefix: "src/bravo/" },
    ]);
  });

  it("fails closed for malformed configs and does not require a tsconfig for relative imports", async () => {
    const root = await fixture();
    const mapping = [{ component: "api-models", prefix: "src/models/" }, { component: "api-routers", prefix: "src/routers/" }];
    await rm(join(root, "tsconfig.json"));
    expect((await analyzeModuleDependencies(root, mapping)).edges).toHaveLength(1);
    await writeFile(join(root, "tsconfig.json"), "{ invalid json");
    await expect(analyzeModuleDependencies(root, mapping)).rejects.toThrow(/Cannot read TypeScript configuration/);
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "not-a-resolution" } }));
    await expect(analyzeModuleDependencies(root, mapping)).rejects.toThrow(/Invalid TypeScript configuration/);
  });

  it("does not treat lexically shadowed require calls as CommonJS dependencies", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "models", "shadowed-const.ts"), [
      "const require = (value: string) => value;",
      "require('../routers/route');",
      "export {};",
    ].join("\n"));
    await writeFile(join(root, "src", "models", "shadowed-parameter.ts"), [
      "export function parameter(require: (value: string) => string) { require('../routers/route'); }",
    ].join("\n"));
    await writeFile(join(root, "src", "models", "shadowed-function.ts"), [
      "function require(value: string) { return value; }",
      "require('../routers/route');",
      "export {};",
    ].join("\n"));
    await writeFile(join(root, "src", "models", "shadowed-block.ts"), [
      "{ const require = (value: string) => value; require('../routers/route'); }",
      "export {};",
    ].join("\n"));
    const result = await analyzeModuleDependencies(root, [
      { component: "api-models", prefix: "src/models/" },
      { component: "api-routers", prefix: "src/routers/" },
    ]);
    expect(result.edges[0]?.evidence.filter((item) => item.file.includes("shadowed-"))).toEqual([]);
  });

  it("retains empty ESM clauses when verbatim module syntax preserves their side effects", async () => {
    const root = await fixture();
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "ESNext", moduleResolution: "Bundler", verbatimModuleSyntax: true,
    } }));
    await writeFile(join(root, "src", "models", "empty.ts"), [
      "import {} from '../routers/route';",
      "export {} from '../routers/route';",
      "import { type Route } from '../routers/route';",
      "export { type Route } from '../routers/route';",
      "import type {} from '../routers/route';",
      "export type {} from '../routers/route';",
      "",
    ].join("\n"));
    const result = await analyzeModuleDependencies(root, [
      { component: "api-models", prefix: "src/models/" },
      { component: "api-routers", prefix: "src/routers/" },
    ]);
    expect(result.edges[0]?.evidence.filter((item) => item.file === "src/models/empty.ts").map((item) => item.syntax)).toEqual([
      "import", "export", "import", "export",
    ]);
  });

  it("accepts an unbound CommonJS require and compares BOM-stripped program text", async () => {
    const root = await fixture();
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", types: [],
    } }));
    await writeFile(join(root, "src", "models", "bom.ts"), "\uFEFFrequire('../routers/route');\n");
    const result = await analyzeModuleDependencies(root, [
      { component: "api-models", prefix: "src/models/" },
      { component: "api-routers", prefix: "src/routers/" },
    ]);
    expect(result.edges[0]?.evidence.filter((item) => item.file === "src/models/bom.ts").map((item) => item.syntax)).toEqual([
      "require",
    ]);
  });
});
