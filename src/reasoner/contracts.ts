export const explanationContractVersion = "0.1" as const;
export const repairCandidateContractVersion = "0.1.0-preparatory" as const;

export type UncertaintyLevel = "low" | "medium" | "high";
export type RepairRisk = "low" | "medium" | "high" | "critical";
export type RepairVerificationOutcome =
  | "ACCEPTABLE_FOR_REVIEW"
  | "REJECT_TEST"
  | "REJECT_CONFORMANCE"
  | "REJECT_UNSAFE"
  | "INCONCLUSIVE";

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
  decision: RepairVerificationOutcome;
  tests: "pass" | "fail" | "not-run";
  conformance: "pass" | "fail" | "not-run";
  safe_apply: boolean;
  new_blocking_findings: number;
  filesystem_isolation: "approved" | "not-approved";
  isolation_attestation_sha256: string | null;
}

export interface RepairFileExpectation {
  path: string;
  base_sha256: string | null;
}

/**
 * Canonical preparatory P4-103 hand-off shared by generation, deterministic
 * verification, and human review. Provider output must enter as PROPOSED with
 * no verification field; only the offline verifier may add that field.
 */
export interface RepairCandidate {
  schema_version: typeof repairCandidateContractVersion;
  candidate_id: string;
  status: "PROPOSED" | "VERIFIED_FOR_REVIEW";
  target_block_finding_fingerprints: string[];
  files: RepairFileExpectation[];
  unified_diff: string;
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
  if (value.schema_version !== repairCandidateContractVersion) {
    issues.push({ path: "/schema_version", message: `must equal ${repairCandidateContractVersion}` });
  }
  if (!(["PROPOSED", "VERIFIED_FOR_REVIEW"] as unknown[]).includes(value.status)) {
    issues.push({ path: "/status", message: "must be PROPOSED or VERIFIED_FOR_REVIEW" });
  }
  for (const key of ["candidate_id", "unified_diff", "rationale", "expected_architecture_impact", "rollback"]) {
    requireString(value, key, "", issues);
  }
  for (const key of ["target_block_finding_fingerprints", "verification_commands"]) {
    const entries = value[key];
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      issues.push({ path: `/${key}`, message: "must contain non-empty strings" });
    }
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    issues.push({ path: "/files", message: "must contain file expectations" });
  } else {
    value.files.forEach((item, index) => {
      if (!isRecord(item)) {
        issues.push({ path: `/files/${index}`, message: "must be an object" });
        return;
      }
      requireString(item, "path", `/files/${index}`, issues);
      if (item.base_sha256 !== null && (typeof item.base_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(item.base_sha256))) {
        issues.push({ path: `/files/${index}/base_sha256`, message: "must be null or lowercase SHA-256" });
      }
    });
  }
  if (!(["low", "medium", "high", "critical"] as unknown[]).includes(value.risk)) {
    issues.push({ path: "/risk", message: "must be low, medium, high, or critical" });
  }
  if (value.status === "VERIFIED_FOR_REVIEW" && !isRecord(value.verification)) {
    issues.push({ path: "/verification", message: "is required before review" });
  } else if (isRecord(value.verification)) {
    if (!(["ACCEPTABLE_FOR_REVIEW", "REJECT_TEST", "REJECT_CONFORMANCE", "REJECT_UNSAFE", "INCONCLUSIVE"] as unknown[]).includes(value.verification.decision)) {
      issues.push({ path: "/verification/decision", message: "must be a deterministic verification outcome" });
    }
    if (!(["pass", "fail", "not-run"] as unknown[]).includes(value.verification.tests)) {
      issues.push({ path: "/verification/tests", message: "must be pass, fail, or not-run" });
    }
    if (!(["pass", "fail", "not-run"] as unknown[]).includes(value.verification.conformance)) {
      issues.push({ path: "/verification/conformance", message: "must be pass, fail, or not-run" });
    }
    if (typeof value.verification.safe_apply !== "boolean") {
      issues.push({ path: "/verification/safe_apply", message: "must be a boolean" });
    }
    if (!Number.isInteger(value.verification.new_blocking_findings) || (value.verification.new_blocking_findings as number) < 0) {
      issues.push({ path: "/verification/new_blocking_findings", message: "must be a non-negative integer" });
    }
    if (!(value.verification.filesystem_isolation === "approved" || value.verification.filesystem_isolation === "not-approved")) {
      issues.push({ path: "/verification/filesystem_isolation", message: "must be approved or not-approved" });
    }
    if (
      value.verification.isolation_attestation_sha256 !== null &&
      (typeof value.verification.isolation_attestation_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.verification.isolation_attestation_sha256))
    ) {
      issues.push({ path: "/verification/isolation_attestation_sha256", message: "must be null or lowercase SHA-256" });
    }
    if (
      (value.verification.filesystem_isolation === "approved") !==
      (typeof value.verification.isolation_attestation_sha256 === "string")
    ) {
      issues.push({
        path: "/verification/isolation_attestation_sha256",
        message: "must be present exactly when filesystem isolation is approved",
      });
    }
  }
  return issues;
}

export function validateProposedRepairCandidateShape(value: unknown): ContractIssue[] {
  const issues = validateRepairCandidateShape(value);
  if (!isRecord(value)) return issues;
  if (value.status !== "PROPOSED") {
    issues.push({ path: "/status", message: "provider hand-off must be PROPOSED" });
  }
  if (value.verification !== undefined) {
    issues.push({ path: "/verification", message: "provider hand-off cannot assert verification" });
  }
  return issues;
}

export function isReviewableRepairCandidate(candidate: RepairCandidate): boolean {
  return candidate.status === "VERIFIED_FOR_REVIEW" && candidate.verification !== undefined &&
    candidate.verification.decision === "ACCEPTABLE_FOR_REVIEW" &&
    candidate.verification.safe_apply && candidate.verification.tests === "pass" &&
    candidate.verification.conformance === "pass" && candidate.verification.new_blocking_findings === 0 &&
    candidate.verification.filesystem_isolation === "approved" &&
    typeof candidate.verification.isolation_attestation_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.verification.isolation_attestation_sha256);
}
