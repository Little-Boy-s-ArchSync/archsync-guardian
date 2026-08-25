export const explanationContractVersion = "0.1" as const;
export const repairCandidateContractVersion = "0.1" as const;

export type UncertaintyLevel = "low" | "medium" | "high";
export type RepairRisk = "low" | "medium" | "high" | "critical";

export interface ReasonerEvidence {
  id: string;
  kind: "source" | "model" | "finding";
  text: string;
  file?: string;
  line?: number;
  rule_id?: string;
}

export interface ExplanationClaim {
  text: string;
  citations: string[];
  source_location?: {
    file?: string;
    line?: number;
    rule_id?: string;
  };
}

export interface Explanation {
  contract_version: typeof explanationContractVersion;
  summary: string;
  root_cause: string;
  claims: ExplanationClaim[];
  uncertainty: {
    level: UncertaintyLevel;
    reason: string;
  };
  recommended_next_action: string;
  model_provenance: {
    provider: string;
    model: string;
    prompt_version: string;
    request_hash: string;
  };
}

export interface VerificationResult {
  tests: "pass" | "fail" | "not-run";
  conformance: "pass" | "fail" | "not-run";
  safe_apply: boolean;
  new_blocking_findings: number;
}

export interface RepairCandidate {
  contract_version: typeof repairCandidateContractVersion;
  status: "PROPOSED" | "VERIFIED_FOR_REVIEW";
  patch: string;
  target_files: string[];
  rationale: string;
  expected_architecture_impact: string;
  risk: RepairRisk;
  verification_commands: string[];
  rollback: string;
  verification?: VerificationResult;
}

export interface ContractIssue {
  path: string;
  message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: ContractIssue[],
): void {
  if (typeof value[key] !== "string" || value[key].trim().length === 0) {
    issues.push({ path: `${path}/${key}`, message: "must be a non-empty string" });
  }
}

export function validateExplanationShape(value: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isRecord(value)) return [{ path: "/", message: "must be an object" }];
  if (value.contract_version !== explanationContractVersion) {
    issues.push({ path: "/contract_version", message: `must equal ${explanationContractVersion}` });
  }
  for (const key of ["summary", "root_cause", "recommended_next_action"]) {
    requireString(value, key, "", issues);
  }
  if (!Array.isArray(value.claims) || value.claims.length === 0) {
    issues.push({ path: "/claims", message: "must contain at least one claim" });
  } else {
    value.claims.forEach((claim, index) => {
      if (!isRecord(claim)) {
        issues.push({ path: `/claims/${index}`, message: "must be an object" });
        return;
      }
      requireString(claim, "text", `/claims/${index}`, issues);
      if (
        !Array.isArray(claim.citations) || claim.citations.length === 0 ||
        claim.citations.some((citation) => typeof citation !== "string" || citation.length === 0)
      ) {
        issues.push({ path: `/claims/${index}/citations`, message: "must contain evidence IDs" });
      }
    });
  }
  if (!isRecord(value.uncertainty)) {
    issues.push({ path: "/uncertainty", message: "must be an object" });
  } else {
    if (!(["low", "medium", "high"] as unknown[]).includes(value.uncertainty.level)) {
      issues.push({ path: "/uncertainty/level", message: "must be low, medium, or high" });
    }
    requireString(value.uncertainty, "reason", "/uncertainty", issues);
  }
  if (!isRecord(value.model_provenance)) {
    issues.push({ path: "/model_provenance", message: "must be an object" });
  } else {
    for (const key of ["provider", "model", "prompt_version", "request_hash"]) {
      requireString(value.model_provenance, key, "/model_provenance", issues);
    }
  }
  return issues;
}

export function validateRepairCandidateShape(value: unknown): ContractIssue[] {
  const issues: ContractIssue[] = [];
  if (!isRecord(value)) return [{ path: "/", message: "must be an object" }];
  if (value.contract_version !== repairCandidateContractVersion) {
    issues.push({ path: "/contract_version", message: `must equal ${repairCandidateContractVersion}` });
  }
  if (!(["PROPOSED", "VERIFIED_FOR_REVIEW"] as unknown[]).includes(value.status)) {
    issues.push({ path: "/status", message: "must be PROPOSED or VERIFIED_FOR_REVIEW" });
  }
  for (const key of ["patch", "rationale", "expected_architecture_impact", "rollback"]) {
    requireString(value, key, "", issues);
  }
  for (const key of ["target_files", "verification_commands"]) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      issues.push({ path: `/${key}`, message: "must contain non-empty strings" });
    }
  }
  if (!(["low", "medium", "high", "critical"] as unknown[]).includes(value.risk)) {
    issues.push({ path: "/risk", message: "must be low, medium, high, or critical" });
  }
  if (value.status === "VERIFIED_FOR_REVIEW" && !isRecord(value.verification)) {
    issues.push({ path: "/verification", message: "is required before review" });
  }
  return issues;
}

export function isReviewableRepairCandidate(candidate: RepairCandidate): boolean {
  return candidate.status === "VERIFIED_FOR_REVIEW" && candidate.verification !== undefined &&
    candidate.verification.safe_apply && candidate.verification.tests === "pass" &&
    candidate.verification.conformance === "pass" && candidate.verification.new_blocking_findings === 0;
}
