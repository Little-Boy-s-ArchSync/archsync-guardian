import { describe, expect, it } from "vitest";

import type { RepairCandidate } from "./contracts.js";
import {
  createReviewHandoff,
  isHumanApproved,
  recordHumanReview,
  type ReviewHandoff,
} from "./handoff.js";

function candidate(status: RepairCandidate["status"] = "PROPOSED"): RepairCandidate {
  return {
    schema_version: "0.1.0-preparatory",
    candidate_id: "repair-001",
    status,
    target_block_finding_fingerprints: ["ARCH-001|b", "ARCH-001|a"],
    files: [
      { path: "b.ts", base_sha256: "b".repeat(64) },
      { path: "a.ts", base_sha256: "a".repeat(64) },
    ],
    unified_diff: "diff\n",
    rationale: "reason",
    expected_architecture_impact: "impact",
    risk: "high",
    verification_commands: ["pnpm test"],
    rollback: "revert",
    ...(status === "VERIFIED_FOR_REVIEW" ? {
      verification: {
        decision: "ACCEPTABLE_FOR_REVIEW" as const,
        tests: "pass" as const,
        conformance: "pass" as const,
        safe_apply: true,
        new_blocking_findings: 0,
      },
    } : {}),
  };
}

describe("human-review handoff", () => {
  it("creates a deterministic, undecided audit record", () => {
    const first = createReviewHandoff("handoff-1", candidate(), ["z", "a", "z"]);
    const second = createReviewHandoff("handoff-1", candidate(), ["a", "z"]);
    expect(first).toEqual(second);
    expect(first.evidence_ids).toEqual(["a", "z"]);
    expect(first.verification).toBeNull();
    expect(first.decision).toBeNull();
    expect(first.candidate_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(isHumanApproved(first)).toBe(false);
    expect(() => createReviewHandoff("", candidate(), [])).toThrow("handoff ID");
  });

  it("records one immutable human approval only after verification", () => {
    const handoff = createReviewHandoff("handoff-1", candidate("VERIFIED_FOR_REVIEW"), ["e-1"]);
    const decided = recordHumanReview(handoff, {
      actor_type: "human",
      reviewer_id: "reviewer-3",
      decision_id: "decision-1",
      outcome: "approved",
      rationale: "Tests and conformance pass; risk accepted.",
      decided_at: "2026-08-26T00:00:00Z",
    });
    expect(isHumanApproved(decided)).toBe(true);
    expect(decided.verification).not.toBeNull();
    expect(() => recordHumanReview(decided, decided.decision!)).toThrow("immutable decision");
  });

  it("rejects auto-like incomplete decisions and unverified approval", () => {
    const handoff = createReviewHandoff("handoff-1", candidate(), []);
    expect(() => recordHumanReview(handoff, {
      actor_type: "human", reviewer_id: "", decision_id: "d", outcome: "rejected", rationale: "r", decided_at: "now",
    })).toThrow("reviewer_id is required");
    expect(() => recordHumanReview(handoff, {
      actor_type: "human", reviewer_id: "r", decision_id: "d", outcome: "approved", rationale: "r", decided_at: "now",
    })).toThrow("exactly verified candidate");
    const rejected = recordHumanReview(handoff, {
      actor_type: "human", reviewer_id: "r", decision_id: "d", outcome: "rejected", rationale: "unsafe", decided_at: "now",
    });
    expect(isHumanApproved(rejected)).toBe(false);
    const inconclusive = recordHumanReview(createReviewHandoff("handoff-2", candidate(), []), {
      actor_type: "human", reviewer_id: "r", decision_id: "d2", outcome: "inconclusive", rationale: "unknown", decided_at: "now",
    });
    expect(isHumanApproved(inconclusive)).toBe(false);
  });

  it("runtime-validates candidates before constructing a review handoff", () => {
    expect(() => createReviewHandoff("handoff-invalid", {
      ...candidate(),
      candidate_id: "",
    }, [])).toThrow("repair candidate is invalid: /candidate_id");
    expect(() => createReviewHandoff("handoff-tampered", {
      ...candidate("VERIFIED_FOR_REVIEW"),
      verification: {
        ...candidate("VERIFIED_FOR_REVIEW").verification!,
        decision: "REJECT_TEST",
      },
    }, [])).toThrow("acceptable review invariants");
  });

  it("rejects approval when any embedded verifier invariant is tampered", () => {
    const valid = createReviewHandoff("handoff-verified", candidate("VERIFIED_FOR_REVIEW"), ["e-1"]);
    const accepted = valid.verification!;
    const tampered: ReviewHandoff[] = [
      { ...valid, candidate_status: "PROPOSED" },
      { ...valid, verification: null },
      { ...valid, verification: { ...accepted, decision: "REJECT_TEST" } },
      { ...valid, verification: { ...accepted, tests: "fail" } },
      { ...valid, verification: { ...accepted, conformance: "fail" } },
      { ...valid, verification: { ...accepted, safe_apply: false } },
      { ...valid, verification: { ...accepted, new_blocking_findings: 1 } },
    ];
    const approval = {
      actor_type: "human" as const,
      reviewer_id: "reviewer-3",
      decision_id: "decision-tampered",
      outcome: "approved" as const,
      rationale: "approve",
      decided_at: "2026-08-26T00:00:00Z",
    };
    for (const handoff of tampered) {
      expect(() => recordHumanReview(handoff, approval)).toThrow("exactly verified candidate");
      expect(isHumanApproved({ ...handoff, decision: approval })).toBe(false);
    }
  });

  it("runtime-rejects non-human actors and unknown outcomes", () => {
    const handoff = createReviewHandoff("handoff-runtime", candidate(), []);
    expect(() => recordHumanReview(handoff, {
      actor_type: "provider",
      reviewer_id: "provider",
      decision_id: "d",
      outcome: "rejected",
      rationale: "r",
      decided_at: "now",
    } as never)).toThrow("actor_type must be human");
    expect(() => recordHumanReview(handoff, {
      actor_type: "human",
      reviewer_id: "reviewer",
      decision_id: "d",
      outcome: "override",
      rationale: "r",
      decided_at: "now",
    } as never)).toThrow("outcome must be approved, rejected, or inconclusive");
  });
});
