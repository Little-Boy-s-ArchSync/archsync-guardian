import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { GuardianFinding, GuardianResult } from "./contracts.js";
import {
  assessRepairIsolationCapability,
  createTestOnlyRepairIsolationExecutor,
  type RepairIsolationAttestation,
} from "./repair-isolation.js";
import type { RepairCandidate } from "./reasoner/contracts.js";
import {
  applyRepairCandidate,
  bindRepairVerificationResult,
  compareRepairConformance,
  createPlatformNoNetworkExecutor,
  createRepairSandbox,
  decideRepairVerification,
  defaultSandboxCommandAllowlist,
  detectProjectTestCommand,
  executeProcess,
  gitEnvironment,
  guardianFindingFingerprint,
  guardianResultToRepairSnapshot,
  networkSandboxInvocation,
  normalizeRepairConformanceSnapshot,
  repairCandidateSchemaVersion,
  repairVerificationSchemaVersion,
  resolveSandboxPath,
  runProjectTests,
  runSandboxCommand,
  sandboxEnvironment,
  sanitizeVerificationLog,
  shouldCopySandboxEntry,
  validateRepairCandidate,
  verifyRepairCandidate,
  type NoNetworkCommandExecutor,
  type FilesystemIsolatedCommandExecutor,
  type ProcessResult,
  type ProcessRunner,
  type RepairConformanceSnapshot,
  type RepairSandbox,
  type RepairVerificationResult,
} from "./repair-verification.js";

const originalSource = "export const value = 1;\n";
const repairedSource = "export const value = 2;\n";
const targetFinding = "ARCH-001|frontend%7Cdata%7Cpostgres";
const temporaryRoots: string[] = [];
const approvedIsolationEvidence = {
  schema_version: "1.0.0-preparatory" as const,
  status: "APPROVED" as const,
  reason: null,
  capability_id: "approved-capability",
  isolator_id: "approved-isolator",
  approval_id: "security-approval",
  attestation_sha256: "a".repeat(64),
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function modifyPatch(path = "src/value.ts", before = originalSource.trim(), after = repairedSource.trim()): string {
  return `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-${before}
+${after}
`;
}

function newFilePatch(path = "src/new.ts"): string {
  return `diff --git a/${path} b/${path}
new file mode 100644
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+export const created = true;
`;
}

function deleteFilePatch(path = "src/value.ts"): string {
  return `diff --git a/${path} b/${path}
deleted file mode 100644
--- a/${path}
+++ /dev/null
@@ -1 +0,0 @@
-${originalSource.trim()}
`;
}

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    schema_version: repairCandidateSchemaVersion,
    candidate_id: "repair-001",
    status: "PROPOSED",
    target_block_finding_fingerprints: [targetFinding],
    files: [{ path: "src/value.ts", base_sha256: sha256(originalSource) }],
    unified_diff: modifyPatch(),
    rationale: "Replace the fixture value without changing architecture intent.",
    expected_architecture_impact: "Clear the declared deterministic BLOCK finding.",
    risk: "low",
    verification_commands: ["pnpm test"],
    rollback: "Restore src/value.ts from the bound base hash.",
    ...overrides,
  };
}

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archsync-repair-source-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "value.ts"), originalSource, "utf8");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { test: "vitest run" } }),
    "utf8",
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  return root;
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exit_code: 0,
    stdout: "",
    stderr: "",
    timed_out: false,
    ...overrides,
  };
}

function executor(result: ProcessResult | (() => Promise<ProcessResult>)): NoNetworkCommandExecutor {
  return {
    network_isolation: "ENFORCED",
    execute: typeof result === "function" ? result : async () => result,
  };
}

async function testOnlyExecutor(
  workspace: string,
  result: ProcessResult | (() => Promise<ProcessResult>),
  options: {
    capability_id?: string;
    issued_at?: string;
    expires_at?: string;
    attestation_overrides?: Partial<RepairIsolationAttestation>;
  } = {},
): Promise<FilesystemIsolatedCommandExecutor> {
  return createTestOnlyRepairIsolationExecutor({
    workspace,
    execute: typeof result === "function" ? result : async () => result,
    ...options,
  });
}

function sequenceRunner(results: ProcessResult[]): ProcessRunner {
  let index = 0;
  return async () => results[index++]!;
}

