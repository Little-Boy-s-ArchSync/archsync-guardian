import { type BenchmarkCase } from "@archsync/core";
import { checkRepository } from "./guardian.js";
import type { SourceEvidence } from "./contracts.js";
export interface DetectionCounts {
    true_positive: number;
    false_positive: number;
    false_negative: number;
    precision: number;
    recall: number;
    f1: number;
}
export interface Phase2CaseResult {
    id: string;
    expected: BenchmarkCase["expected"]["classification"];
    actual: BenchmarkCase["expected"]["classification"];
    classification_match: boolean;
    expected_rule_ids: string[];
    actual_rule_ids: string[];
    rule_match: boolean;
    expected_added_nodes: string[];
    actual_added_nodes: string[];
    expected_removed_nodes: string[];
    actual_removed_nodes: string[];
    expected_added_edges: string[];
    actual_added_edges: string[];
    expected_removed_edges: string[];
    actual_removed_edges: string[];
    evidence_file_match: boolean;
    evidence_line_match: boolean;
    expected_evidence: Array<{
        file: string;
        line: number;
    }>;
    actual_evidence: SourceEvidence[];
    deterministic: boolean;
}
export interface Phase2BenchmarkResult {
    contract_version: "0.1";
    benchmark: string;
    valid: boolean;
    issues: string[];
    baseline: {
        components: number;
        relationships: number;
        deterministic: boolean;
        classification: string;
    };
    metrics: {
        full_graph_nodes: DetectionCounts;
        full_graph_edges: DetectionCounts;
        changed_nodes: DetectionCounts;
        changed_edges: DetectionCounts;
        classification_accuracy: number;
        evidence_file_accuracy: number;
        evidence_line_accuracy: number;
        deterministic_cases: number;
        total_cases: number;
    };
    cases: Phase2CaseResult[];
}
export declare function evaluatePhase2Benchmark(manifestPath: string, dependencies?: {
    checkRepository?: typeof checkRepository;
}): Promise<Phase2BenchmarkResult>;
export declare function formatBenchmarkResult(result: Phase2BenchmarkResult): string;
//# sourceMappingURL=benchmark.d.ts.map