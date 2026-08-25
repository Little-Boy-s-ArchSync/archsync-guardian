import { createHash } from "node:crypto";

import type { RepairCandidate, RepairRisk } from "./contracts.js";

export interface ReviewHandoff {
  schema_version: 1;
  handoff_id: string;
  candidate_hash: string;
  candidate_status: RepairCandidate["status"];
  risk: RepairRisk;
  evidence_ids: string[];
  verification: RepairCandidate["verification"] | null;
  rollback: string;
  decision: null | {
    actor_type: "human";
    reviewer_id: string;
    decision_id: string;
    outcome: "approved" | "rejected" | "inconclusive";
    rationale: string;
    decided_at: string;
  };
}

function canonicalCandidate(candidate: RepairCandidate): string {
  return JSON.stringify({
    contract_version: candidate.contract_version,
    status: candidate.status,
    patch: candidate.patch,
    target_files: [...candidate.target_files].sort(),
    rationale: candidate.rationale,
    expected_architecture_impact: candidate.expected_architecture_impact,
    risk: candidate.risk,
    verification_commands: candidate.verification_commands,
    rollback: candidate.rollback,
    verification: candidate.verification ?? null,
  });
}

export function createReviewHandoff(
  handoffId: string,
  candidate: RepairCandidate,
  evidenceIds: readonly string[],
): ReviewHandoff {
  if (!handoffId.trim()) throw new Error("handoff ID is required");
  return {
    schema_version: 1,
    handoff_id: handoffId,
    candidate_hash: createHash("sha256").update(canonicalCandidate(candidate)).digest("hex"),
    candidate_status: candidate.status,
    risk: candidate.risk,
    evidence_ids: [...new Set(evidenceIds)].sort(),
    verification: candidate.verification ?? null,
    rollback: candidate.rollback,
    decision: null,
  };
}

export function recordHumanReview(
  handoff: ReviewHandoff,
  input: {
    actor_type: "human";
    reviewer_id: string;
    decision_id: string;
    outcome: "approved" | "rejected" | "inconclusive";
    rationale: string;
    decided_at: string;
  },
): ReviewHandoff {
  if (handoff.decision) throw new Error("review handoff already has an immutable decision");
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} is required`);
  }
  if (input.outcome === "approved" && handoff.candidate_status !== "VERIFIED_FOR_REVIEW") {
    throw new Error("an unverified candidate cannot be approved");
  }
  return { ...handoff, decision: { ...input } };
}

export function isHumanApproved(handoff: ReviewHandoff): boolean {
  return handoff.decision?.actor_type === "human" && handoff.decision.outcome === "approved";
}
