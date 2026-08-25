import { describe, expect, it } from "vitest";

import {
  createPendingApprovalRecord,
  type ApprovalRecord,
  validateApprovalRecord,
} from "./approval.js";

function pending(): ApprovalRecord {
  return createPendingApprovalRecord({
    record_id: "redis-candidate-001",
    risk_level: "high",
    evidence_snapshot_sha256: "a".repeat(64),
    scorecard: { rows: [] },
    rationale: "Awaiting independent human review.",
    rollback_plan: "Keep the current baseline and remove the candidate cache deployment.",
  });
}

describe("approval record", () => {
  it("creates a valid pending record without implying approval", () => {
    const record = pending();
    expect(record).not.toHaveProperty("approver");
    expect(record).not.toHaveProperty("baseline_update_commit");
    expect(record.decision).toBe("pending");
    expect(validateApprovalRecord(record)).toEqual({ valid: true, issues: [] });
  });

  it("rejects malformed provenance and missing rationale fields", () => {
    const record = pending();
    record.contract_version = "wrong" as "0.1";
    record.record_id = "";
    record.evidence_snapshot_sha256 = "BAD";
    record.scorecard_sha256 = "short";
    record.rationale = "";
    record.rollback_plan = "";
    const result = validateApprovalRecord(record);

    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(6);
  });

  it("fails closed when an accepted decision lacks a human approver or exact commit", () => {
    const record = pending();
    record.decision = "accepted";
    expect(validateApprovalRecord(record).issues).toEqual([
      "accepted decisions require an identified human approver and role",
      "accepted decisions require the exact 40-character baseline update commit",
    ]);

    record.approver = { kind: "human", identity: "", role: "" };
    record.baseline_update_commit = "bad";
    expect(validateApprovalRecord(record).issues).toHaveLength(2);
  });

  it("validates a syntactically complete human record without creating one automatically", () => {
    const record = pending();
    record.decision = "accepted";
    record.approver = { kind: "human", identity: "reviewer-42", role: "architecture-lead" };
    record.baseline_update_commit = "b".repeat(40);
    expect(validateApprovalRecord(record)).toEqual({ valid: true, issues: [] });

    record.decision = "rejected";
    expect(validateApprovalRecord(record)).toEqual({ valid: true, issues: [] });
  });

  it("rejects approval or baseline claims while a record remains pending", () => {
    const record = pending();
    record.approver = { kind: "human", identity: "reviewer-42", role: "architecture-lead" };
    record.baseline_update_commit = "b".repeat(40);
    expect(validateApprovalRecord(record).issues).toEqual([
      "pending decisions must not claim an approver or baseline update",
    ]);
  });
});
