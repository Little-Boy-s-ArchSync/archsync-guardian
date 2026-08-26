export declare const infrastructureContractVersion: "0.1";
export declare const infrastructureGraphVersion: "0.1";
export type InfrastructureSource = "spec" | "code" | "terraform" | "kubernetes";
export type EvidenceSourceClass = "spec" | "code" | "iac";
export type InfrastructureKind = "workload" | "service" | "ingress" | "database" | "cache" | "broker" | "configuration" | "unknown";
export type InfrastructureExposure = "public" | "private" | "internal" | "unknown";
export interface TextPosition {
    line: number;
    column: number;
    offset: number;
}
export interface TextRange {
    start: TextPosition;
    end: TextPosition;
}
export interface InfrastructureEvidence {
    source: InfrastructureSource;
    file: string;
    range: TextRange;
    snippet: string;
    detector: string;
    confidence: number;
}
export type InfrastructureDiagnosticCode = "malformed-document" | "unsupported-block" | "unsupported-dynamic-expression" | "unsupported-resource" | "missing-identity" | "missing-reference" | "ambiguous-reference";
export interface InfrastructureDiagnostic {
    code: InfrastructureDiagnosticCode;
    severity: "warning" | "error";
    message: string;
    evidence: InfrastructureEvidence;
}
export type InfrastructureAttribute = string | number | boolean | readonly string[];
export interface ParsedInfrastructureResource {
    source: "terraform" | "kubernetes";
    id: string;
    native_type: string;
    name: string;
    namespace: string;
    kind: InfrastructureKind;
    provider: string;
    aliases: string[];
    exposure: InfrastructureExposure;
    managed: boolean;
    approved: boolean;
    trust_boundary: string;
    attributes: Record<string, InfrastructureAttribute>;
    evidence: InfrastructureEvidence[];
}
export type InfrastructureReferenceType = "selects" | "routes-to" | "configures" | "connects-to" | "depends-on";
export interface ParsedInfrastructureReference {
    source: "terraform" | "kubernetes";
    from: string;
    to: string;
    type: InfrastructureReferenceType;
    resolved: boolean;
    approved_trust_transition: boolean;
    evidence: InfrastructureEvidence[];
}
export interface InfrastructureParseResult {
    resources: ParsedInfrastructureResource[];
    references: ParsedInfrastructureReference[];
    diagnostics: InfrastructureDiagnostic[];
}
export interface InfrastructureObservation {
    source: InfrastructureSource;
    source_class: EvidenceSourceClass;
    native_id: string;
    name: string;
    namespace: string;
    aliases: string[];
    kind: InfrastructureKind;
    exposure: InfrastructureExposure;
    approved: boolean;
    trust_boundary: string;
    attributes: Record<string, InfrastructureAttribute>;
    evidence: InfrastructureEvidence[];
}
export interface IdentityAliasRule {
    canonical_id: string;
    namespace: string;
    aliases: readonly string[];
}
export type IdentityResolutionMethod = "explicit-alias" | "namespace-and-name" | "name-only" | "ambiguous" | "unknown";
export interface IdentityResolution {
    observation_key: string;
    canonical_id: string;
    method: IdentityResolutionMethod;
    confidence: number;
    evidence: InfrastructureEvidence[];
}
export interface CrossSourceIdentityMap {
    contract_version: typeof infrastructureContractVersion;
    resolutions: IdentityResolution[];
    unknowns: IdentityResolution[];
}
export interface NormalizedInfrastructureNode {
    id: string;
    kind: InfrastructureKind;
    namespace: string;
    aliases: string[];
    exposure: InfrastructureExposure;
    approved: boolean;
    trust_boundary: string;
    sources: EvidenceSourceClass[];
    observations: InfrastructureObservation[];
    evidence: InfrastructureEvidence[];
}
export interface NormalizedInfrastructureEdge {
    key: string;
    from: string;
    to: string;
    type: InfrastructureReferenceType;
    resolved: boolean;
    approved_trust_transition: boolean;
    sources: InfrastructureSource[];
    evidence: InfrastructureEvidence[];
}
export interface NormalizedInfrastructureGraph {
    version: typeof infrastructureGraphVersion;
    identity_contract_version: typeof infrastructureContractVersion;
    nodes: NormalizedInfrastructureNode[];
    edges: NormalizedInfrastructureEdge[];
    diagnostics: InfrastructureDiagnostic[];
}
export type EvidenceClaimProperty = "identity" | "kind" | "exposure" | "trust-boundary";
export interface EvidenceClaimValue {
    source: EvidenceSourceClass;
    value: string;
    evidence: InfrastructureEvidence[];
}
export interface CrossSourceEvidenceClaim {
    id: string;
    subject: string;
    property: EvidenceClaimProperty;
    values: EvidenceClaimValue[];
    missing_sources: EvidenceSourceClass[];
    evidence: InfrastructureEvidence[];
}
export type ConflictClassification = "aligned" | "contradiction" | "missing-source" | "identity-uncertain";
export interface ClassifiedEvidenceClaim extends CrossSourceEvidenceClaim {
    classification: ConflictClassification;
    confidence: number;
    reason: string;
}
export type InfrastructureSecurityRuleId = "IAC-PUBLIC-DATABASE" | "IAC-UNEXPECTED-INGRESS" | "IAC-TRUST-BOUNDARY" | "IAC-UNAPPROVED-DATA-SERVICE";
export interface InfrastructureSecurityFinding {
    id: string;
    rule_id: InfrastructureSecurityRuleId;
    severity: "high" | "critical";
    message: string;
    subject: string;
    edge: string;
    evidence: InfrastructureEvidence[];
}
//# sourceMappingURL=iac-contracts.d.ts.map