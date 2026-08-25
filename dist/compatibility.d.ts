import { CLI_JSON_CONTRACT_VERSION, CONFORMANCE_CONTRACT_VERSION, EVIDENCE_CONTRACT_VERSION, FINDING_CONTRACT_VERSION, GRAPH_CONTRACT_VERSION, type ArchitectureContractVersion } from "@archsync/core";
import { findingContractVersion, guardianAnalyzerVersion, guardianResultContractVersion, observedGraphVersion, sourceEvidenceContractVersion } from "./contracts.js";
export declare const coreDependencyProvenance: Readonly<{
    package: "@archsync/core";
    package_version: "0.1.1";
    repository: "https://github.com/Little-Boy-s-ArchSync/archsync-core";
    source_commit: "503b5fe97aa39a78d5e5de80b794a94508e106cc";
    source_pull_request: "https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/3";
    included_source_commits: {
        contract_compatibility: string;
        quality_goals: string;
    };
    vendored_artifact: "vendor/archsync-core-0.1.1-integration-503b5fe.tgz";
    vendored_sha256: "7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9";
    provenance_artifact: "vendor/archsync-core-0.1.1-integration-503b5fe.provenance.json";
    dependency_status: "upstream-integration-pr-open-unmerged";
}>;
export declare const coreGuardianContractMatrix: Readonly<{
    schema_version: 1;
    core: {
        architecture_model: {
            current: "0.1.1";
            previous: "0.1.0";
            legacy: "0.1";
            accepted: readonly ["0.1.1", "0.1.0", "0.1"];
        };
        graph: "1.0.0";
        finding: "1.0.0";
        evidence: "1.0.0";
        conformance: "1.0.0";
        cli_json: "1.0.0";
    };
    guardian: {
        analyzer: "0.2";
        observed_graph: "0.1";
        finding: "0.1";
        source_evidence: "0.1";
        source_evidence_version_carrier: string;
        result: "0.1";
    };
    ownership: {
        architecture_model_graph_and_decisions: string;
        source_detection_observed_graph_and_enrichment: string;
    };
}>;
export interface GuardianCoreContractSelection {
    core_architecture_model: ArchitectureContractVersion;
    core_graph: typeof GRAPH_CONTRACT_VERSION;
    core_finding: typeof FINDING_CONTRACT_VERSION;
    core_evidence: typeof EVIDENCE_CONTRACT_VERSION;
    core_conformance: typeof CONFORMANCE_CONTRACT_VERSION;
    core_cli_json: typeof CLI_JSON_CONTRACT_VERSION;
    guardian_analyzer: typeof guardianAnalyzerVersion;
    guardian_observed_graph: typeof observedGraphVersion;
    guardian_finding: typeof findingContractVersion;
    guardian_source_evidence: typeof sourceEvidenceContractVersion;
    guardian_result: typeof guardianResultContractVersion;
}
export declare function guardianContractsForCoreArchitecture(version: unknown): GuardianCoreContractSelection;
//# sourceMappingURL=compatibility.d.ts.map