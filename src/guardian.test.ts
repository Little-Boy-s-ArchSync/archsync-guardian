import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkRepository, evaluateObservedArchitecture, formatGuardianResult } from "./guardian.js";
import { baselineSources, testArchitecture, writeSources } from "./test-helpers.js";

let repository: string;

beforeEach(async () => {
  repository = await mkdtemp(join(tmpdir(), "archsync-guardian-test-"));
});

afterEach(async () => {
  await rm(repository, { recursive: true, force: true });
});

describe("Guardian orchestration", () => {
  it("passes an observed repository that conforms to the expected graph", async () => {
    await writeSources(repository, baselineSources);

    const result = await checkRepository(testArchitecture(), repository);

    expect(result.classification).toBe("no-impact");
    expect(result.decision).toBe("PASS");
    expect(result.findings).toEqual([]);
    expect(formatGuardianResult(result)).toContain("NO-IMPACT / PASS");
  });

  it("blocks a deny-rule violation with exact source evidence", async () => {
    await writeSources(repository, {
      ...baselineSources,
      "frontend/src/database.ts": `import { Client } from "pg";
const database = new Client({ connectionString: process.env.DATABASE_URL });
export async function load(): Promise<void> {
  await database.query("select 1");
}
`,
    });

    const result = await checkRepository(testArchitecture(), repository);
    const finding = result.findings.find(({ rule_id }) => rule_id === "ARCH-001");

    expect(result.classification).toBe("violation");
    expect(result.decision).toBe("BLOCK");
    expect(finding).toMatchObject({
      severity: "critical",
      edge: { key: "frontend|data|postgres" },
      source_evidence: [{ file: "frontend/src/database.ts", line: 4 }],
    });
    expect(formatGuardianResult(result)).toContain("frontend/src/database.ts:4");
  });

  it("deduplicates and sorts multiple source locations for the same forbidden edge", async () => {
    const databaseSource = (functionName: string) => `import { Client } from "pg";
const database = new Client({ connectionString: process.env.DATABASE_URL });
export async function ${functionName}(): Promise<void> {
  await database.query("select 1");
}
`;
    await writeSources(repository, {
      ...baselineSources,
      "frontend/src/z-database.ts": databaseSource("loadZ"),
      "frontend/src/a-database.ts": databaseSource("loadA"),
    });

    const result = await checkRepository(testArchitecture(), repository);
    const finding = result.findings.find(({ rule_id }) => rule_id === "ARCH-001");

    expect(finding?.source_evidence.map(({ file }) => file)).toEqual([
      "frontend/src/a-database.ts",
      "frontend/src/z-database.ts",
    ]);
  });

  it("anchors a missing required edge to the source component", async () => {
    const { "gateway/src/server.ts": _removed, ...withoutGatewayCall } = baselineSources;
    await writeSources(repository, {
      ...withoutGatewayCall,
      "gateway/src/server.ts": `export async function forward(): Promise<void> {
  console.info("no service call");
}
`,
      "gateway/src/index.ts": "export const gatewayIndex = true;\n",
      "gateway/src/helper.ts": "export const gatewayHelper = true;\n",
      "gateway/src/app.ts": "export const gatewayApp = true;\n",
    });

    const result = await checkRepository(testArchitecture(), repository);
    const finding = result.findings.find(({ rule_id }) => rule_id === "ARCH-002");

    expect(finding?.source_evidence).toEqual([
      expect.objectContaining({ file: "gateway/src/app.ts", line: 1, detector: "component-root" }),
    ]);
    expect(finding?.model_evidence).toEqual({ document: "expected", path: "/rules/1" });
  });

  it("does not fabricate an edge type for an untyped required-edge finding", async () => {
    const expected = testArchitecture();
    expected.rules = [
      { id: "ARCH-UNTYPED", type: "require", from: "gateway", to: "service", severity: "error" },
    ];
    const { "gateway/src/server.ts": _removed, ...withoutGatewayCall } = baselineSources;
    await writeSources(repository, {
      ...withoutGatewayCall,
      "gateway/src/server.ts": "export const gateway = true;\n",
    });

    const result = await checkRepository(expected, repository);

    const finding = result.findings.find(({ rule_id }) => rule_id === "ARCH-UNTYPED");

    expect(finding).toMatchObject({
      source_evidence: [
        expect.objectContaining({ file: "gateway/src/server.ts", detector: "component-root" }),
      ],
      model_evidence: { document: "expected", path: "/rules/0" },
    });
    expect(finding).not.toHaveProperty("edge");
  });

  it("blocks an allowlist violation with the disallowed call site", async () => {
    const expected = testArchitecture();
    expected.rules = [
      { id: "ALLOW-001", type: "allow", from: "frontend", to: "gateway", relationship_type: "http", severity: "error" },
    ];
    await writeSources(repository, {
      ...baselineSources,
      "frontend/src/direct.ts": `export async function bypass(): Promise<void> {
  await fetch("http://service:3001/internal");
}
`,
    });

    const result = await checkRepository(expected, repository);
    const finding = result.findings.find(({ rule_id }) => rule_id === "ALLOW-001");

    expect(result.decision).toBe("BLOCK");
    expect(finding).toMatchObject({
      kind: "allow-rule",
      edge: { key: "frontend|http|service" },
      source_evidence: [{ file: "frontend/src/direct.ts", line: 2 }],
    });
  });

  it("checks a multi-hop required path and anchors a break to its source", async () => {
    const expected = testArchitecture();
    expected.rules = [
      { id: "PATH-001", type: "require-path", from: "frontend", to: "postgres", severity: "critical" },
    ];
    await writeSources(repository, baselineSources);
    const passing = await checkRepository(expected, repository);
    const { "gateway/src/server.ts": _removed, ...withoutGatewayCall } = baselineSources;
    await writeSources(repository, {
      ...withoutGatewayCall,
      "gateway/src/server.ts": `export async function forward(): Promise<void> {
  console.info("no service call");
}
`,
    });

    const failing = await checkRepository(expected, repository);
    const finding = failing.findings.find(({ rule_id }) => rule_id === "PATH-001");

    expect(passing.classification).toBe("no-impact");
    expect(finding).toMatchObject({
      kind: "required-path",
      source_evidence: [{ file: "frontend/src/app.ts", detector: "component-root" }],
      model_evidence: { document: "expected", path: "/rules/0" },
    });
  });

  it("reviews an unruled Redis evolution", async () => {
    await writeSources(repository, {
      ...baselineSources,
      "service/src/cache.ts": `import { createClient } from "redis";
const redis = createClient({ url: "redis://redis:6379" });
export async function cache(): Promise<void> { await redis.set("a", "b"); }
`,
    });

    const result = await checkRepository(testArchitecture(), repository);

    expect(result.classification).toBe("evolution");
    expect(result.decision).toBe("REVIEW");
    expect(result.diff.added_nodes).toEqual(["redis"]);
    expect(result.diff.added_edges).toEqual(["service|data|redis"]);
    expect(result.findings.some(({ source_evidence }) => source_evidence.some(({ file }) => file.endsWith("cache.ts")))).toBe(true);
  });

  it("preserves model evidence when source evidence is unavailable", () => {
    const expected = testArchitecture();
    const observed = {
      version: "0.1" as const,
      analyzer: { id: "archsync-typescript" as const, version: "0.2" as const, stack: "typescript-node" as const },
      metadata: { name: "empty", scanned_files: 0 },
      components: {},
      relationships: [],
    };

    const result = evaluateObservedArchitecture(expected, observed);

    expect(result.classification).toBe("evolution");
    expect(result.findings.some(({ source_evidence }) => source_evidence.length === 0)).toBe(true);
    expect(formatGuardianResult(result)).toContain("expected:/components/frontend");
  });
});
