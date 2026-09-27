export declare const moduleDependencyAnalyzerVersion: "0.1.0-development";
export interface ModuleGroupMapping {
    component: string;
    prefix: string;
}
export interface ModuleDependencyEvidence {
    file: string;
    line: number;
    column: number;
    specifier: string;
    target_file: string;
    syntax: "import" | "export" | "require" | "dynamic-import";
}
export interface ModuleDependencyEdge {
    from: string;
    to: string;
    type: "dependency";
    evidence: ModuleDependencyEvidence[];
}
export interface ModuleDependencyUnresolved {
    file: string;
    line: number;
    column: number;
    specifier: string;
    reason: "unresolved-local-target" | "unresolved-package-or-alias" | "resolved-outside-verified-tree";
}
export interface ModuleDependencyResult {
    analyzer: {
        id: "archsync-module-dependencies";
        version: typeof moduleDependencyAnalyzerVersion;
    };
    scanned_files: number;
    edges: ModuleDependencyEdge[];
    unresolved: ModuleDependencyUnresolved[];
    limitations: string[];
}
/** Read-only development adapter. No D3 run, prediction or accuracy claim is implied. */
export declare function analyzeModuleDependencies(repository: string, mappings: readonly ModuleGroupMapping[]): Promise<ModuleDependencyResult>;
//# sourceMappingURL=module-dependencies.d.ts.map