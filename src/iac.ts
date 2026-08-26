import type {
  ClassifiedEvidenceClaim,
  CrossSourceIdentityMap,
  IdentityAliasRule,
  InfrastructureObservation,
  InfrastructureParseResult,
  InfrastructureSecurityFinding,
  NormalizedInfrastructureGraph,
  ParsedInfrastructureReference,
} from "./iac-contracts.js";
import { parseKubernetesFiles } from "./iac-kubernetes.js";
import {
  buildCrossSourceEvidenceClaims,
  buildNormalizedInfrastructureGraph,
  classifyEvidenceClaims,
  mapCrossSourceIdentities,
  observationsFromParseResult,
} from "./iac-normalize.js";
import { evaluateInfrastructureSecurity } from "./iac-security.js";
import { parseTerraformFiles } from "./iac-terraform.js";

export interface InfrastructureAnalysisInput {
  terraform_files: Readonly<Record<string, string>>;
  kubernetes_files: Readonly<Record<string, string>>;
  architecture_observations: readonly InfrastructureObservation[];
  architecture_references: readonly ParsedInfrastructureReference[];
  alias_rules: readonly IdentityAliasRule[];
}

export interface InfrastructureAnalysisResult {
  contract_version: "0.1";
  terraform: InfrastructureParseResult;
  kubernetes: InfrastructureParseResult;
  identities: CrossSourceIdentityMap;
  graph: NormalizedInfrastructureGraph;
  claims: ClassifiedEvidenceClaim[];
  security_findings: InfrastructureSecurityFinding[];
}

export function analyzeInfrastructureSources(
  input: InfrastructureAnalysisInput,
): InfrastructureAnalysisResult {
  const terraform = parseTerraformFiles(input.terraform_files);
  const kubernetes = parseKubernetesFiles(input.kubernetes_files);
  const observations = [
    ...input.architecture_observations,
    ...observationsFromParseResult(terraform),
    ...observationsFromParseResult(kubernetes),
  ];
  const references = [
    ...input.architecture_references,
    ...terraform.references,
    ...kubernetes.references,
  ];
  const diagnostics = [...terraform.diagnostics, ...kubernetes.diagnostics];
  const identities = mapCrossSourceIdentities(observations, input.alias_rules);
  const graph = buildNormalizedInfrastructureGraph(
    observations,
    references,
    diagnostics,
    input.alias_rules,
  );
  const claims = classifyEvidenceClaims(buildCrossSourceEvidenceClaims(graph));
  return {
    contract_version: "0.1",
    terraform,
    kubernetes,
    identities,
    graph,
    claims,
    security_findings: evaluateInfrastructureSecurity(graph),
  };
}