async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("repair candidate schema and unified diff validation", () => {
  it("accepts deterministic modify, add, and delete patches", () => {
    expect(validateRepairCandidate(candidate())).toEqual({ ok: true, paths: ["src/value.ts"] });
    expect(validateRepairCandidate(candidate({
      files: [{ path: "src/new.ts", base_sha256: null }],
      unified_diff: newFilePatch(),
    }))).toEqual({ ok: true, paths: ["src/new.ts"] });
    expect(validateRepairCandidate(candidate({ unified_diff: deleteFilePatch() }))).toEqual({
      ok: true,
      paths: ["src/value.ts"],
    });
  });

  it.each([
    ["wrong schema", { schema_version: "9" }],
    ["bad identifier", { candidate_id: " bad" }],
    ["empty targets", { target_block_finding_fingerprints: [] }],
    ["duplicate targets", { target_block_finding_fingerprints: [targetFinding, targetFinding] }],
    ["blank target", { target_block_finding_fingerprints: [""] }],
    ["empty files", { files: [] }],
    ["missing final newline", { unified_diff: modifyPatch().trimEnd() }],
    ["NUL patch", { unified_diff: `${modifyPatch()}\0` }],
  ])("rejects an invalid candidate: %s", (_name, overrides) => {
    expect(validateRepairCandidate(candidate(overrides as Partial<RepairCandidate>))).toMatchObject({
      ok: false,
      code: "INVALID_CANDIDATE",
    });
  });

  it("rejects an oversized patch", () => {
    expect(validateRepairCandidate(candidate({
      unified_diff: `${"x".repeat(1_048_577)}\n`,
    }))).toMatchObject({ ok: false, code: "INVALID_CANDIDATE" });
  });

  it.each([
    `${"a".repeat(513)}`,
    "src/va\0lue.ts",
    "src\\value.ts",
    "/src/value.ts",
    "C:/src/value.ts",
    "//server/share.ts",
    "src//value.ts",
    "src/./value.ts",
    "src/../value.ts",
  ])("rejects an unsafe portable path: %s", (path) => {
    expect(validateRepairCandidate(candidate({
      files: [{ path, base_sha256: sha256(originalSource) }],
    }))).toMatchObject({ ok: false, code: "INVALID_PATH" });
  });

  it("rejects an empty manifest path at the canonical contract boundary", () => {
    expect(validateRepairCandidate(candidate({
      files: [{ path: "", base_sha256: sha256(originalSource) }],
    }))).toMatchObject({ ok: false, code: "INVALID_CANDIDATE" });
  });

  it.each([".git/config", ".archsync/cache", ".env", ".env.local"])(
    "protects repository metadata and secrets: %s",
    (path) => {
      expect(validateRepairCandidate(candidate({
        files: [{ path, base_sha256: sha256(originalSource) }],
      }))).toMatchObject({ ok: false, code: "RESERVED_PATH" });
    },
  );

  it("requires unique expected files and lowercase SHA-256 values", () => {
    expect(validateRepairCandidate(candidate({
      files: [
        { path: "src/value.ts", base_sha256: sha256(originalSource) },
        { path: "src/value.ts", base_sha256: sha256(originalSource) },
      ],
    }))).toMatchObject({ ok: false, code: "INVALID_CANDIDATE" });
    expect(validateRepairCandidate(candidate({
      files: [{ path: "src/value.ts", base_sha256: "A".repeat(64) }],
    }))).toMatchObject({ ok: false, code: "INVALID_CANDIDATE" });
  });

  it("rejects binary patches globally", () => {
    expect(validateRepairCandidate(candidate({
      unified_diff: `${modifyPatch()}GIT binary patch\n`,
    }))).toMatchObject({ ok: false, code: "BINARY_PATCH" });
    expect(validateRepairCandidate(candidate({
      unified_diff: `${modifyPatch()}Binary files a/x and b/x differ\n`,
    }))).toMatchObject({ ok: false, code: "BINARY_PATCH" });
  });

  it.each([
    ["no git header", "--- a/src/value.ts\n+++ b/src/value.ts\n@@ -1 +1 @@\n-a\n+b\n"],
    ["preface", `unsafe\n${modifyPatch()}`],
    ["mode change", modifyPatch().replace("--- a/", "old mode 100644\nnew mode 100755\n--- a/")],
    ["symlink mode", modifyPatch().replace("--- a/", "index aaa..bbb 120000\n--- a/")],
    ["new executable", newFilePatch().replace("100644", "100755")],
    ["missing old header", modifyPatch().replace("--- a/src/value.ts\n", "")],
    ["nonadjacent headers", modifyPatch().replace("+++ b/", "index aaa..bbb 100644\n+++ b/")],
    ["missing hunk", modifyPatch().replace("@@ -1 +1 @@\n", "")],
    ["combined hunk", modifyPatch().replace("@@ -1 +1 @@", "@@@ -1 -1 +1 @@@")],
    ["quoted header", modifyPatch().replace("--- a/src/value.ts", '--- "a/src/value.ts"')],
    ["timestamp header", modifyPatch().replace("+++ b/src/value.ts", "+++ b/src/value.ts\tdate")],
    ["both null", modifyPatch().replace("--- a/src/value.ts", "--- /dev/null").replace("+++ b/src/value.ts", "+++ /dev/null")],
    ["rename", modifyPatch().replace("+++ b/src/value.ts", "+++ b/src/other.ts")],
    ["header mismatch", modifyPatch().replace("diff --git a/src/value.ts b/src/value.ts", "diff --git a/src/no.ts b/src/no.ts")],
  ])("rejects unsupported patch structure: %s", (_name, unifiedDiff) => {
    expect(validateRepairCandidate(candidate({ unified_diff: unifiedDiff }))).toMatchObject({
      ok: false,
      code: "UNSUPPORTED_PATCH",
    });
  });

  it("rejects duplicate and unexpected patch paths", () => {
    expect(validateRepairCandidate(candidate({
      unified_diff: `${modifyPatch()}${modifyPatch()}`,
    }))).toMatchObject({ ok: false, code: "UNSUPPORTED_PATCH" });
    expect(validateRepairCandidate(candidate({
      files: [
        { path: "src/value.ts", base_sha256: sha256(originalSource) },
        { path: "src/extra.ts", base_sha256: null },
      ],
    }))).toMatchObject({ ok: false, code: "UNEXPECTED_PATH" });
  });
});

