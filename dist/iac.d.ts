import type { ClassifiedEvidenceClaim, CrossSourceIdentityMap, IdentityAliasRule, InfrastructureObservation, InfrastructureParseResult, InfrastructureSecurityFinding, NormalizedInfrastructureGraph, ParsedInfrastructureReference } from "./iac-contracts.js";
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
export declare function analyzeInfrastructureSources(input: InfrastructureAnalysisInput): InfrastructureAnalysisResult;
//# sourceMappingURL=iac.d.ts.map