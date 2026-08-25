import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadArchitecture } from "@archsync/core";
import { afterEach, describe, expect, it } from "vitest";

import { checkRepository } from "./guardian.js";
import {
  bindRepairVerificationResult,
  guardianResultToRepairSnapshot,
  repairCandidateSchemaVersion,
  validateRepairCandidate,
  verifyRepairCandidate,
  type NoNetworkCommandExecutor,
} from "./repair-verification.js";
import type { RepairCandidate, ReasonerEvidence } from "./reasoner/contracts.js";
import { validateProposedRepairCandidateShape } from "./reasoner/contracts.js";
import { explainFinding } from "./reasoner/explain.js";
import { createReviewHandoff, isHumanApproved } from "./reasoner/handoff.js";
import { buildEvidenceOnlyPrompt } from "./reasoner/prompt.js";
import { FakeReasonerProvider } from "./reasoner/provider.js";
import { classifyRootCause } from "./reasoner/taxonomy.js";

const fixtureRoot = fileURLToPath(new URL("../test/fixtures/phase4-case-06/", import.meta.url));
const temporaryRoots: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validCandidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    schema_version: repairCandidateSchemaVersion,
    candidate_id: "safety-candidate",
    status: "PROPOSED",
    target_block_finding_fingerprints: ["ARCH-001|fixture"],
    files: [{ path: "src/value.ts", base_sha256: "a".repeat(64) }],
    unified_diff: `diff --git a/src/value.ts b/src/value.ts
--- a/src/value.ts
+++ b/src/value.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`,
    rationale: "Deterministic regression fixture.",
    expected_architecture_impact: "Clear the declared fixture finding.",
    risk: "low",
    verification_commands: ["pnpm test"],
    rollback: "Restore the base-hash-bound fixture.",
    ...overrides,
  };
}

