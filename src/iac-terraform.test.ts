import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseTerraform, parseTerraformFiles } from "./iac-terraform.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (...parts: string[]) => join(root, "test", "fixtures", "iac", "terraform", ...parts);

describe("Phase 5 Terraform parser", () => {
  it("parses the supported managed infrastructure subset deterministically", async () => {
    const source = await readFile(fixture("positive.tf"), "utf8");
    const first = parseTerraform(source, "infra/main.tf");
    const second = parseTerraform(source, "infra/main.tf");

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.resources.map(({ name, kind, exposure }) => [name, kind, exposure])).toEqual([
      ["orders-db", "database", "public"],
      ["orders-cache", "cache", "private"],
      ["public-edge", "ingress", "public"],
      ["orders-events", "broker", "private"],
      ["audit-db", "database", "private"],
    ]);
    expect(first.resources.find(({ kind }) => kind === "cache")).toMatchObject({
      provider: "aws",
      managed: true,
      approved: true,
      trust_boundary: "data",
    });
    expect(first.resources.at(-1)).toMatchObject({ provider: "gcp", managed: true });
    expect(first.resources[0]?.evidence[0]).toMatchObject({
      file: "infra/main.tf",
      range: { start: { line: 1, column: 1, offset: 0 } },
      detector: "terraform-resource",
      confidence: 1,
    });
    expect(first.references).toEqual([]);
    expect(first.diagnostics).toEqual([]);
  });

  it("reports modules, data sources, dynamic expressions and unknown resources without guessing", async () => {
    const source = await readFile(fixture("dynamic-and-negative.tf"), "utf8");
    const result = parseTerraform(source, "infra/dynamic.tf");

    expect(result.resources).toHaveLength(2);
    expect(result.resources.map(({ name }) => name)).toEqual(["dynamic-db", "lookalike"]);
    expect(result.resources[0]).toMatchObject({
      kind: "database",
      exposure: "unknown",
      approved: false,
    });
    expect(result.resources[1]).toMatchObject({
      provider: "unknown",
      kind: "unknown",
      managed: false,
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "unsupported-block",
      "unsupported-block",
      "unsupported-dynamic-expression",
      "unsupported-dynamic-expression",
      "unsupported-resource",
      "unsupported-dynamic-expression",
    ]);
    expect(result.resources.some(({ name }) => name === "commented")).toBe(false);
  });

  it("supports stable literal attributes while flagging nested dynamic blocks", () => {
    const source = `/* resource "aws_db_instance" "ignored" { publicly_accessible = true } */
resource "azurerm_redis_cache" "cache" {
  name = "cache#blue" # a real inline comment
  public_network_access_enabled = false // private
  archsync_approved = true
  archsync_trust_boundary = "data"
  /* A nested comment with a fake brace }
     must not end the resource. */
  capacity = 2
  zones = ["1", "2"]
  empty = []
  dynamic "setting" {
    for_each = var.settings
  }
}
resource "google_compute_forwarding_rule" "edge" {
  name = "edge"
  ipv4_enabled = true
  description = "brace } and escaped \\\" quote"
}
resource "aws_lb" "internal" {
  scheme = "internal"
}
resource "aws_security_group" "world" {
  cidr_blocks = ["10.0.0.0/8", "0.0.0.0/0"]
  values = [1, 2]
}
dynamic "top_level" {
  for_each = []
}
`;
    const result = parseTerraform(source, "infra/literals.tf");
    const cache = result.resources.find(({ name }) => name === "cache#blue");
    const edge = result.resources.find(({ name }) => name === "edge");
    const internal = result.resources.find(({ name }) => name === "internal");
    const world = result.resources.find(({ name }) => name === "world");

    expect(cache?.attributes).toMatchObject({
      capacity: 2,
      zones: ["1", "2"],
      empty: [],
      archsync_approved: true,
    });
    expect(cache?.exposure).toBe("private");
    expect(edge).toMatchObject({ provider: "gcp", exposure: "public" });
    expect(internal?.exposure).toBe("internal");
    expect(world).toMatchObject({ kind: "unknown", exposure: "public" });
    expect(result.diagnostics.filter(({ code }) => code === "unsupported-block")).toHaveLength(2);
    expect(
      result.diagnostics.filter(({ code }) => code === "unsupported-dynamic-expression"),
    ).toHaveLength(2);
  });

  it("returns a ranged parse error for an unclosed block", async () => {
    const source = await readFile(fixture("malformed.tf"), "utf8");
    const result = parseTerraform(source, "broken.tf");

    expect(result.resources).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      code: "malformed-document",
      severity: "error",
      evidence: { file: "broken.tf", range: { start: { line: 1, column: 1 } } },
    });
  });

  it("combines files in portable lexical order", () => {
    const result = parseTerraformFiles({
      "z.tf": 'resource "aws_mq_broker" "z" { name = "z" }',
      "folder\\a.tf": 'resource "aws_db_instance" "a" { name = "a" }',
    });

    expect(result.resources.map(({ name }) => name)).toEqual(["a", "z"]);
    expect(result.resources[0]?.evidence[0]?.file).toBe("folder/a.tf");
    expect(result.diagnostics).toEqual([]);
  });
});
