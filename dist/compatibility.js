import { ARCHITECTURE_CONTRACT_CURRENT_VERSION, ARCHITECTURE_CONTRACT_LEGACY_VERSION, ARCHITECTURE_CONTRACT_PREVIOUS_VERSION, CLI_JSON_CONTRACT_VERSION, CONFORMANCE_CONTRACT_VERSION, EVIDENCE_CONTRACT_VERSION, FINDING_CONTRACT_VERSION, GRAPH_CONTRACT_VERSION, isSupportedArchitectureContractVersion, SUPPORTED_ARCHITECTURE_CONTRACT_VERSIONS, unsupportedArchitectureContractVersionMessage, } from "@archsync/core";
import { findingContractVersion, guardianAnalyzerVersion, guardianResultContractVersion, observedGraphVersion, sourceEvidenceContractVersion, } from "./contracts.js";
export const coreDependencyProvenance = Object.freeze({
    package: "@archsync/core",
    package_version: "0.1.1",
    repository: "https://github.com/Little-Boy-s-ArchSync/archsync-core",
    source_commit: "503b5fe97aa39a78d5e5de80b794a94508e106cc",
    source_pull_request: "https://github.com/Little-Boy-s-ArchSync/archsync-core/pull/3",
    included_source_commits: {
        contract_compatibility: "a1f0143aa8eb917aa0d93e28101b1893347453e2",
        quality_goals: "783716d7961690b1e8c1cda4acb956777977a853",
    },
    vendored_artifact: "vendor/archsync-core-0.1.1-integration-503b5fe.tgz",
    vendored_sha256: "7f6c2db24888d8e4bf6eb6dd2cc2d0abaaf2fc908e2b43937aec40d163b05fc9",
    provenance_artifact: "vendor/archsync-core-0.1.1-integration-503b5fe.provenance.json",
    dependency_status: "upstream-integration-pr-open-unmerged",
});
export const coreGuardianContractMatrix = Object.freeze({
    schema_version: 1,
    core: {
        architecture_model: {
            current: ARCHITECTURE_CONTRACT_CURRENT_VERSION,
            previous: ARCHITECTURE_CONTRACT_PREVIOUS_VERSION,
            legacy: ARCHITECTURE_CONTRACT_LEGACY_VERSION,
            accepted: SUPPORTED_ARCHITECTURE_CONTRACT_VERSIONS,
        },
        graph: GRAPH_CONTRACT_VERSION,
        finding: FINDING_CONTRACT_VERSION,
        evidence: EVIDENCE_CONTRACT_VERSION,
        conformance: CONFORMANCE_CONTRACT_VERSION,
        cli_json: CLI_JSON_CONTRACT_VERSION,
    },
    guardian: {
        analyzer: guardianAnalyzerVersion,
        observed_graph: observedGraphVersion,
        finding: findingContractVersion,
        source_evidence: sourceEvidenceContractVersion,
        source_evidence_version_carrier: "observed-or-finding-envelope",
        result: guardianResultContractVersion,
    },
    ownership: {
        architecture_model_graph_and_decisions: "core",
        source_detection_observed_graph_and_enrichment: "guardian",
    },
});
export function guardianContractsForCoreArchitecture(version) {
    if (!isSupportedArchitectureContractVersion(version)) {
        const detail = unsupportedArchitectureContractVersionMessage(version);
        throw new Error(detail ??
            `Unsupported architecture contract version '${String(version)}'. ` +
                `Supported versions: ${SUPPORTED_ARCHITECTURE_CONTRACT_VERSIONS.join(", ")}.`);
    }
    return {
        core_architecture_model: version,
        core_graph: GRAPH_CONTRACT_VERSION,
        core_finding: FINDING_CONTRACT_VERSION,
        core_evidence: EVIDENCE_CONTRACT_VERSION,
        core_conformance: CONFORMANCE_CONTRACT_VERSION,
        core_cli_json: CLI_JSON_CONTRACT_VERSION,
        guardian_analyzer: guardianAnalyzerVersion,
        guardian_observed_graph: observedGraphVersion,
        guardian_finding: findingContractVersion,
        guardian_source_evidence: sourceEvidenceContractVersion,
        guardian_result: guardianResultContractVersion,
    };
}
//# sourceMappingURL=compatibility.js.map