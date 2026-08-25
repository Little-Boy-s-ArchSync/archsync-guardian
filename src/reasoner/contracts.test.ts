import { describe, expect, it } from "vitest";

import {
  isReviewableRepairCandidate,
  type Explanation,
  type RepairCandidate,
  validateExplanationShape,
  validateProposedRepairCandidateShape,
  validateRepairCandidateShape,
} from "./contracts.js";

function explanation(): Explanation {
  return {
    contract_version: "0.1",
    summary: "The frontend bypasses the gateway.",
    root_cause: "A direct data dependency was introduced.",
    claims: [{ text: "ARCH-001 is violated at line 4.", citations: ["finding-1"] }],
    uncertainty: { level: "low", reason: "The deterministic finding is exact." },
    recommended_next_action: "Route the call through the gateway.",
    model_provenance: {
      provider: "fake",
      model: "fixture",
      prompt_version: "v1",
      request_hash: "abc",
    },
  };
}

function candidate(): RepairCandidate {
  return {
    schema_version: "0.1.0-preparatory",
    candidate_id: "repair-001",
    status: "PROPOSED",
    target_block_finding_fingerprints: ["ARCH-001|a|b"],
    files: [{ path: "a.ts", base_sha256: "a".repeat(64) }],
    unified_diff: "diff --git a/a.ts b/a.ts\n",
    rationale: "Remove the bypass.",
    expected_architecture_impact: "Resolve ARCH-001.",
    risk: "medium",
    verification_commands: ["pnpm test"],
    rollback: "git revert <commit>",
  };
}

describe("Phase 4 contracts", () => {
  it("accepts complete explanations and rejects a non-object", () => {
    expect(validateExplanationShape(explanation())).toEqual([]);
    expect(validateExplanationShape(null)).toEqual([{ path: "/", message: "must be an object" }]);
  });

  it("reports every missing or malformed explanation field", () => {
    const issues = validateExplanationShape({
      contract_version: "9",
      summary: "",
      root_cause: 1,
      recommended_next_action: null,
      claims: [null, { text: "", citations: [""] }],
      uncertainty: { level: "certain", reason: "" },
      model_provenance: { provider: "", model: 1 },
    });
    expect(issues.map(({ path }) => path)).toEqual([
      "/contract_version",
      "/summary",
      "/root_cause",
      "/recommended_next_action",
      "/claims/0",
      "/claims/1/text",
      "/claims/1/citations",
      "/uncertainty/level",
      "/uncertainty/reason",
      "/model_provenance/provider",
      "/model_provenance/model",
      "/model_provenance/prompt_version",
      "/model_provenance/request_hash",
    ]);
    expect(validateExplanationShape({
      ...explanation(),
      claims: [],
      uncertainty: null,
      model_provenance: null,
    }).map(({ path }) => path)).toEqual(["/claims", "/uncertainty", "/model_provenance"]);
  });

  it("accepts proposed repairs but never treats them as reviewable", () => {
    const value = candidate();
    expect(validateRepairCandidateShape(value)).toEqual([]);
    expect(isReviewableRepairCandidate(value)).toBe(false);
  });

  it("requires successful deterministic verification before review", () => {
    const value: RepairCandidate = {
      ...candidate(),
      status: "VERIFIED_FOR_REVIEW",
      verification: {
        decision: "ACCEPTABLE_FOR_REVIEW",
        tests: "pass",
        conformance: "pass",
        safe_apply: true,
        new_blocking_findings: 0,
      },
    };
    expect(validateRepairCandidateShape(value)).toEqual([]);
    expect(isReviewableRepairCandidate(value)).toBe(true);
    for (const verification of [
      { ...value.verification!, decision: "INCONCLUSIVE" as const },
      { ...value.verification!, tests: "fail" as const },
      { ...value.verification!, conformance: "fail" as const },
      { ...value.verification!, safe_apply: false },
      { ...value.verification!, new_blocking_findings: 1 },
    ]) {
      expect(isReviewableRepairCandidate({ ...value, verification })).toBe(false);
    }
  });

  it("rejects malformed repair candidates and missing verification", () => {
    expect(validateRepairCandidateShape(undefined)).toEqual([{ path: "/", message: "must be an object" }]);
    const issues = validateRepairCandidateShape({
      schema_version: "2",
      candidate_id: "",
      status: "ACCEPTED",
      unified_diff: "",
      rationale: 1,
      expected_architecture_impact: null,
      rollback: "",
      target_block_finding_fingerprints: [],
      files: [],
      verification_commands: [1],
      risk: "none",
    });
    expect(issues.map(({ path }) => path)).toEqual([
      "/schema_version",
      "/status",
      "/candidate_id",
      "/unified_diff",
      "/rationale",
      "/expected_architecture_impact",
      "/rollback",
      "/target_block_finding_fingerprints",
      "/verification_commands",
      "/files",
      "/risk",
    ]);
    expect(validateRepairCandidateShape({ ...candidate(), status: "VERIFIED_FOR_REVIEW" })).toContainEqual({
      path: "/verification",
      message: "is required before review",
    });
    expect(validateProposedRepairCandidateShape({
      ...candidate(),
      status: "VERIFIED_FOR_REVIEW",
      verification: {
        decision: "ACCEPTABLE_FOR_REVIEW",
        tests: "pass",
        conformance: "pass",
        safe_apply: true,
        new_blocking_findings: 0,
      },
    }).map(({ path }) => path)).toEqual(["/status", "/verification"]);
    expect(validateProposedRepairCandidateShape(null)).toEqual([{ path: "/", message: "must be an object" }]);
  });

  it("rejects malformed file manifests and verifier summaries", () => {
    const issues = validateRepairCandidateShape({
      ...candidate(),
      files: [
        null,
        { path: "", base_sha256: 1 },
        { path: "bad-hash.ts", base_sha256: "BAD" },
        { path: "new.ts", base_sha256: null },
      ],
      verification: {
        decision: "PROVIDER_SAYS_OK",
        tests: "maybe",
        conformance: "maybe",
        safe_apply: "yes",
        new_blocking_findings: -1,
      },
    });
    expect(issues.map(({ path }) => path)).toEqual([
      "/files/0",
      "/files/1/path",
      "/files/1/base_sha256",
      "/files/2/base_sha256",
      "/verification/decision",
      "/verification/tests",
      "/verification/conformance",
      "/verification/safe_apply",
      "/verification/new_blocking_findings",
    ]);
  });
});
