import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("Phase 5 preparatory governance", () => {
  it("keeps ADR acceptance and both human approvals explicitly pending", async () => {
    const adr = await readFile(
      join(root, "docs", "adr", "0005-phase-5-infrastructure-evidence-boundary.md"),
      "utf8",
    );

    expect(adr).toContain("**Proposed — not approved.**");
    expect(adr).toContain("| Phase 5 Lead | Pending | — | — | — |");
    expect(adr).toContain("| Security reviewer | Pending | — | — | — |");
    expect(adr).toContain("does not claim that P4-120");
    expect(adr).not.toMatch(/^## Status\s+\n+Accepted/m);
  });

  it("maps every P5-101 through P5-108 artifact and preserves the non-claims", async () => {
    const phase = await readFile(join(root, "docs", "phase-5.md"), "utf8");

    for (let item = 101; item <= 108; item += 1) {
      expect(phase).toContain(`P5-${item}`);
    }
    expect(phase).toMatch(/do not claim P4-120 approval/);
    expect(phase).toContain("does not run Terraform");
    expect(phase).toContain("does not add a Phase 5 CLI");
  });

  it("publishes the exact normalized graph v0.1 machine-readable shape", async () => {
    const schema = JSON.parse(
      await readFile(
        join(root, "docs", "schemas", "infrastructure-graph-v0.1.schema.json"),
        "utf8",
      ),
    ) as {
      $id: string;
      required: string[];
      properties: { version: { const: string } };
      $defs: { edge: { required: string[] }; evidence: { required: string[] } };
    };

    expect(schema.$id).toBe(
      "https://archsync.dev/schemas/infrastructure-graph-v0.1.schema.json",
    );
    expect(schema.properties.version.const).toBe("0.1");
    expect(schema.required).toEqual([
      "version",
      "identity_contract_version",
      "nodes",
      "edges",
      "diagnostics",
    ]);
    expect(schema.$defs.edge.required).toContain("resolved");
    expect(schema.$defs.evidence.required).toEqual(
      expect.arrayContaining(["source", "file", "range", "detector", "confidence"]),
    );
  });
});
