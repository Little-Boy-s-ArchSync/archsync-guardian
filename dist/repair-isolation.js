import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
export const repairIsolationAttestationSchemaVersion = "1.0.0-preparatory";
const maximumCapabilityLifetimeMs = 15 * 60 * 1_000;
const capabilityIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const issuedExecutors = new WeakMap();
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function canonicalAttestation(attestation) {
    return JSON.stringify({
        schema_version: attestation.schema_version,
        capability_id: attestation.capability_id,
        isolator_id: attestation.isolator_id,
        approval_id: attestation.approval_id,
        workspace_sha256: attestation.workspace_sha256,
        filesystem_isolation: attestation.filesystem_isolation,
        filesystem_scope: attestation.filesystem_scope,
        network_isolation: attestation.network_isolation,
        process_execution: attestation.process_execution,
        issued_at: attestation.issued_at,
        expires_at: attestation.expires_at,
    });
}
function rejected(reason) {
    return {
        approved: false,
        evidence: {
            schema_version: repairIsolationAttestationSchemaVersion,
            status: "REJECTED",
            reason,
            capability_id: null,
            isolator_id: null,
            approval_id: null,
            attestation_sha256: null,
        },
    };
}
function canonicalTimestamp(value) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}
export async function assessRepairIsolationCapability(executor, workspace, nowMs = Date.now()) {
    if (!executor || typeof executor !== "object") {
        return rejected("FILESYSTEM_ISOLATION_CAPABILITY_REQUIRED");
    }
    const issued = issuedExecutors.get(executor);
    if (!issued)
        return rejected("FILESYSTEM_ISOLATION_CAPABILITY_UNTRUSTED");
    const attestation = issued.attestation;
    const issuedAt = canonicalTimestamp(attestation.issued_at);
    const expiresAt = canonicalTimestamp(attestation.expires_at);
    if (attestation.schema_version !== repairIsolationAttestationSchemaVersion ||
        !capabilityIdPattern.test(attestation.capability_id) ||
        !capabilityIdPattern.test(attestation.isolator_id) ||
        !capabilityIdPattern.test(attestation.approval_id) ||
        !/^[a-f0-9]{64}$/u.test(attestation.workspace_sha256) ||
        attestation.filesystem_isolation !== "ENFORCED" ||
        attestation.filesystem_scope !== "SANDBOX_WORKSPACE_ONLY" ||
        attestation.network_isolation !== "ENFORCED" ||
        attestation.process_execution !== "DIRECT_ALLOWLISTED" ||
        issuedAt === undefined ||
        expiresAt === undefined ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > maximumCapabilityLifetimeMs) {
        return rejected("FILESYSTEM_ISOLATION_ATTESTATION_INVALID");
    }
    if (issuedAt > nowMs)
        return rejected("FILESYSTEM_ISOLATION_CAPABILITY_NOT_YET_VALID");
    if (expiresAt <= nowMs)
        return rejected("FILESYSTEM_ISOLATION_CAPABILITY_EXPIRED");
    let actualWorkspaceHash;
    try {
        actualWorkspaceHash = sha256(await realpath(workspace));
    }
    catch {
        return rejected("FILESYSTEM_ISOLATION_WORKSPACE_UNAVAILABLE");
    }
    if (actualWorkspaceHash !== attestation.workspace_sha256) {
        return rejected("FILESYSTEM_ISOLATION_WORKSPACE_MISMATCH");
    }
    return {
        approved: false,
        evidence: {
            schema_version: repairIsolationAttestationSchemaVersion,
            status: "TEST_ONLY",
            reason: "FILESYSTEM_ISOLATION_TEST_ONLY",
            capability_id: attestation.capability_id,
            isolator_id: attestation.isolator_id,
            approval_id: attestation.approval_id,
            attestation_sha256: sha256(canonicalAttestation(attestation)),
        },
    };
}
/**
 * Unit-test adapter only. It can register only TEST_ONLY evidence, requires a
 * Vitest process, and never turns a verifier decision into reviewable evidence.
 * No production APPROVED issuer is configured in this repository.
 */
export async function createTestOnlyRepairIsolationExecutor(input) {
    if (process.env.VITEST !== "true") {
        throw new Error("The TEST_ONLY isolation adapter is available only inside Vitest");
    }
    const issuedAt = input.issued_at ?? new Date(Date.now() - 1_000).toISOString();
    const expiresAt = input.expires_at ?? new Date(Date.now() + 60_000).toISOString();
    const attestation = Object.freeze({
        schema_version: repairIsolationAttestationSchemaVersion,
        capability_id: input.capability_id ?? "test-only-capability",
        isolator_id: "test-only-in-process-adapter",
        approval_id: "test-only-not-an-approval",
        workspace_sha256: sha256(await realpath(input.workspace)),
        filesystem_isolation: "ENFORCED",
        filesystem_scope: "SANDBOX_WORKSPACE_ONLY",
        network_isolation: "ENFORCED",
        process_execution: "DIRECT_ALLOWLISTED",
        issued_at: issuedAt,
        expires_at: expiresAt,
        ...input.attestation_overrides,
    });
    const capability = Object.freeze({ attestation });
    const executor = Object.freeze({ capability, execute: input.execute });
    issuedExecutors.set(executor, { attestation });
    return executor;
}
//# sourceMappingURL=repair-isolation.js.map