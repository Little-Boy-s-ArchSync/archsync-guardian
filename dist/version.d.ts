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
        core_model: "0.1";
        guardian_analyzer: "0.2";
        git_gate: "0.3";
        finding: "0.1";
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