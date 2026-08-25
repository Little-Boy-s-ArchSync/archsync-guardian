export interface PackageProvenance {
    schema_version: 1;
    package_name: string;
    package_version: string;
    source_commit: string;
    package_content_sha256: string;
}
export interface VersionResult {
    cli: {
        name: "ArchSync CLI";
        package: string;
        version: string;
    };
    contracts: {
        core_model: "0.1.1";
        core_model_previous: "0.1.0";
        core_model_legacy: "0.1";
        core_model_accepted: readonly ["0.1.1", "0.1.0", "0.1"];
        core_graph: "1.0.0";
        core_finding: "1.0.0";
        core_evidence: "1.0.0";
        core_conformance: "1.0.0";
        core_cli_json: "1.0.0";
        guardian_analyzer: "0.2";
        guardian_observed_graph: "0.1";
        git_gate: "0.3";
        guardian_finding: "0.1";
        guardian_source_evidence: "0.1";
        /** @deprecated Use guardian_finding. */
        finding: "0.1";
        /** @deprecated Use guardian_source_evidence. */
        source_evidence: "0.1";
        guardian_result: "0.1";
    };
    dependencies: {
        core: {
            package: "@archsync/core";
            package_version: "0.1.1";
            repository: string;
            source_commit: string;
            vendored_artifact: string;
            vendored_sha256: string;
        };
    };
    provenance: {
        mode: "package" | "source-tree";
        source_commit: string | null;
        package_content_sha256: string;
        integrity: "verified" | "source-tree";
    };
}
export declare const defaultPackageRoot: string;
export declare function computePackageContentSha256(root: string): Promise<string>;
export declare function createPackageProvenance(root?: string, sourceCommit?: string | null): Promise<PackageProvenance>;
export declare function loadVersionResult(root?: string): Promise<VersionResult>;
export declare function formatVersionResult(result: VersionResult): string;
//# sourceMappingURL=version.d.ts.map