function explanationResponse(citation = "EVIDENCE-1"): string {
  return JSON.stringify({
    contract_version: "0.1",
    summary: "The supplied text remains untrusted evidence.",
    root_cause: "The deterministic finding remains authoritative.",
    claims: [{ text: "ARCH-001 remains BLOCK.", citations: [citation] }],
    uncertainty: { level: "low", reason: "This is a deterministic fake-provider fixture." },
    recommended_next_action: "Keep the deterministic gate unchanged.",
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("combined Phase 4 deterministic boundary", () => {
  it("replays locked case-06 from BLOCK through offline repair verification to undecided human handoff", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "archsync-case-06-integration-"));
    temporaryRoots.push(workspace);
    await cp(join(fixtureRoot, "repository"), workspace, { recursive: true });
    const applied = spawnSync("git", [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "apply",
      "--whitespace=nowarn",
      join(fixtureRoot, "changes", "case-06.patch"),
    ], {
      cwd: workspace,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    expect(applied.status, applied.stderr).toBe(0);

    const loaded = await loadArchitecture(join(fixtureRoot, "architecture.yaml"));
    expect(loaded.valid).toBe(true);
    expect(loaded.value).toBeDefined();
    const architecture = loaded.value!;
    const violation = await checkRepository(architecture, workspace);
    expect(violation.decision).toBe("BLOCK");
    const finding = violation.findings.find(({ rule_id }) => rule_id === "ARCH-001")!;
    expect(finding.source_evidence.map(({ file, line }) => ({ file, line }))).toContainEqual({
      file: "frontend/src/app.ts",
      line: 14,
    });
    expect(classifyRootCause({
      kind: finding.kind,
      message: finding.message,
      rule_id: finding.rule_id!,
      detector_confidence: finding.source_evidence[0]!.confidence,
    }).code).toBe("boundary-bypass");

    const evidence: ReasonerEvidence[] = [{
      id: "finding-arch001",
      kind: "finding",
      text: finding.message,
      file: finding.source_evidence[0]!.file,
      line: finding.source_evidence[0]!.line,
      rule_id: finding.rule_id!,
    }];
    const explained = await explainFinding(
      new FakeReasonerProvider("fake", "locked-fixture", [{
        content: explanationResponse("finding-arch001"),
        input_tokens: 20,
        output_tokens: 20,
        cost_usd: 0,
      }]),
      { id: finding.id, kind: finding.kind, decision: violation.decision, message: finding.message },
      evidence,
      { max_attempts: 1, timeout_ms: 1_000, max_input_tokens: 4_096, max_output_tokens: 100, max_cost_usd: 0, backoff_ms: 0 },
      {
        run_id: "case-06-fake",
        prompt_version: "ignored-by-boundary",
        raw_response_path: "raw/case-06-fake.json",
        now: () => "2026-08-26T00:00:00.000Z",
        wait: async () => undefined,
      },
    );
    expect(explained.ok).toBe(true);
    expect(violation.decision).toBe("BLOCK");

    const snapshot = guardianResultToRepairSnapshot(violation);
    expect(snapshot.block_finding_fingerprints).toHaveLength(1);
    const violatingSource = await readFile(join(workspace, "frontend", "src", "app.ts"), "utf8");
    const candidate: RepairCandidate = {
      schema_version: repairCandidateSchemaVersion,
      candidate_id: "case-06-remove-direct-payment",
      status: "PROPOSED",
      target_block_finding_fingerprints: snapshot.block_finding_fingerprints,
      files: [{ path: "frontend/src/app.ts", base_sha256: sha256(violatingSource) }],
      unified_diff: await readFile(join(fixtureRoot, "changes", "case-06-repair.patch"), "utf8"),
      rationale: "Remove the direct frontend-to-payment-service call introduced by locked case-06.",
      expected_architecture_impact: "Clear ARCH-001 while retaining the approved frontend-to-gateway path.",
      risk: "high",
      verification_commands: ["pnpm test"],
      rollback: "Reapply the locked case-06 patch after explicit human approval.",
    };
    expect(validateRepairCandidate(candidate)).toEqual({
      ok: true,
      paths: ["frontend/src/app.ts"],
    });

    const fixtureExecutor: NoNetworkCommandExecutor = {
      network_isolation: "ENFORCED",
      async execute(invocation) {
        const content = await readFile(join(invocation.cwd, "frontend", "src", "app.ts"), "utf8");
        const safe = !content.includes("paymentServiceUrl") && !content.includes("payDirectly");
        return {
          exit_code: safe ? 0 : 1,
          stdout: safe ? "fixture invariant passed" : "",
          stderr: safe ? "" : "fixture invariant failed",
          timed_out: false,
        };
      },
    };
    const verified = await verifyRepairCandidate({
      source_root: workspace,
      candidate,
      recheck: async (candidateWorkspace) => guardianResultToRepairSnapshot(
        await checkRepository(architecture, candidateWorkspace),
      ),
      test_command: { command: "pnpm", args: ["test"] },
      command_executor: fixtureExecutor,
    });
    expect(verified.decision).toBe("ACCEPTABLE_FOR_REVIEW");
    const bound = bindRepairVerificationResult(candidate, verified);
    expect(bound.status).toBe("VERIFIED_FOR_REVIEW");
    const handoff = createReviewHandoff("case-06-human-review", bound, ["finding-arch001"]);
    expect(handoff.decision).toBeNull();
    expect(isHumanApproved(handoff)).toBe(false);
    expect((await checkRepository(architecture, workspace)).decision).toBe("BLOCK");
  });

  it("runs every available safety case through the deterministic fake-provider boundary", async () => {
    const corpus = JSON.parse(await readFile(
      new URL("../test/fixtures/phase4-ai-safety-corpus.json", import.meta.url),
      "utf8",
    )) as {
      cases: Array<{
        id: string;
        label: "attack" | "hard-negative";
        category: string;
        content: string;
        expected: { hard_decision_unchanged: true; disposition: string };
      }>;
    };
    expect(corpus.cases).toHaveLength(12);
    const dispositions: Array<{ id: string; actual: string; expected: string }> = [];
    for (const safetyCase of corpus.cases) {
      const finding = { id: "ARCH-001", kind: "deny-rule", decision: "BLOCK" as const, message: "Boundary bypass" };
      const evidence: ReasonerEvidence[] = [{ id: "EVIDENCE-1", kind: "source", text: safetyCase.content, file: "fixture.ts", line: 1 }];
      const prompt = buildEvidenceOnlyPrompt({
        finding_id: finding.id,
        kind: finding.kind,
        decision: finding.decision,
        message: finding.message,
        evidence,
      });
      expect(prompt.text).toContain(JSON.stringify(safetyCase.content));
      const fakeCitation = safetyCase.id === "SAFETY-003" ? "EVIDENCE-999" : "EVIDENCE-1";
      const overBudget = safetyCase.id === "SAFETY-007";
      const explanation = await explainFinding(
        new FakeReasonerProvider("fake", "safety-fixture", [{
          content: explanationResponse(fakeCitation),
          input_tokens: overBudget ? 4_097 : 10,
          output_tokens: 10,
          cost_usd: 0,
        }]),
        finding,
        evidence,
        { max_attempts: 1, timeout_ms: 1_000, max_input_tokens: 4_096, max_output_tokens: 100, max_cost_usd: 0, backoff_ms: 0 },
        {
          run_id: safetyCase.id,
          prompt_version: "ignored-by-boundary",
          raw_response_path: `raw/${safetyCase.id}.json`,
          now: () => "2026-08-26T00:00:00.000Z",
          wait: async () => undefined,
        },
      );

      let actual: string;
      if (safetyCase.category === "fake-evidence") {
        actual = safetyCase.label === "attack" && !explanation.ok
          ? "reject-unknown-citation"
          : "accept-explanation-as-data";
      } else if (safetyCase.category === "path-traversal") {
        const repair = safetyCase.label === "attack"
          ? validCandidate({ files: [{ path: "../../outside/repository.ts", base_sha256: "a".repeat(64) }] })
          : validCandidate();
        actual = safetyCase.label === "attack" && !validateRepairCandidate(repair).ok
          ? "reject-unsafe-candidate"
          : "accept-test-description";
      } else if (safetyCase.category === "oversized-context") {
        actual = safetyCase.label === "attack" && !explanation.ok
          ? "reject-over-budget-request"
          : "accept-within-budget";
      } else if (safetyCase.category === "verification-bypass") {
        const repair = safetyCase.label === "attack"
          ? validCandidate({
              status: "VERIFIED_FOR_REVIEW",
              verification: {
                decision: "ACCEPTABLE_FOR_REVIEW",
                tests: "pass",
                conformance: "pass",
                safe_apply: true,
                new_blocking_findings: 0,
              },
            })
          : validCandidate();
        actual = safetyCase.label === "attack" && validateProposedRepairCandidateShape(repair).length > 0
          ? "reject-bypass"
          : "accept-policy-text";
      } else if (safetyCase.category === "source-instruction") {
        actual = safetyCase.label === "attack" && explanation.ok
          ? "treat-source-as-data"
          : "accept-literal-as-data";
      } else {
        actual = safetyCase.label === "attack" && explanation.ok
          ? "ignore-model-instruction"
          : "accept-model-description";
      }
      expect(finding.decision).toBe("BLOCK");
      dispositions.push({ id: safetyCase.id, actual, expected: safetyCase.expected.disposition });
    }
    expect(dispositions.filter(({ actual, expected }) => actual !== expected)).toEqual([]);
  });
});
