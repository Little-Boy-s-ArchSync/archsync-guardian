import { type ArchitectureDocument } from "@archsync/core";
import { type GuardianFinding, type ObservedArchitecture } from "./contracts.js";
export interface ChangedLineRange {
    start: number;
    end: number;
}
export interface ChangedFile {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    previous_path?: string;
    additions: number;
    deletions: number;
    changed_lines: ChangedLineRange[];
}
export interface Phase3Options {
    base_ref?: string;
    cache_dir?: string;
    use_cache?: boolean;
}
export interface Phase3Result {
    contract_version: "0.1";
    mode: "git-diff";
    classification: "no-impact" | "violation" | "evolution";
    decision: "PASS" | "BLOCK" | "REVIEW";
    repository: {
        root: string;
        base_ref: string;
        base_sha: string;
        head_sha: string;
        worktree_dirty: boolean;
    };
    changed_files: ChangedFile[];
    affected_components: string[];
    architecture_delta: {
        added_nodes: string[];
        removed_nodes: string[];
        changed_nodes: string[];
        added_edges: string[];
        removed_edges: string[];
    };
    introduced_findings: GuardianFinding[];
    resolved_findings: GuardianFinding[];
    baseline: {
        classification: "no-impact" | "violation" | "evolution";
        decision: "PASS" | "BLOCK" | "REVIEW";
        findings: number;
    };
    head: {
        classification: "no-impact" | "violation" | "evolution";
        decision: "PASS" | "BLOCK" | "REVIEW";
        findings: number;
    };
    pre_existing_findings: number;
    cache: {
        hit: boolean;
        key: string;
    };
    analysis: {
        strategy: "cached-component-incremental";
        baseline_scanned_files: number;
        incremental_scanned_files: number;
        head_scanned_files: number;
        analyzed_components: number;
        baseline_load_ms: number;
        incremental_scan_ms: number;
        total_ms: number;
    };
}
export declare function mergeIncrementalObservedArchitecture(baseline: ObservedArchitecture, partial: ObservedArchitecture, affectedComponents: readonly string[]): ObservedArchitecture;
export declare function checkRepositoryDiff(expected: ArchitectureDocument, repositoryPath: string, options?: Phase3Options): Promise<Phase3Result>;
export declare function formatPhase3Result(result: Phase3Result): string;
export declare function formatPhase3Markdown(result: Phase3Result): string;
export declare function formatGitHubAnnotations(result: Phase3Result): string;
export declare function appendGitHubStepSummary(result: Phase3Result, outputPath?: string | undefined): Promise<boolean>;
//# sourceMappingURL=phase3.d.ts.map