import { validateExplanationCitations, type CitationValidation } from "./citations.js";
import {
  type ContractIssue,
  type Explanation,
  type ReasonerEvidence,
  validateExplanationShape,
} from "./contracts.js";
import { buildEvidenceOnlyPrompt } from "./prompt.js";
import {
  executeReasonerRun,
  type ProviderReliabilityPolicy,
  type ProviderRunResult,
  type ReasonerProvider,
  type RunEnvironment,
} from "./provider.js";
import { redactOutboundContext, type RedactionEvent } from "./redaction.js";

export interface ExplanationRun {
  ok: boolean;
  explanation?: Explanation;
  contract_issues: ContractIssue[];
  citation_validation?: CitationValidation;
  redactions: RedactionEvent[];
  provider_run: ProviderRunResult;
}

export async function explainFinding(
  provider: ReasonerProvider,
  finding: { id: string; kind: string; decision: "PASS" | "BLOCK" | "REVIEW"; message: string },
  evidence: readonly ReasonerEvidence[],
  policy: ProviderReliabilityPolicy,
  environment: RunEnvironment,
): Promise<ExplanationRun> {
  const redacted = redactOutboundContext(finding, evidence);
  const prompt = buildEvidenceOnlyPrompt({
    finding_id: redacted.finding.id,
    kind: redacted.finding.kind,
    decision: redacted.finding.decision,
    message: redacted.finding.message,
    evidence: redacted.evidence,
  });
  const run = await executeReasonerRun(provider, prompt.text, policy, {
    ...environment,
    prompt_version: prompt.version,
  });
  if (!run.ok || !run.response) {
    return { ok: false, contract_issues: [], redactions: redacted.events, provider_run: run };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.response.content);
  } catch {
    return {
      ok: false,
      contract_issues: [{ path: "/", message: "provider response is not JSON" }],
      redactions: redacted.events,
      provider_run: run,
    };
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    (parsed as Record<string, unknown>).model_provenance = {
      provider: run.manifest.provider,
      model: run.manifest.model,
      prompt_version: run.manifest.prompt_version,
      request_hash: run.manifest.request_hash,
    };
  }
  const contractIssues = validateExplanationShape(parsed);
  if (contractIssues.length > 0) {
    return { ok: false, contract_issues: contractIssues, redactions: redacted.events, provider_run: run };
  }
  const explanation = parsed as Explanation;
  const citations = validateExplanationCitations(explanation, redacted.evidence);
  return {
    ok: citations.valid,
    explanation,
    contract_issues: [],
    citation_validation: citations,
    redactions: redacted.events,
    provider_run: run,
  };
}
