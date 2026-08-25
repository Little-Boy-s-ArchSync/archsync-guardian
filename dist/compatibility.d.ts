import { CLI_JSON_CONTRACT_VERSION, CONFORMANCE_CONTRACT_VERSION, EVIDENCE_CONTRACT_VERSION, FINDING_CONTRACT_VERSION, GRAPH_CONTRACT_VERSION, type ArchitectureContractVersion } from "@archsync/core";
import { findingContractVersion, guardianAnalyzerVersion, guardianResultContractVersion, observedGraphVersion, sourceEvidenceContractVersion } from "./contracts.js";
export declare const coreDependencyProvenance: Readonly<{
    package: "@archsync/core";
    package_version: "0.1.1";
    repository: "https://github.com/Little-Boy-s-ArchSync/archsync-core";
    source_commit: "a1f0143aa8eb917aa0d93e28101b1893347453e2";
    vendored_artifact: "vendor/archsync-core-0.1.1.tgz";
    vendored_sha256: "60a00d267fc217922659b5c527067a7d7792cdf40d3e6f81219c5f7328bd6f80";
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