describe("temporary sandbox and command containment", () => {
  it("copies a disposable workspace, excludes control artifacts, and cleans idempotently", async () => {
    const source = await projectRoot();
    await writeFile(join(source, ".git"), "gitdir: outside\n", "utf8");
    await mkdir(join(source, "coverage"));
    await writeFile(join(source, "coverage", "result.json"), "{}", "utf8");
    const sandbox = await createRepairSandbox(source);

    expect(await readFile(sandbox.resolve_path("src/value.ts"), "utf8")).toBe(originalSource);
    expect(await pathExists(join(sandbox.workspace, ".git"))).toBe(false);
    expect(await pathExists(join(sandbox.workspace, "coverage"))).toBe(false);
    expect(shouldCopySandboxEntry("")).toBe(true);
    expect(shouldCopySandboxEntry(".archsync/cache.json")).toBe(false);
    expect(shouldCopySandboxEntry(".artifacts/result.json")).toBe(false);
    expect(shouldCopySandboxEntry(".env")).toBe(false);
    expect(shouldCopySandboxEntry(".env.local")).toBe(false);
    expect(shouldCopySandboxEntry("src\\value.ts")).toBe(true);
    expect(resolveSandboxPath(sandbox.workspace, "src/value.ts")).toBe(sandbox.resolve_path("src/value.ts"));
    expect(() => resolveSandboxPath(sandbox.workspace, "../outside")).toThrow("INVALID_PATH");

    await sandbox.cleanup();
    await sandbox.cleanup();
    expect(await pathExists(sandbox.root)).toBe(false);
  });

  it("rejects invalid source and nested temporary roots and cleans a failed copy", async () => {
    const source = await projectRoot();
    const file = join(source, "src", "value.ts");
    await expect(createRepairSandbox(file)).rejects.toThrow("must be a directory");
    await expect(createRepairSandbox(source, { temp_parent: join(source, "tmp") })).rejects.toThrow(
      "must not be inside",
    );
    await expect(createRepairSandbox(source, {
      temp_parent: join(source, "src", "value.ts", "child"),
    })).rejects.toThrow();
    await expect(createRepairSandbox(source, {
      copy_tree: async () => {
        throw new Error("copy failed");
      },
    })).rejects.toThrow("copy failed");
    const copied = await createRepairSandbox(source, {
      copy_tree: async (_from, destination) => {
        await mkdir(destination, { recursive: true });
        await writeFile(join(destination, "copied.txt"), "copied", "utf8");
      },
    });
    expect(await readFile(join(copied.workspace, "copied.txt"), "utf8")).toBe("copied");
    await copied.cleanup();
  });

  it("builds an allowlisted, credential-minimized offline environment", () => {
    const environment = sandboxEnvironment("/sandbox/workspace", {
      PATH: "/bin",
      LANG: "C",
      SECRET_TOKEN: "do-not-copy",
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      LANG: "C",
      CI: "true",
      ARCHSYNC_NETWORK_POLICY: "deny",
      npm_config_offline: "true",
      YARN_ENABLE_NETWORK: "0",
      NO_PROXY: "",
    });
    expect(environment.SECRET_TOKEN).toBeUndefined();
    expect(defaultSandboxCommandAllowlist).toContain("pnpm");
  });

  it("describes enforced network wrappers for macOS and Linux and fails closed elsewhere", async () => {
    expect(networkSandboxInvocation("darwin", "npm", ["test"])).toEqual({
      command: "/usr/bin/sandbox-exec",
      args: ["-p", "(version 1) (allow default) (deny network*)", "--", "npm", "test"],
    });
    expect(networkSandboxInvocation("linux", "npm", ["test"])).toEqual({
      command: "unshare",
      args: ["--user", "--map-root-user", "--net", "--", "npm", "test"],
    });
    expect(networkSandboxInvocation("win32", "npm", ["test"])).toBeUndefined();
    expect(createPlatformNoNetworkExecutor("win32", async () => processResult())).toBeUndefined();

    const darwin = createPlatformNoNetworkExecutor("darwin", async (invocation) => {
      expect(invocation.command).toBe("/usr/bin/sandbox-exec");
      return processResult();
    })!;
    expect(await darwin.execute({
      command: "npm",
      args: ["test"],
      cwd: "/tmp",
      env: {},
      timeout_ms: 1,
      max_output_bytes: 1,
    })).toMatchObject({ exit_code: 0 });

    const deniedLinux = createPlatformNoNetworkExecutor("linux", async () =>
      processResult({ exit_code: 1, stderr: "unshare: unshare failed: Operation not permitted" }))!;
    expect(await deniedLinux.execute({ command: "npm", args: [], cwd: "/tmp", env: {}, timeout_ms: 1, max_output_bytes: 1 }))
      .toMatchObject({ infrastructure_error: "NETWORK_SANDBOX_UNAVAILABLE" });

    const deniedDarwin = createPlatformNoNetworkExecutor("darwin", async () =>
      processResult({ exit_code: 1, stderr: "sandbox-exec: operation not permitted" }))!;
    expect(await deniedDarwin.execute({ command: "npm", args: [], cwd: "/tmp", env: {}, timeout_ms: 1, max_output_bytes: 1 }))
      .toMatchObject({ infrastructure_error: "NETWORK_SANDBOX_UNAVAILABLE" });
  });

  it("runtime-validates every field of the versioned TEST_ONLY isolation attestation", async () => {
    const source = await projectRoot();
    const sandbox = await createRepairSandbox(source);
    const now = Date.parse("2026-08-26T00:05:00.000Z");
    const issued_at = "2026-08-26T00:00:00.000Z";
    const expires_at = "2026-08-26T00:10:00.000Z";
    const invalidCases: Array<Partial<RepairIsolationAttestation>> = [
      { schema_version: "wrong" as never },
      { capability_id: " invalid" },
      { isolator_id: " invalid" },
      { approval_id: " invalid" },
      { workspace_sha256: "invalid" },
      { filesystem_isolation: "CLAIMED" as never },
      { filesystem_scope: "HOST" as never },
      { network_isolation: "CLAIMED" as never },
      { process_execution: "SHELL" as never },
      { issued_at: "not-a-date" },
      { expires_at: "2026-08-26T00:10:00Z" },
      { expires_at: issued_at },
      { expires_at: "2026-08-26T00:16:00.001Z" },
    ];
    for (const attestation_overrides of invalidCases) {
      const candidateExecutor = await testOnlyExecutor(sandbox.workspace, async () => processResult(), {
        capability_id: "custom-test-capability",
        issued_at,
        expires_at,
        attestation_overrides,
      });
      expect(await assessRepairIsolationCapability(candidateExecutor, sandbox.workspace, now)).toMatchObject({
        approved: false,
        evidence: { status: "REJECTED", reason: "FILESYSTEM_ISOLATION_ATTESTATION_INVALID" },
      });
    }

    const future = await testOnlyExecutor(sandbox.workspace, async () => processResult(), {
      issued_at: "2026-08-26T00:06:00.000Z",
      expires_at: "2026-08-26T00:07:00.000Z",
    });
    expect(await assessRepairIsolationCapability(future, sandbox.workspace, now)).toMatchObject({
      evidence: { reason: "FILESYSTEM_ISOLATION_CAPABILITY_NOT_YET_VALID" },
    });

    const unavailable = await testOnlyExecutor(sandbox.workspace, async () => processResult(), {
      issued_at,
      expires_at,
    });
    await sandbox.cleanup();
    expect(await assessRepairIsolationCapability(unavailable, sandbox.workspace, now)).toMatchObject({
      evidence: { reason: "FILESYSTEM_ISOLATION_WORKSPACE_UNAVAILABLE" },
    });
    expect(await assessRepairIsolationCapability("forged" as never, sandbox.workspace, now)).toMatchObject({
      evidence: { reason: "FILESYSTEM_ISOLATION_CAPABILITY_REQUIRED" },
    });
  });

  it("does not expose the TEST_ONLY issuer outside a Vitest process", async () => {
    const source = await projectRoot();
    const previous = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(createTestOnlyRepairIsolationExecutor({
        workspace: source,
        execute: async () => processResult(),
      })).rejects.toThrow("only inside Vitest");
    } finally {
      if (previous === undefined) delete process.env.VITEST;
      else process.env.VITEST = previous;
    }
  });
});

