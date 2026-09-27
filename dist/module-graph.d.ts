import type { ArchitectureDocument } from "@archsync/core";
import ts from "typescript";
/** Separate from Guardian's service graph and its cache/version contract. */
export declare const moduleAdapterVersion = "0.1.0";
export interface ModuleLocation {
    file: string;
    line: number;
    column: number;
}
export interface ModuleReference extends ModuleLocation {
    specifier: string;
    syntax: "import" | "export";
    type_only: boolean;
}
export interface ModuleGraph {
    schema_version: "0.1.0";
    adapter: "archsync-static-esm";
    adapter_version: string;
    typescript_version: string;
    scope: "configured-internal-typescript-static-esm";
    status: "complete-within-scope" | "incomplete";
    modules: {
        id: string;
        file: string;
        sha256: string;
    }[];
    edges: {
        from: string;
        to: string;
        evidence: ModuleReference[];
    }[];
    exclusions: (ModuleReference & {
        reason: "builtin" | "external-package" | "declaration-only";
    })[];
    issues: (ModuleLocation & {
        code: string;
        message: string;
    })[];
    /** Files actually read for config/resolution/parsing; not an independent truth oracle. */
    inputs: {
        file: string;
        sha256: string;
    }[];
}
/** IDs are path identities, not names inferred from author-supplied labels. */
export declare function moduleId(file: string): string;
export declare function moduleDiagnosticLocation(source: ts.SourceFile, file: string, diagnostic: Pick<ts.Diagnostic, "start">): ModuleLocation;
/**
 * Reads source/config only. Does not execute repository code or download packages.
 * Local ESM imports and re-exports (including type-only forms) are syntax edges,
 * not runtime-call edges. Unsupported/unresolved constructs prevent a complete
 * result; external packages, builtins and declaration-only targets are counted
 * explicitly outside the internal-source comparison population.
 */
export declare function analyzeModuleProject(configPath: string, repositoryRoot?: string): ModuleGraph;
/** Produces a distinct module-level Core model, never remaps service edges. */
export declare function moduleArchitecture(graph: ModuleGraph): ArchitectureDocument;
//# sourceMappingURL=module-graph.d.ts.map