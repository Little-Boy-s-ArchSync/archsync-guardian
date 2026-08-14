import { type Phase3Result } from "./phase3.js";
type DemoDecision = "PASS" | "BLOCK" | "REVIEW";
export interface DemoOptions {
    benchmark?: string;
    scenario?: string;
    json?: boolean;
    verbose?: boolean;
    report?: string;
    interactive?: boolean;
}
export interface DemoCaseResult {
    case_id: string;
    title: string;
    expected_decision: DemoDecision;
    actual_decision: DemoDecision;
    match: boolean;
    cache: {
        cold: "HIT" | "MISS";
        warm: "HIT" | "MISS";
    };
    changed_files_match: boolean;
    result: Phase3Result;
}
export interface DemoResult {
    ok: boolean;
    benchmark: string;
    cases: DemoCaseResult[];
}
export declare function runDemo(options?: DemoOptions): Promise<DemoResult>;
export declare function formatDemoResult(result: DemoResult, verbose?: boolean): string;
export declare function formatDemoMarkdown(result: DemoResult): string;
export {};
//# sourceMappingURL=demo.d.ts.map