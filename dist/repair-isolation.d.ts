export declare const repairIsolationAttestationSchemaVersion: "1.0.0-preparatory";
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
export interface RepairIsolationAttestation {
    schema_version: typeof repairIsolationAttestationSchemaVersion;
    capability_id: string;
    isolator_id: string;
    approval_id: string;
    workspace_sha256: string;
    filesystem_isolation: "ENFORCED";
    filesystem_scope: "SANDBOX_WORKSPACE_ONLY";
    network_isolation: "ENFORCED";
    process_execution: "DIRECT_ALLOWLISTED";
    issued_at: string;
    expires_at: string;
}
declare const repairIsolationCapabilityBrand: unique symbol;
/**
 * Opaque capability. A structurally similar caller object is not trusted at
 * runtime: accepted instances must also exist in this module's private issuer
 * registry and be bound to the exact disposable workspace.
 */
export interface RepairIsolationCapability {
    readonly [repairIsolationCapabilityBrand]: true;
    readonly attestation: Readonly<RepairIsolationAttestation>;
}
export interface FilesystemIsolatedCommandExecutor {
    readonly capability: RepairIsolationCapability;
    execute(invocation: ProcessInvocation): Promise<ProcessResult>;
}
export type RepairIsolationStatus = "APPROVED" | "TEST_ONLY" | "REJECTED";
export interface RepairIsolationEvidence {
    schema_version: typeof repairIsolationAttestationSchemaVersion;
    status: RepairIsolationStatus;
    reason: string | null;
    capability_id: string | null;
    isolator_id: string | null;
    approval_id: string | null;
    attestation_sha256: string | null;
}
export interface RepairIsolationAssessment {
    approved: boolean;
    evidence: RepairIsolationEvidence;
}
export declare function assessRepairIsolationCapability(executor: FilesystemIsolatedCommandExecutor | null | undefined, workspace: string, nowMs?: number): Promise<RepairIsolationAssessment>;
/**
 * Unit-test adapter only. It can register only TEST_ONLY evidence, requires a
 * Vitest process, and never turns a verifier decision into reviewable evidence.
 * No production APPROVED issuer is configured in this repository.
 */
export declare function createTestOnlyRepairIsolationExecutor(input: {
    workspace: string;
    execute: ProcessRunner;
    capability_id?: string;
    issued_at?: string;
    expires_at?: string;
    attestation_overrides?: Partial<RepairIsolationAttestation>;
}): Promise<FilesystemIsolatedCommandExecutor>;
export {};
//# sourceMappingURL=repair-isolation.d.ts.map