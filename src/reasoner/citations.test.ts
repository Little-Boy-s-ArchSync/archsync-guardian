import { describe, expect, it } from "vitest";

import type { Explanation, ReasonerEvidence } from "./contracts.js";
import { validateExplanationCitations } from "./citations.js";

const evidence: ReasonerEvidence[] = [{
  id: "finding-1",
  kind: "finding",
  text: "ARCH-001 direct frontend database dependency",
  file: "frontend/src/database.ts",
  line: 4,
  rule_id: "ARCH-001",
}];

function explanation(): Explanation {
  return {
    contract_version: "0.1",
    summary: "A bypass exists.",
    root_cause: "Boundary bypass.",
    claims: [{
      text: "The frontend reaches the database.",
      citations: ["finding-1"],
      source_location: { file: "frontend/src/database.ts", line: 4, rule_id: "ARCH-001" },
    }],
    uncertainty: { level: "low", reason: "Exact source finding." },
    recommended_next_action: "Remove the dependency.",
    model_provenance: { provider: "fake", model: "fixture", prompt_version: "v1", request_hash: "abc" },
  };
}

describe("citation validator", () => {
  it("accepts exact supplied evidence", () => {
    expect(validateExplanationCitations(explanation(), evidence)).toEqual({
      valid: true,
      unsupported_claims: 0,
      issues: [],
    });
  });

  it("rejects absent, duplicate, unknown, and tampered citations", () => {
    const value = explanation();
    value.claims = [
      { text: "unsupported", citations: [] },
      { text: "unknown", citations: ["invented"] },
      { text: "duplicate", citations: ["finding-1", "finding-1"] },
      { text: "tampered", citations: ["finding-1"], source_location: { line: 99 } },
    ];
    const result = validateExplanationCitations(value, evidence);
    expect(result.valid).toBe(false);
    expect(result.unsupported_claims).toBe(3);
    expect(result.issues.map(({ message }) => message)).toEqual([
      "claim has no evidence citation",
      "citation was not supplied to the provider",
      "duplicate citation",
      "quoted file, line, or rule does not match evidence",
    ]);
  });
});
