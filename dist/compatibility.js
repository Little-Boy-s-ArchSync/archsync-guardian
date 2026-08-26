import { ARCHITECTURE_CONTRACT_CURRENT_VERSION, ARCHITECTURE_CONTRACT_LEGACY_VERSION, ARCHITECTURE_CONTRACT_PREVIOUS_VERSION, CLI_JSON_CONTRACT_VERSION, CONFORMANCE_CONTRACT_VERSION, EVIDENCE_CONTRACT_VERSION, FINDING_CONTRACT_VERSION, GRAPH_CONTRACT_VERSION, isSupportedArchitectureContractVersion, SUPPORTED_ARCHITECTURE_CONTRACT_VERSIONS, unsupportedArchitectureContractVersionMessage, } from "@archsync/core";
import { findingContractVersion, guardianAnalyzerVersion, guardianResultContractVersion, observedGraphVersion, sourceEvidenceContractVersion, } from "./contracts.js";
export const coreDependencyProvenance = Object.freeze({
    package: "@archsync/core",
    package_version: "0.1.1",
    repository: "https://github.com/Little-Boy-s-ArchSync/archsync-core",
    source_commit: "1e8bbdd8342d833aad50e8fbcefde15d65a807e6",
    vendored_artifact: "vendor/archsync-core-0.1.1.tgz",
    vendored_sha256: "550051461cbd6774b8f92df82ba923c3c9a0b95d82cfe4a8f7f49e21c3697a13",
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