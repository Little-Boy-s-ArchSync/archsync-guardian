import type { GuardianFinding, GuardianResult } from "./contracts.js";
export declare const repairCandidateSchemaVersion: "0.1.0-preparatory";
export declare const repairVerificationSchemaVersion: "0.1.0-preparatory";
export declare const defaultSandboxCommandAllowlist: readonly ["bun", "bun.exe", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"];
export type RepairVerificationDecision = "ACCEPTABLE_FOR_REVIEW" | "REJECT_TEST" | "REJECT_CONFORMANCE" | "REJECT_UNSAFE" | "INCONCLUSIVE";
export type RepairSafetyCode = "INVALID_CANDIDATE" | "INVALID_PATH" | "RESERVED_PATH" | "BINARY_PATCH" | "UNSUPPORTED_PATCH" | "UNEXPECTED_PATH" | "DIRTY_WORKSPACE" | "SYMLINK_PATH" | "PATCH_DOES_NOT_APPLY" | "PATCH_APPLY_FAILED" | "PATCH_NO_EFFECT";
export interface RepairFileExpectation {
    path: string;
    base_sha256: string | null;
}
/**
 * Preparatory P4-103 hand-off. Generation may propose this value, but only the
 * deterministic verifier in this module may classify it as reviewable.
 */
export interface RepairCandidate {
    schema_version: typeof repairCandidateSchemaVersion;
    candidate_id: string;
    target_block_finding_fingerprints: string[];
    files: RepairFileExpectation[];
    unified_diff: string;
}
export interface PatchValidationSuccess {
    ok: true;
    paths: string[];
}
export interface PatchValidationFailure {
    ok: false;
    code: RepairSafetyCode;
    message: string;
}
export type PatchValidationResult = PatchValidationSuccess | PatchValidationFailure;
export interface RepairSandbox {
    root: string;
    workspace: string;
    resolve_path(relativePath: string): string;
    cleanup(): Promise<void>;
}
export interface ProcessInvocation {
    command: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeout_ms: number;
    max_output_bytes: number;
}
export interface ProcessResult {
    exit_code: number | null;
    stdout: string;
    stderr: string;
    timed_out: boolean;
    infrastructure_error?: string;
}
export type ProcessRunner = (invocation: ProcessInvocation) => Promise<ProcessResult>;
export interface NoNetworkCommandExecutor {
    network_isolation: "ENFORCED";
    execute(invocation: ProcessInvocation): Promise<ProcessResult>;
}
export interface SandboxCommand {
    command: string;
    args: string[];
}
export interface ProjectTestResult {
    status: "PASS" | "FAIL" | "TIMEOUT" | "INCONCLUSIVE";
    command: string;
    args: string[];
    exit_code: number | null;
    duration_ms: number;
    stdout: string;
    stderr: string;
    reason?: string;
}
export interface PatchApplySuccess {
    status: "APPLIED";
    paths: string[];
    before_sha256: Record<string, string | null>;
    after_sha256: Record<string, string | null>;
}
export interface PatchApplyFailure {
    status: "REJECTED" | "INCONCLUSIVE";
    code: RepairSafetyCode | "GIT_UNAVAILABLE" | "NOT_ATTEMPTED";
    message: string;
    paths: string[];
}
export type PatchApplyResult = PatchApplySuccess | PatchApplyFailure;
export interface RepairConformanceComplete {
    status: "COMPLETE";
    decision: "PASS" | "BLOCK" | "REVIEW";
    block_finding_fingerprints: string[];
}
export interface RepairConformanceError {
    status: "ERROR";
    message: string;
}
export type RepairConformanceSnapshot = RepairConformanceComplete | RepairConformanceError;
export type RepairRecheck = (workspace: string, stage: "BASELINE" | "CANDIDATE") => Promise<RepairConformanceSnapshot>;
export interface RepairConformanceComparison {
    baseline_block_finding_fingerprints: string[];
    candidate_block_finding_fingerprints: string[];
    missing_target_finding_fingerprints: string[];
    remaining_target_finding_fingerprints: string[];
    new_block_finding_fingerprints: string[];
}
export interface RepairDecisionInput {
    patch_status: PatchApplyResult["status"];
    tests_status?: ProjectTestResult["status"];
    recheck_complete: boolean;
    missing_targets: number;
    remaining_targets: number;
    new_blocks: number;
}
export interface RepairDecision {
    decision: RepairVerificationDecision;
    reason: string;
}
export interface RepairVerificationResult {
    schema_version: typeof repairVerificationSchemaVersion;
    candidate_id: string;
    decision: RepairVerificationDecision;
    reason: string;
    patch: PatchApplyResult;
    tests: ProjectTestResult | null;
    conformance: RepairConformanceComparison | null;
    sandbox_cleanup: "COMPLETED" | "NOT_CREATED" | "FAILED";
}
export interface VerifyRepairOptions {
    source_root: string;
    candidate: RepairCandidate;
    recheck: RepairRecheck;
    test_command?: SandboxCommand;
    command_executor?: NoNetworkCommandExecutor | null;
    process_runner?: ProcessRunner;
    sandbox_factory?: typeof createRepairSandbox;
    temp_parent?: string;
    timeout_ms?: number;
    sensitive_values?: string[];
}
export declare function resolveSandboxPath(root: string, relativePath: string): string;
export declare function shouldCopySandboxEntry(relativePath: string): boolean;
export declare function createRepairSandbox(sourceRoot: string, options?: {
    temp_parent?: string;
    copy_tree?: (source: string, destination: string) => Promise<void>;
}): Promise<RepairSandbox>;
export declare function validateRepairCandidate(candidate: RepairCandidate): PatchValidationResult;
export declare function executeProcess(invocation: ProcessInvocation): Promise<ProcessResult>;
export declare function networkSandboxInvocation(platform: NodeJS.Platform, command: string, args: string[]): {
    command: string;
    args: string[];
} | undefined;
export declare function createPlatformNoNetworkExecutor(platform?: NodeJS.Platform, runner?: ProcessRunner): NoNetworkCommandExecutor | undefined;
export declare function sandboxEnvironment(workspace: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function sanitizeVerificationLog(value: string, sandboxRoot: string, sensitiveValues?: string[], maximumBytes?: number): string;
export declare function runSandboxCommand(sandbox: RepairSandbox, command: SandboxCommand, options?: {
    executor?: NoNetworkCommandExecutor | null;
    allowlist?: readonly string[];
    timeout_ms?: number;
    sensitive_values?: string[];
}): Promise<ProjectTestResult>;
export declare function detectProjectTestCommand(workspace: string): Promise<SandboxCommand | undefined>;
export declare function runProjectTests(sandbox: RepairSandbox, options?: {
    command?: SandboxCommand;
    executor?: NoNetworkCommandExecutor | null;
    timeout_ms?: number;
    sensitive_values?: string[];
}): Promise<ProjectTestResult>;
export declare function gitEnvironment(platform?: NodeJS.Platform): NodeJS.ProcessEnv;
export declare function applyRepairCandidate(sandbox: RepairSandbox, candidate: RepairCandidate, runner?: ProcessRunner): Promise<PatchApplyResult>;
export declare function guardianFindingFingerprint(finding: GuardianFinding): string;
export declare function guardianResultToRepairSnapshot(result: GuardianResult): RepairConformanceComplete;
export declare function normalizeRepairConformanceSnapshot(snapshot: RepairConformanceSnapshot): RepairConformanceSnapshot;
export declare function compareRepairConformance(targets: string[], baseline: RepairConformanceComplete, candidate: RepairConformanceComplete): RepairConformanceComparison;
export declare function decideRepairVerification(input: RepairDecisionInput): RepairDecision;
export declare function verifyRepairCandidate(options: VerifyRepairOptions): Promise<RepairVerificationResult>;
//# sourceMappingURL=repair-verification.d.ts.map