import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { classifyRootCause } from "../dist/reasoner/taxonomy.js";

const root = resolve(import.meta.dirname, "..");
const fixtures = join(root, "test", "fixtures");
const manifest = JSON.parse(await readFile(join(root, "prompts", "manifest.json"), "utf8"));
assert.equal(manifest.schema_version, 1);
for (const item of manifest.templates) {
  const content = await readFile(join(root, "prompts", item.file), "utf8");
  assert.equal(createHash("sha256").update(content).digest("hex"), item.sha256, `${item.file} hash mismatch`);
  assert.ok(content.startsWith(`ARCHSYNC PROMPT ${item.version}\n`));
}
for (const [file, versionKey, version] of [
  ["explanation.schema.json", "contract_version", "0.1"],
  ["repair-candidate.schema.json", "schema_version", "0.1.0-preparatory"],
]) {
  const schema = JSON.parse(await readFile(join(root, "specs", file), "utf8"));
  assert.equal(schema.type, "object");
  assert.ok(schema.required.includes(versionKey));
  assert.ok(schema.$id.endsWith(`/${version}`));
}
const case06 = join(fixtures, "phase4-case-06");
const case06Provenance = JSON.parse(await readFile(join(case06, "provenance.json"), "utf8"));
for (const [file, expected] of [
  ["architecture.yaml", case06Provenance.architecture_sha256],
  ["repository/frontend/src/app.ts", case06Provenance.base_app_sha256],
  ["changes/case-06.patch", case06Provenance.case_06_patch_sha256],
  ["changes/case-06-repair.patch", case06Provenance.case_06_repair_patch_sha256],
]) {
  assert.equal(createHash("sha256").update(await readFile(join(case06, file))).digest("hex"), expected, `${file} fixture hash mismatch`);
}
assert.equal(case06Provenance.research_claim, null);
assert.equal(case06Provenance.human_approval, null);

const safetyProvenance = JSON.parse(await readFile(join(fixtures, "phase4-ai-safety-provenance.json"), "utf8"));
const safetyBytes = await readFile(join(fixtures, "phase4-ai-safety-corpus.json"));
const safety = JSON.parse(safetyBytes);
assert.equal(createHash("sha256").update(safetyBytes).digest("hex"), safetyProvenance.corpus_sha256);
assert.equal(safety.cases.length, 12);
assert.equal(safetyProvenance.real_provider_run, false);
assert.equal(safetyProvenance.research_claim, null);
assert.equal(safetyProvenance.human_approval, null);

const taxonomy = JSON.parse(await readFile(join(fixtures, "phase4-order-platform-taxonomy.json"), "utf8"));
assert.equal(taxonomy.cases.length, 20);
assert.deepEqual(
  taxonomy.cases.map(({ id }) => id),
  Array.from({ length: 20 }, (_value, index) => `case-${String(index + 1).padStart(2, "0")}`),
);
let taxonomyFindings = 0;
for (const item of taxonomy.cases) {
  for (const finding of item.findings) {
    taxonomyFindings += 1;
    const mapped = classifyRootCause(finding).code;
    assert.notEqual(mapped, "unknown", `${item.id} retained an unmapped root cause`);
    assert.equal(mapped, finding.expected_root_cause, `${item.id} taxonomy mapping changed`);
  }
}
assert.equal(taxonomyFindings, 25);
assert.equal(taxonomy.research_claim, null);
assert.equal(taxonomy.human_approval, null);
const boundary = await readFile(join(root, "docs", "adr", "0001-phase4-ai-assistance-boundary.md"), "utf8");
const security = await readFile(join(root, "docs", "adr", "0002-provider-security-checklist.md"), "utf8");
const integration = await readFile(join(root, "docs", "phase-4-integration-status.md"), "utf8");
assert.match(boundary, /blocked by EXP-101 and Lead approval/iu);
assert.match(boundary, /never.+update a baseline/isu);
assert.match(security, /NOT APPROVED/);
assert.match(security, /real-provider runs prohibited/);
assert.match(integration, /no real-provider run, research result, approval, freeze, or merge claim/iu);
assert.match(integration, /P4-115.P4-120/isu);
console.log(`PASS PHASE 4 ASSETS (${manifest.templates.length} prompt; 2 schemas; case-06 replay; ${taxonomy.cases.length}-case/${taxonomyFindings}-finding taxonomy; ${safety.cases.length}-case deterministic safety corpus; human gates preserved)`);
