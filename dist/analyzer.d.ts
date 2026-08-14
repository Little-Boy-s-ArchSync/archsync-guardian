import type { ArchitectureDocument } from "@archsync/core";
import type { ObservedArchitecture } from "./contracts.js";
export interface AnalyzeTypeScriptOptions {
    /**
     * Limit parsing to source components affected by a Git diff. The returned
     * graph is intentionally partial and must be merged with a cached baseline
     * before conformance evaluation.
     */
    component_ids?: readonly string[];
}
export declare function analyzeTypeScriptRepository(repositoryPath: string, expected: ArchitectureDocument, options?: AnalyzeTypeScriptOptions): Promise<ObservedArchitecture>;
//# sourceMappingURL=analyzer.d.ts.map