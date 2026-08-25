import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "prompts", "manifest.json"), "utf8"));
assert.equal(manifest.schema_version, 1);
for (const item of manifest.templates) {
  const content = await readFile(join(root, "prompts", item.file), "utf8");
  assert.equal(createHash("sha256").update(content).digest("hex"), item.sha256, `${item.file} hash mismatch`);
  assert.ok(content.startsWith(`ARCHSYNC PROMPT ${item.version}\n`));
}
for (const file of ["explanation.schema.json", "repair-candidate.schema.json"]) {
  const schema = JSON.parse(await readFile(join(root, "specs", file), "utf8"));
  assert.equal(schema.type, "object");
  assert.ok(schema.required.includes("contract_version"));
  assert.match(schema.$id, /\/0\.1$/u);
}
const boundary = await readFile(join(root, "docs", "adr", "0001-phase4-ai-assistance-boundary.md"), "utf8");
const security = await readFile(join(root, "docs", "adr", "0002-provider-security-checklist.md"), "utf8");
assert.match(boundary, /blocked by EXP-101 and Lead approval/iu);
assert.match(boundary, /never.+update a baseline/isu);
assert.match(security, /NOT APPROVED/);
assert.match(security, /real-provider runs prohibited/);
console.log(`PASS PHASE 4 ASSETS (${manifest.templates.length} prompt; 2 schemas; human gates preserved)`);
