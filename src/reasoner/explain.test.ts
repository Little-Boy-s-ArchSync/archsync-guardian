import { describe, expect, it } from "vitest";

import type { Explanation, ReasonerEvidence } from "./contracts.js";
import { explainFinding } from "./explain.js";
import { FakeReasonerProvider, ProviderFailure, type ProviderReliabilityPolicy, type RunEnvironment } from "./provider.js";

const policy: ProviderReliabilityPolicy = {
  max_attempts: 1,
  timeout_ms: 10,
  max_input_tokens: 4_096,
  max_output_tokens: 100,
  max_cost_usd: 1,
  backoff_ms: 0,
};
const environment: RunEnvironment = {
  run_id: "case-06",
  prompt_version: "overwritten",
  raw_response_path: "raw/case-06.json",
  now: () => "2026-08-26T00:00:00Z",
  wait: async () => undefined,
};
const finding = { id: "finding-1", kind: "rule-violation", decision: "BLOCK" as const, message: "ARCH-001" };
const evidence: ReasonerEvidence[] = [{
  id: "e-1", kind: "source", text: "api_key=canary frontend bypass", file: "frontend/src/database.ts", line: 4, rule_id: "ARCH-001",
}];

function explanation(citations = ["e-1"]): Explanation {
  return {
    contract_version: "0.1",
    summary: "The frontend bypasses the gateway.",
    root_cause: "Boundary bypass.",
    claims: [{ text: "ARCH-001 is violated.", citations, source_location: { file: "frontend/src/database.ts", line: 4, rule_id: "ARCH-001" } }],
    uncertainty: { level: "low", reason: "Exact evidence." },
    recommended_next_action: "Route through the gateway.",
    model_provenance: { provider: "untrusted", model: "untrusted", prompt_version: "untrusted", request_hash: "untrusted" },
  };
}

function provider(content: string) {
  return new FakeReasonerProvider("fake", "fixture", [{ content, input_tokens: 5, output_tokens: 10, cost_usd: 0 }]);
}

describe("grounded explanation vertical slice", () => {
  it("redacts outbound evidence, validates citations, and binds real provenance", async () => {
    const result = await explainFinding(provider(JSON.stringify(explanation())), finding, evidence, policy, environment);
    expect(result.ok).toBe(true);
    expect(result.redactions).toEqual([{ evidence_id: "e-1", field: "text", reason: "credential" }]);
    expect(result.citation_validation?.valid).toBe(true);
    expect(result.explanation?.model_provenance).toMatchObject({
      provider: "fake", model: "fixture", prompt_version: "explanation-evidence-only-v0.1",
    });
    expect(result.provider_run.manifest.request_hash).toBe(result.explanation?.model_provenance.request_hash);
  });

  it("preserves provider failures as failed manifests", async () => {
    const failed = new FakeReasonerProvider("fake", "fixture", [new ProviderFailure("quota", "offline")]);
    const result = await explainFinding(failed, finding, evidence, policy, environment);
    expect(result.ok).toBe(false);
    expect(result.explanation).toBeUndefined();
    expect(result.contract_issues).toEqual([]);
  });

  it("rejects non-JSON, primitive JSON, and malformed contracts", async () => {
    const invalidJson = await explainFinding(provider("not-json"), finding, evidence, policy, environment);
    expect(invalidJson.contract_issues).toEqual([{ path: "/", message: "provider response is not JSON" }]);

    const primitive = await explainFinding(provider("17"), finding, evidence, policy, environment);
    expect(primitive.contract_issues).toEqual([{ path: "/", message: "must be an object" }]);

    const malformed = await explainFinding(provider(JSON.stringify({ contract_version: "0.1" })), finding, evidence, policy, environment);
    expect(malformed.ok).toBe(false);
    expect(malformed.contract_issues.length).toBeGreaterThan(0);
  });

  it("counts an invented citation as an unsupported claim", async () => {
    const result = await explainFinding(provider(JSON.stringify(explanation(["invented"]))), finding, evidence, policy, environment);
    expect(result.ok).toBe(false);
    expect(result.contract_issues).toEqual([]);
    expect(result.citation_validation).toMatchObject({ valid: false, unsupported_claims: 1 });
  });
});
