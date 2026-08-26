import { type ClassifiedEvidenceClaim, type CrossSourceEvidenceClaim, type CrossSourceIdentityMap, type IdentityAliasRule, type InfrastructureDiagnostic, type InfrastructureObservation, type InfrastructureParseResult, type NormalizedInfrastructureGraph, type ParsedInfrastructureReference } from "./iac-contracts.js";
export declare function observationsFromParseResult(result: InfrastructureParseResult): InfrastructureObservation[];
export declare function mapCrossSourceIdentities(observations: readonly InfrastructureObservation[], aliasRules?: readonly IdentityAliasRule[]): CrossSourceIdentityMap;
export declare function buildNormalizedInfrastructureGraph(observations: readonly InfrastructureObservation[], references: readonly ParsedInfrastructureReference[], diagnostics?: readonly InfrastructureDiagnostic[], aliasRules?: readonly IdentityAliasRule[]): NormalizedInfrastructureGraph;
export declare function buildCrossSourceEvidenceClaims(graph: NormalizedInfrastructureGraph): CrossSourceEvidenceClaim[];
export declare function classifyEvidenceClaim(claim: CrossSourceEvidenceClaim): ClassifiedEvidenceClaim;
export declare function classifyEvidenceClaims(claims: readonly CrossSourceEvidenceClaim[]): ClassifiedEvidenceClaim[];
//# sourceMappingURL=iac-normalize.d.ts.map