describe("bounded process and project test execution", () => {
  it("reports successful, failed, unavailable, and timed-out processes", async () => {
    const base = {
      cwd: process.cwd(),
      env: process.env,
      max_output_bytes: 1024,
    };
    expect(await executeProcess({
      ...base,
      command: process.execPath,
      args: ["-e", "process.stdout.write('ok')"],
      timeout_ms: 5_000,
    })).toMatchObject({ exit_code: 0, stdout: "ok", timed_out: false });
    expect(await executeProcess({
      ...base,
      command: process.execPath,
      args: ["-e", "process.stderr.write('bad'); process.exit(7)"],
      timeout_ms: 5_000,
    })).toMatchObject({ exit_code: 7, stderr: "bad", timed_out: false });
    expect(await executeProcess({
      ...base,
      command: "archsync-command-that-does-not-exist",
      args: [],
      timeout_ms: 5_000,
    })).toMatchObject({ exit_code: null, infrastructure_error: expect.any(String) });
    expect(await executeProcess({
      ...base,
      cwd: join(process.cwd(), "directory-that-does-not-exist"),
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeout_ms: 5_000,
    })).toMatchObject({ exit_code: null, infrastructure_error: expect.any(String) });
    expect(await executeProcess({
      ...base,
      command: "invalid\0command",
      args: [],
      timeout_ms: 5_000,
    })).toMatchObject({ exit_code: null, stdout: "", stderr: expect.stringContaining("null bytes") });
    expect(await executeProcess({
      ...base,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeout_ms: 20,
    })).toMatchObject({ timed_out: true });
  });

  it("redacts paths and secrets, normalizes ANSI, and bounds logs", () => {
    const value = "\u001b[31m/tmp/sandbox\u001b[0m token=abc123 Bearer xyz.123 https://user:pass@example.test API_KEY=qwerty hidden-value";
    const sanitized = sanitizeVerificationLog(value, "/tmp/sandbox", ["hidden-value", "no"]);
    expect(sanitized).toBe(
      "<SANDBOX> token=<REDACTED> Bearer <REDACTED> https://<REDACTED>@example.test API_KEY=<REDACTED> <REDACTED>",
    );
    expect(sanitizeVerificationLog("abcdef", "/none", [], 3)).toBe("abc\n<LOG_TRUNCATED>");
  });

  it("fails closed before execution for absent, forged, mismatched, and expired filesystem capabilities", async () => {
    const source = await projectRoot();
    const sandbox = await createRepairSandbox(source);
    let executions = 0;
    const fakeRun = async () => {
      executions += 1;
      return processResult();
    };
    const validTestAdapter = await testOnlyExecutor(sandbox.workspace, fakeRun);
    expect(await runSandboxCommand(sandbox, { command: "sh", args: ["-c", "true"] }, { executor: validTestAdapter }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "COMMAND_NOT_ALLOWED" });
    expect(await runSandboxCommand(sandbox, { command: "/usr/bin/npm", args: ["test"] }, { executor: validTestAdapter }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "COMMAND_NOT_ALLOWED" });
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["bad\0arg"] }, { executor: validTestAdapter }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "INVALID_COMMAND_ARGUMENT" });
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "FILESYSTEM_ISOLATION_CAPABILITY_REQUIRED" });
    const forged = {
      network_isolation: "ENFORCED",
      execute: fakeRun,
    } as unknown as FilesystemIsolatedCommandExecutor;
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, { executor: forged }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "FILESYSTEM_ISOLATION_CAPABILITY_UNTRUSTED" });

    const otherSandbox = await createRepairSandbox(source);
    const mismatched = await testOnlyExecutor(otherSandbox.workspace, fakeRun);
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, { executor: mismatched }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "FILESYSTEM_ISOLATION_WORKSPACE_MISMATCH" });
    await otherSandbox.cleanup();

    const expired = await testOnlyExecutor(sandbox.workspace, fakeRun, {
      issued_at: "2020-01-01T00:00:00.000Z",
      expires_at: "2020-01-01T00:01:00.000Z",
    });
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, { executor: expired }))
      .toMatchObject({ status: "INCONCLUSIVE", reason: "FILESYSTEM_ISOLATION_CAPABILITY_EXPIRED" });

    for (const timeout_ms of [0, 600_001, 1.5]) {
      expect(await runSandboxCommand(
        sandbox,
        { command: "npm", args: ["test"] },
        { executor: validTestAdapter, timeout_ms },
      )).toMatchObject({ status: "INCONCLUSIVE", reason: "INVALID_TIMEOUT" });
    }
    expect(executions).toBe(0);
    await sandbox.cleanup();
  });

  it("classifies command results and sanitizes executor output and failures", async () => {
    const source = await projectRoot();
    const sandbox = await createRepairSandbox(source);
    const secret = "super-secret-value";
    const pass = await runSandboxCommand(
      sandbox,
      { command: "custom", args: ["test"] },
      {
        allowlist: ["custom"],
        executor: await testOnlyExecutor(
          sandbox.workspace,
          processResult({ stdout: `${sandbox.root} password=${secret}` }),
        ),
        sensitive_values: [secret],
      },
    );
    expect(pass).toMatchObject({ status: "PASS", exit_code: 0 });
    expect(pass.filesystem_isolation).toMatchObject({ status: "TEST_ONLY", reason: "FILESYSTEM_ISOLATION_TEST_ONLY" });
    expect(pass.stdout).toBe("<SANDBOX> password=<REDACTED>");
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, {
      executor: await testOnlyExecutor(sandbox.workspace, processResult({ exit_code: 1 })),
    })).toMatchObject({ status: "FAIL", reason: "TEST_EXIT_NONZERO" });
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, {
      executor: await testOnlyExecutor(sandbox.workspace, processResult({ exit_code: null, timed_out: true })),
    })).toMatchObject({ status: "TIMEOUT", reason: "TEST_TIMEOUT" });
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, {
      executor: await testOnlyExecutor(sandbox.workspace, processResult({ infrastructure_error: "NO_BACKEND" })),
    })).toMatchObject({ status: "INCONCLUSIVE", reason: "NO_BACKEND" });
    expect(await runSandboxCommand(sandbox, { command: "npm", args: ["test"] }, {
      executor: await testOnlyExecutor(sandbox.workspace, async () => { throw new Error(`${sandbox.root} token=secret-value`); }),
    })).toMatchObject({
      status: "INCONCLUSIVE",
      reason: "COMMAND_EXECUTOR_FAILED",
      stderr: "<SANDBOX> token=<REDACTED>",
    });
    await sandbox.cleanup();
  });

  it("detects package-manager test commands without evaluating package scripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "archsync-test-detect-"));
    temporaryRoots.push(root);
    expect(await detectProjectTestCommand(root)).toBeUndefined();
    await writeFile(join(root, "package.json"), "not-json", "utf8");
    expect(await detectProjectTestCommand(root)).toBeUndefined();
    await writeFile(join(root, "package.json"), "{}", "utf8");
    expect(await detectProjectTestCommand(root)).toBeUndefined();
    await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { test: "test" } }), "utf8");
    expect(await detectProjectTestCommand(root)).toEqual({ command: "npm", args: ["test"] });
    await writeFile(join(root, "bun.lockb"), "", "utf8");
    expect(await detectProjectTestCommand(root)).toEqual({ command: "bun", args: ["test"] });
    await rm(join(root, "bun.lockb"));
    await writeFile(join(root, "bun.lock"), "", "utf8");
    expect(await detectProjectTestCommand(root)).toEqual({ command: "bun", args: ["test"] });
    await rm(join(root, "bun.lock"));
    await writeFile(join(root, "yarn.lock"), "", "utf8");
    expect(await detectProjectTestCommand(root)).toEqual({ command: "yarn", args: ["test"] });
    await rm(join(root, "yarn.lock"));
    await writeFile(join(root, "pnpm-lock.yaml"), "", "utf8");
    expect(await detectProjectTestCommand(root)).toEqual({ command: "pnpm", args: ["test"] });
  });

  it("runs a detected test command and reports a missing command", async () => {
    const source = await projectRoot();
    const sandbox = await createRepairSandbox(source);
    expect(await runProjectTests(sandbox, {
      executor: await testOnlyExecutor(sandbox.workspace, processResult()),
    })).toMatchObject({
      status: "PASS",
      command: "pnpm",
      filesystem_isolation: { status: "TEST_ONLY" },
    });
    const platformDefault = await runSandboxCommand(
      sandbox,
      { command: "npm", args: ["test"] },
      { timeout_ms: 2_000 },
    );
    expect(["FAIL", "TIMEOUT", "INCONCLUSIVE"]).toContain(platformDefault.status);
    await rm(join(sandbox.workspace, "package.json"));
    expect(await runProjectTests(sandbox, {
      executor: await testOnlyExecutor(sandbox.workspace, processResult()),
    })).toMatchObject({
      status: "INCONCLUSIVE",
      reason: "TEST_COMMAND_NOT_FOUND",
    });
    await sandbox.cleanup();
  });
});

describe("safe patch application", () => {
  it("applies textual modify, add, and delete patches with before/after hashes", async () => {
    for (const repair of [
      candidate(),
      candidate({
        candidate_id: "add",
        files: [{ path: "src/new.ts", base_sha256: null }],
        unified_diff: newFilePatch(),
      }),
      candidate({ candidate_id: "delete", unified_diff: deleteFilePatch() }),
    ]) {
      const source = await projectRoot();
      const sandbox = await createRepairSandbox(source);
      const result = await applyRepairCandidate(sandbox, repair);
      expect(result.status).toBe("APPLIED");
      if (repair.candidate_id === "add") {
        expect(await readFile(join(sandbox.workspace, "src", "new.ts"), "utf8")).toContain("created");
      } else if (repair.candidate_id === "delete") {
        expect(await pathExists(join(sandbox.workspace, "src", "value.ts"))).toBe(false);
      } else {
        expect(await readFile(join(sandbox.workspace, "src", "value.ts"), "utf8")).toBe(repairedSource);
      }
      await sandbox.cleanup();
    }
  });

  it("rejects invalid and stale candidates before invoking Git", async () => {
    const source = await projectRoot();
    const sandbox = await createRepairSandbox(source);
    expect(await applyRepairCandidate(sandbox, candidate({ candidate_id: " bad" }))).toMatchObject({
      status: "REJECTED",
      code: "INVALID_CANDIDATE",
    });
    await writeFile(join(sandbox.workspace, "src", "value.ts"), "dirty\n", "utf8");
    expect(await applyRepairCandidate(sandbox, candidate())).toMatchObject({
      status: "REJECTED",
      code: "DIRTY_WORKSPACE",
    });
    await sandbox.cleanup();
  });

  it("rejects symlinked, non-directory parent, and non-file targets", async () => {
    const source = await projectRoot();
    const outside = await mkdtemp(join(tmpdir(), "archsync-outside-"));
    temporaryRoots.push(outside);
    await writeFile(join(outside, "value.ts"), originalSource, "utf8");

    const symlinkSandbox = await createRepairSandbox(source);
    const link = join(symlinkSandbox.workspace, "linked");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    expect(await applyRepairCandidate(symlinkSandbox, candidate({
      files: [{ path: "linked/value.ts", base_sha256: sha256(originalSource) }],
      unified_diff: modifyPatch("linked/value.ts"),
    }))).toMatchObject({ status: "REJECTED", code: "SYMLINK_PATH" });
    await symlinkSandbox.cleanup();

    const parentSandbox = await createRepairSandbox(source);
    await writeFile(join(parentSandbox.workspace, "bad"), "not a directory", "utf8");
    expect(await applyRepairCandidate(parentSandbox, candidate({
      files: [{ path: "bad/new.ts", base_sha256: null }],
      unified_diff: newFilePatch("bad/new.ts"),
    }))).toMatchObject({ status: "REJECTED", code: "DIRTY_WORKSPACE" });
    expect(await applyRepairCandidate(parentSandbox, candidate({
      files: [{ path: "src", base_sha256: null }],
      unified_diff: modifyPatch("src"),
    }))).toMatchObject({ status: "REJECTED", code: "DIRTY_WORKSPACE" });
    await parentSandbox.cleanup();
  });

  it("classifies Git preflight, race, infrastructure, and no-effect failures", async () => {
    const source = await projectRoot();
    const cases: Array<[ProcessResult[], string, string]> = [
      [[processResult({ exit_code: 1 })], "REJECTED", "PATCH_DOES_NOT_APPLY"],
      [[processResult({ timed_out: true })], "INCONCLUSIVE", "GIT_UNAVAILABLE"],
      [[processResult({ infrastructure_error: "ENOENT" })], "INCONCLUSIVE", "GIT_UNAVAILABLE"],
      [[processResult(), processResult({ exit_code: 1 })], "REJECTED", "PATCH_APPLY_FAILED"],
      [[processResult(), processResult({ timed_out: true })], "INCONCLUSIVE", "GIT_UNAVAILABLE"],
      [[processResult(), processResult({ infrastructure_error: "ENOENT" })], "INCONCLUSIVE", "GIT_UNAVAILABLE"],
      [[processResult(), processResult()], "REJECTED", "PATCH_NO_EFFECT"],
    ];
    for (const [results, status, code] of cases) {
      const sandbox = await createRepairSandbox(source);
      expect(await applyRepairCandidate(sandbox, candidate(), sequenceRunner(results))).toMatchObject({ status, code });
      expect(await pathExists(join(sandbox.root, "candidate.patch"))).toBe(false);
      await sandbox.cleanup();
    }
  });

  it("uses isolated Git configuration on POSIX and Windows", () => {
    expect(gitEnvironment("darwin").GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(gitEnvironment("win32").GIT_CONFIG_GLOBAL).toBe("NUL");
  });
});

describe("ArchSync rechecks and deterministic decisions", () => {
  const completeFinding: GuardianFinding = {
    contract_version: "0.1",
    id: "ARCH-001",
    kind: "deny-rule",
    severity: "critical",
    message: "blocked",
    rule_id: "ARCH-001",
    edge: { key: "frontend|data|postgres", from: "frontend", to: "postgres", type: "data" },
    component: "frontend",
    change: "added",
    source_evidence: [{
      kind: "source-location",
      file: "frontend/src/database.ts",
      line: 4,
      column: 9,
      snippet: "query",
      detector: "typescript-pg",
      confidence: 1,
    }],
    model_evidence: { schema_version: "1.0.0", document: "observed", path: "/relationships/3" },
  };

  function guardianResult(decision: "PASS" | "BLOCK" | "REVIEW", findings: GuardianFinding[]): GuardianResult {
    return {
      contract_version: "0.1",
      classification: decision === "PASS" ? "no-impact" : decision === "BLOCK" ? "violation" : "evolution",
      decision,
      summary: { violations: decision === "BLOCK" ? 1 : 0, evolutions: 0, added_nodes: 0, removed_nodes: 0, changed_nodes: 0, added_edges: 0, removed_edges: 0 },
      findings,
      diff: { added_nodes: [], removed_nodes: [], changed_nodes: [], added_edges: [], removed_edges: [] },
      observed: {
        version: "0.1",
        analyzer: { id: "archsync-typescript", version: "0.2", stack: "typescript-node" },
        metadata: { name: "test", scanned_files: 0 },
        components: {},
        relationships: [],
      },
    };
  }

  it("creates stable fingerprints and BLOCK-only snapshots", () => {
    const fingerprint = guardianFindingFingerprint(completeFinding);
    expect(fingerprint).toContain("ARCH-001");
    expect(fingerprint).toContain("frontend%7Cdata%7Cpostgres");
    const minimal = { ...completeFinding, rule_id: undefined, edge: undefined, component: undefined, change: undefined, source_evidence: [] } as unknown as GuardianFinding;
    expect(guardianFindingFingerprint(minimal)).toBe("ARCH-001|||||");
    expect(guardianResultToRepairSnapshot(guardianResult("BLOCK", [completeFinding, completeFinding])))
      .toEqual({ status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: [fingerprint] });
    expect(guardianResultToRepairSnapshot(guardianResult("PASS", [completeFinding])))
      .toEqual({ status: "COMPLETE", decision: "PASS", block_finding_fingerprints: [] });
  });

  it("normalizes valid snapshots and rejects inconsistent rechecks", () => {
    expect(normalizeRepairConformanceSnapshot({ status: "ERROR", message: "bad" })).toEqual({ status: "ERROR", message: "bad" });
    expect(normalizeRepairConformanceSnapshot({ status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: ["b", "a", "a"] }))
      .toEqual({ status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: ["a", "b"] });
    for (const snapshot of [
      { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: [] },
      { status: "COMPLETE", decision: "PASS", block_finding_fingerprints: ["unexpected"] },
      { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: [""] },
    ] satisfies RepairConformanceSnapshot[]) {
      expect(normalizeRepairConformanceSnapshot(snapshot)).toMatchObject({ status: "ERROR" });
    }
  });

  it("compares target, remaining, missing, and newly introduced BLOCK findings", () => {
    expect(compareRepairConformance(
      ["target", "missing"],
      { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: ["target", "old"] },
      { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: ["target", "new"] },
    )).toEqual({
      baseline_block_finding_fingerprints: ["old", "target"],
      candidate_block_finding_fingerprints: ["new", "target"],
      missing_target_finding_fingerprints: ["missing"],
      remaining_target_finding_fingerprints: ["target"],
      new_block_finding_fingerprints: ["new"],
    });
  });

  it.each([
    [{ patch_status: "REJECTED", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "REJECT_UNSAFE"],
    [{ patch_status: "INCONCLUSIVE", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", tests_status: "PASS", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "PASS", recheck_complete: false, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "PASS", recheck_complete: true, missing_targets: 1, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "TIMEOUT", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "INCONCLUSIVE", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "INCONCLUSIVE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "FAIL", recheck_complete: true, missing_targets: 0, remaining_targets: 1, new_blocks: 1 }, "REJECT_TEST"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "FAIL", recheck_complete: false, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "REJECT_TEST"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "PASS", recheck_complete: true, missing_targets: 0, remaining_targets: 1, new_blocks: 0 }, "REJECT_CONFORMANCE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "PASS", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 1 }, "REJECT_CONFORMANCE"],
    [{ patch_status: "APPLIED", filesystem_isolation_status: "APPROVED", tests_status: "PASS", recheck_complete: true, missing_targets: 0, remaining_targets: 0, new_blocks: 0 }, "ACCEPTABLE_FOR_REVIEW"],
  ] as const)("returns %s deterministically", (input, decision) => {
    expect(decideRepairVerification(input)).toMatchObject({ decision });
  });

  it("binds only matching offline verifier evidence and promotes only a complete pass", () => {
    const complete: RepairVerificationResult = {
      schema_version: repairVerificationSchemaVersion,
      candidate_id: "repair-001",
      decision: "ACCEPTABLE_FOR_REVIEW",
      reason: "complete",
      patch: {
        status: "APPLIED",
        paths: ["src/value.ts"],
        before_sha256: { "src/value.ts": sha256(originalSource) },
        after_sha256: { "src/value.ts": sha256(repairedSource) },
      },
      tests: {
        status: "PASS",
        command: "pnpm",
        args: ["test"],
        exit_code: 0,
        duration_ms: 1,
        stdout: "",
        stderr: "",
        filesystem_isolation: approvedIsolationEvidence,
      },
      filesystem_isolation: approvedIsolationEvidence,
      conformance: {
        baseline_block_finding_fingerprints: [targetFinding],
        candidate_block_finding_fingerprints: [],
        missing_target_finding_fingerprints: [],
        remaining_target_finding_fingerprints: [],
        new_block_finding_fingerprints: [],
      },
      sandbox_cleanup: "COMPLETED",
    };
    expect(bindRepairVerificationResult(candidate(), complete)).toMatchObject({
      status: "VERIFIED_FOR_REVIEW",
      verification: {
        decision: "ACCEPTABLE_FOR_REVIEW",
        tests: "pass",
        conformance: "pass",
        safe_apply: true,
        filesystem_isolation: "approved",
        isolation_attestation_sha256: "a".repeat(64),
      },
    });

    const failures: RepairVerificationResult[] = [
      {
        ...complete,
        decision: "REJECT_TEST",
        patch: { status: "REJECTED", code: "PATCH_DOES_NOT_APPLY", message: "bad", paths: ["src/value.ts"] },
        tests: { ...complete.tests!, status: "FAIL", exit_code: 1 },
        conformance: {
          ...complete.conformance!,
          missing_target_finding_fingerprints: ["missing"],
          new_block_finding_fingerprints: ["new"],
        },
      },
      {
        ...complete,
        decision: "INCONCLUSIVE",
        patch: { status: "INCONCLUSIVE", code: "NOT_ATTEMPTED", message: "none", paths: [] },
        tests: null,
        conformance: null,
      },
      {
        ...complete,
        decision: "REJECT_CONFORMANCE",
        tests: { ...complete.tests!, status: "TIMEOUT", exit_code: null },
        conformance: {
          ...complete.conformance!,
          remaining_target_finding_fingerprints: [targetFinding],
        },
      },
      {
        ...complete,
        decision: "REJECT_CONFORMANCE",
        conformance: {
          ...complete.conformance!,
          new_block_finding_fingerprints: ["new"],
        },
      },
    ];
    expect(failures.map((result) => bindRepairVerificationResult(candidate(), result))).toMatchObject([
      { status: "PROPOSED", verification: { tests: "fail", conformance: "fail", safe_apply: false, new_blocking_findings: 1 } },
      { status: "PROPOSED", verification: { tests: "not-run", conformance: "not-run", safe_apply: false, new_blocking_findings: 0 } },
      { status: "PROPOSED", verification: { tests: "not-run", conformance: "fail", safe_apply: true } },
      { status: "PROPOSED", verification: { tests: "pass", conformance: "fail", safe_apply: true, new_blocking_findings: 1 } },
    ]);
    expect(() => bindRepairVerificationResult(
      candidate({
        status: "VERIFIED_FOR_REVIEW",
        verification: {
          decision: "ACCEPTABLE_FOR_REVIEW",
          tests: "pass",
          conformance: "pass",
          safe_apply: true,
          new_blocking_findings: 0,
          filesystem_isolation: "approved",
          isolation_attestation_sha256: "a".repeat(64),
        },
      }),
      complete,
    )).toThrow("unverified PROPOSED");
    expect(() => bindRepairVerificationResult(candidate(), { ...complete, candidate_id: "other" }))
      .toThrow("candidate ID");
  });
});

describe("end-to-end repair verification orchestration", () => {
  function recheckSequence(candidateSnapshot: RepairConformanceSnapshot = {
    status: "COMPLETE",
    decision: "PASS",
    block_finding_fingerprints: [],
  }) {
    return async (_workspace: string, stage: "BASELINE" | "CANDIDATE"): Promise<RepairConformanceSnapshot> =>
      stage === "BASELINE"
        ? { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: [targetFinding] }
        : candidateSnapshot;
  }

  it("keeps a TEST_ONLY verifier simulation inconclusive and always cleans up", async () => {
    const source = await projectRoot();
    const tempParent = await mkdtemp(join(tmpdir(), "archsync-repair-parent-"));
    temporaryRoots.push(tempParent);
    let sandboxPath = "";
    const result = await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: async (workspace, stage) => {
        sandboxPath = workspace;
        return recheckSequence()(workspace, stage);
      },
      command_executor_factory: (sandbox) => testOnlyExecutor(
        sandbox.workspace,
        processResult({ stdout: "tests passed" }),
      ),
      test_command: { command: "npm", args: ["test"] },
      timeout_ms: 1_000,
      sensitive_values: ["secret-value"],
      temp_parent: tempParent,
    });

    expect(result).toMatchObject({
      schema_version: repairVerificationSchemaVersion,
      decision: "INCONCLUSIVE",
      patch: { status: "APPLIED" },
      tests: { status: "PASS", filesystem_isolation: { status: "TEST_ONLY" } },
      filesystem_isolation: { status: "TEST_ONLY", reason: "FILESYSTEM_ISOLATION_TEST_ONLY" },
      conformance: { remaining_target_finding_fingerprints: [], new_block_finding_fingerprints: [] },
      sandbox_cleanup: "COMPLETED",
    });
    expect(await pathExists(sandboxPath)).toBe(false);
  });

  it("does not promote any simulated test outcome without an approved isolator", async () => {
    const cases: Array<[ProcessResult, RepairConformanceSnapshot, string]> = [
      [processResult({ exit_code: 1 }), { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: [targetFinding, "new"] }, "REJECT_TEST"],
      [processResult(), { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: [targetFinding] }, "REJECT_CONFORMANCE"],
      [processResult(), { status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: ["new"] }, "REJECT_CONFORMANCE"],
    ];
    for (const [testResult, snapshot, expected] of cases) {
      expect((await verifyRepairCandidate({
        source_root: await projectRoot(),
        candidate: candidate(),
        recheck: recheckSequence(snapshot),
        command_executor_factory: (sandbox) => testOnlyExecutor(sandbox.workspace, testResult),
      })).decision).toBe("INCONCLUSIVE");
    }
  });

  it("fails closed for invalid input, sandbox failure, baseline errors, and missing targets", async () => {
    const source = await projectRoot();
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate({ candidate_id: " bad" }),
      recheck: recheckSequence(),
    })).toMatchObject({ decision: "REJECT_UNSAFE", sandbox_cleanup: "NOT_CREATED" });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence(),
      sandbox_factory: async () => { throw new Error("no disk"); },
    })).toMatchObject({ decision: "INCONCLUSIVE", reason: "Sandbox creation failed: no disk" });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: async () => ({ status: "ERROR", message: "recheck failed" }),
    })).toMatchObject({ decision: "INCONCLUSIVE", reason: "recheck failed" });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: async () => ({ status: "COMPLETE", decision: "BLOCK", block_finding_fingerprints: ["other"] }),
    })).toMatchObject({
      decision: "INCONCLUSIVE",
      conformance: { missing_target_finding_fingerprints: [targetFinding] },
    });
  });

  it("maps unsafe and unavailable patch application and unavailable tests deterministically", async () => {
    const source = await projectRoot();
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate({ files: [{ path: "src/value.ts", base_sha256: "0".repeat(64) }] }),
      recheck: recheckSequence(),
    })).toMatchObject({ decision: "REJECT_UNSAFE", patch: { code: "DIRTY_WORKSPACE" } });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence(),
      process_runner: async () => processResult({ infrastructure_error: "ENOENT" }),
    })).toMatchObject({ decision: "INCONCLUSIVE", patch: { code: "GIT_UNAVAILABLE" } });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence(),
      command_executor: null,
    })).toMatchObject({
      decision: "INCONCLUSIVE",
      tests: { reason: "FILESYSTEM_ISOLATION_CAPABILITY_REQUIRED" },
      filesystem_isolation: { status: "REJECTED" },
    });
    expect((await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence(),
      timeout_ms: 2_000,
    })).decision).not.toBe("ACCEPTABLE_FOR_REVIEW");
  });

  it("turns candidate recheck failure and unexpected pipeline exceptions into inconclusive results", async () => {
    const source = await projectRoot();
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence({ status: "ERROR", message: "candidate scan failed" }),
      command_executor_factory: (sandbox) => testOnlyExecutor(sandbox.workspace, processResult()),
    })).toMatchObject({ decision: "INCONCLUSIVE", conformance: null });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence(),
      process_runner: async () => { throw new Error("token=topsecret"); },
    })).toMatchObject({ decision: "INCONCLUSIVE", reason: "token=<REDACTED>" });
    expect(await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      sensitive_values: ["credential-value"],
      recheck: async () => { throw new Error("credential-value"); },
    })).toMatchObject({ decision: "INCONCLUSIVE", reason: "<REDACTED>" });
  });

  it("reports cleanup failure without claiming the candidate is reviewable", async () => {
    const source = await projectRoot();
    const result = await verifyRepairCandidate({
      source_root: source,
      candidate: candidate(),
      recheck: recheckSequence(),
      command_executor_factory: (sandbox) => testOnlyExecutor(sandbox.workspace, processResult()),
      sandbox_factory: async (root, options) => {
        const sandbox = await createRepairSandbox(root, options);
        return {
          ...sandbox,
          cleanup: async () => {
            await sandbox.cleanup();
            throw new Error("cleanup audit failed");
          },
        } satisfies RepairSandbox;
      },
    });
    expect(result).toMatchObject({
      decision: "INCONCLUSIVE",
      sandbox_cleanup: "FAILED",
      reason: "Sandbox cleanup failed: cleanup audit failed",
    });
  });
});
