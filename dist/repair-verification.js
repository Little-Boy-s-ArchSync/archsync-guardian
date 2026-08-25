import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile, } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { repairCandidateContractVersion, validateProposedRepairCandidateShape, } from "./reasoner/contracts.js";
const execFileAsync = promisify(execFile);
export const repairCandidateSchemaVersion = repairCandidateContractVersion;
export const repairVerificationSchemaVersion = "0.1.0-preparatory";
export const defaultSandboxCommandAllowlist = [
    "bun",
    "bun.exe",
    "npm",
    "npm.cmd",
    "pnpm",
    "pnpm.cmd",
    "yarn",
    "yarn.cmd",
];
const maximumPatchBytes = 1_048_576;
const defaultTestTimeoutMs = 120_000;
const maximumTestTimeoutMs = 600_000;
const defaultMaximumLogBytes = 262_144;
function failure(code, message) {
    return { ok: false, code, message };
}
function isContained(root, target) {
    const value = relative(root, target);
    return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}
function normalizedRepairPath(value) {
    if (value.length === 0 ||
        value.length > 512 ||
        value.includes("\0") ||
        value.includes("\\") ||
        isAbsolute(value) ||
        /^[A-Za-z]:/u.test(value) ||
        value.startsWith("//")) {
        return failure("INVALID_PATH", `Repair path '${value}' must be a portable relative path`);
    }
    const parts = value.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
        return failure("INVALID_PATH", `Repair path '${value}' contains an empty or traversal segment`);
    }
    const first = parts[0].toLowerCase();
    if (first === ".git" ||
        first === ".archsync" ||
        first === ".env" ||
        first.startsWith(".env.")) {
        return failure("RESERVED_PATH", `Repair path '${value}' targets protected metadata or secrets`);
    }
    return value;
}
export function resolveSandboxPath(root, relativePath) {
    const normalized = normalizedRepairPath(relativePath);
    if (typeof normalized !== "string")
        throw new Error(`${normalized.code}: ${normalized.message}`);
    return resolve(root, ...normalized.split("/"));
}
export function shouldCopySandboxEntry(relativePath) {
    if (relativePath === "")
        return true;
    const first = relativePath.split(/[\\/]/u)[0].toLowerCase();
    if (first === ".env" || first.startsWith(".env."))
        return false;
    return ![".archsync", ".artifacts", ".git", "coverage"].includes(first);
}
async function canonicalPotentialPath(path) {
    const suffix = [];
    let existing = resolve(path);
    while (true) {
        try {
            return resolve(await realpath(existing), ...suffix);
        }
        catch {
            const parent = dirname(existing);
            suffix.unshift(basename(existing));
            existing = parent;
        }
    }
}
export async function createRepairSandbox(sourceRoot, options = {}) {
    const source = await realpath(sourceRoot);
    if (!(await stat(source)).isDirectory())
        throw new Error("Repair source root must be a directory");
    const tempParent = await canonicalPotentialPath(options.temp_parent ?? tmpdir());
    if (isContained(source, tempParent)) {
        throw new Error("Temporary sandbox parent must not be inside the source repository");
    }
    await mkdir(tempParent, { recursive: true });
    const root = await mkdtemp(join(tempParent, "archsync-repair-"));
    const workspace = join(root, "workspace");
    try {
        if (options.copy_tree) {
            await options.copy_tree(source, workspace);
        }
        else {
            await cp(source, workspace, {
                recursive: true,
                dereference: false,
                errorOnExist: true,
                force: false,
                verbatimSymlinks: true,
                filter: (entry) => shouldCopySandboxEntry(relative(source, entry)),
            });
        }
    }
    catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
    let cleaned = false;
    return {
        root,
        workspace,
        resolve_path: (path) => resolveSandboxPath(workspace, path),
        cleanup: async () => {
            if (cleaned)
                return;
            cleaned = true;
            await rm(root, { recursive: true, force: true });
        },
    };
}
function parsePatchHeaderPath(value, prefix) {
    if (value === "/dev/null")
        return value;
    if (value.includes("\t") || value.startsWith('"') || !value.startsWith(prefix))
        return undefined;
    return value.slice(2);
}
function patchSections(unifiedDiff) {
    const lines = unifiedDiff.replace(/\r\n/gu, "\n").split("\n");
    const starts = lines.flatMap((line, index) => line.startsWith("diff --git ") ? [index] : []);
    if (starts.length === 0 || lines.slice(0, starts[0]).some((line) => line !== ""))
        return undefined;
    return starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length));
}
function validatePatchSection(section) {
    const header = section[0];
    if (section.some((line) => /^(?:old mode|new mode|similarity index|rename from|rename to|copy from|copy to|index [^ ]+ 120000|new file mode (?!100644$))/u.test(line))) {
        return failure("UNSUPPORTED_PATCH", "Only textual add, modify, and delete patches are accepted");
    }
    const oldIndex = section.findIndex((line) => line.startsWith("--- "));
    const newIndex = section.findIndex((line) => line.startsWith("+++ "));
    if (section.some((line) => line.startsWith("@@@ "))) {
        return failure("UNSUPPORTED_PATCH", "Combined diffs are not accepted");
    }
    if (oldIndex < 0 || newIndex !== oldIndex + 1 || !section.some((line) => line.startsWith("@@ "))) {
        return failure("UNSUPPORTED_PATCH", "Each file patch must contain adjacent ---/+++ headers and a unified hunk");
    }
    const oldPath = parsePatchHeaderPath(section[oldIndex].slice(4), "a/");
    const newPath = parsePatchHeaderPath(section[newIndex].slice(4), "b/");
    if (!oldPath || !newPath || (oldPath === "/dev/null" && newPath === "/dev/null")) {
        return failure("UNSUPPORTED_PATCH", "Patch file headers are malformed");
    }
    const path = oldPath === "/dev/null" ? newPath : oldPath;
    if (oldPath !== "/dev/null" && newPath !== "/dev/null" && oldPath !== newPath) {
        return failure("UNSUPPORTED_PATCH", "Renames are not accepted in repair candidates");
    }
    const expectedHeader = `diff --git a/${path} b/${path}`;
    if (header !== expectedHeader) {
        return failure("UNSUPPORTED_PATCH", "The diff header must exactly match its file headers");
    }
    return normalizedRepairPath(path);
}
export function validateRepairCandidate(candidate) {
    if (validateProposedRepairCandidateShape(candidate).length > 0) {
        return failure("INVALID_CANDIDATE", "Repair candidate contract or provider hand-off status is invalid");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.candidate_id) ||
        candidate.target_block_finding_fingerprints.length === 0 ||
        new Set(candidate.target_block_finding_fingerprints).size !== candidate.target_block_finding_fingerprints.length ||
        candidate.target_block_finding_fingerprints.some((value) => value.length === 0) ||
        candidate.files.length === 0 ||
        Buffer.byteLength(candidate.unified_diff, "utf8") > maximumPatchBytes ||
        !candidate.unified_diff.endsWith("\n") ||
        candidate.unified_diff.includes("\0")) {
        return failure("INVALID_CANDIDATE", "Repair candidate schema, identifiers, or patch size are invalid");
    }
    if (/^(?:GIT binary patch|Binary files )/mu.test(candidate.unified_diff)) {
        return failure("BINARY_PATCH", "Binary patches are not accepted");
    }
    const expectedPaths = new Map();
    for (const expectation of candidate.files) {
        const path = normalizedRepairPath(expectation.path);
        if (typeof path !== "string")
            return path;
        if (expectedPaths.has(path) ||
            (expectation.base_sha256 !== null && !/^[a-f0-9]{64}$/u.test(expectation.base_sha256))) {
            return failure("INVALID_CANDIDATE", "Expected files must be unique and use lowercase SHA-256 values");
        }
        expectedPaths.set(path, expectation);
    }
    const sections = patchSections(candidate.unified_diff);
    if (!sections)
        return failure("UNSUPPORTED_PATCH", "A repair must be a git-style unified diff");
    const paths = [];
    for (const section of sections) {
        const path = validatePatchSection(section);
        if (typeof path !== "string")
            return path;
        if (paths.includes(path))
            return failure("UNSUPPORTED_PATCH", `Path '${path}' appears more than once`);
        paths.push(path);
    }
    const sortedPaths = [...paths].sort();
    const sortedExpected = [...expectedPaths.keys()].sort();
    if (sortedPaths.length !== sortedExpected.length || sortedPaths.some((path, index) => path !== sortedExpected[index])) {
        return failure("UNEXPECTED_PATH", "The patch paths must exactly match the candidate file manifest");
    }
    return { ok: true, paths: sortedPaths };
}
async function assertNoSymlinkSegments(root, path) {
    const segments = path.split("/");
    for (let index = 0; index < segments.length; index += 1) {
        const candidate = join(root, ...segments.slice(0, index + 1));
        try {
            const metadata = await lstat(candidate);
            if (metadata.isSymbolicLink())
                throw new Error(`SYMLINK_PATH: '${path}' crosses a symbolic link`);
            if (index < segments.length - 1 && !metadata.isDirectory()) {
                throw new Error(`DIRTY_WORKSPACE: Parent of '${path}' is not a directory`);
            }
        }
        catch (error) {
            if (error.code === "ENOENT")
                return;
            throw error;
        }
    }
}
async function fileSha256(root, path) {
    await assertNoSymlinkSegments(root, path);
    const absolute = resolveSandboxPath(root, path);
    try {
        const metadata = await lstat(absolute);
        if (!metadata.isFile())
            throw new Error(`DIRTY_WORKSPACE: '${path}' is not a regular file`);
        return createHash("sha256").update(await readFile(absolute)).digest("hex");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return null;
        throw error;
    }
}
export async function executeProcess(invocation) {
    try {
        const { stdout, stderr } = await execFileAsync(invocation.command, invocation.args, {
            cwd: invocation.cwd,
            env: invocation.env,
            encoding: "utf8",
            maxBuffer: invocation.max_output_bytes,
            timeout: invocation.timeout_ms,
            killSignal: "SIGKILL",
            windowsHide: true,
        });
        return { exit_code: 0, stdout, stderr, timed_out: false };
    }
    catch (error) {
        const value = error;
        return {
            exit_code: typeof value.code === "number" ? value.code : null,
            stdout: value.stdout ?? "",
            stderr: value.stderr ?? value.message,
            timed_out: value.killed === true && value.signal === "SIGKILL",
            ...(typeof value.code === "string" ? { infrastructure_error: value.code } : {}),
        };
    }
}
export function networkSandboxInvocation(platform, command, args) {
    if (platform === "darwin") {
        return {
            command: "/usr/bin/sandbox-exec",
            args: ["-p", "(version 1) (allow default) (deny network*)", "--", command, ...args],
        };
    }
    if (platform === "linux") {
        return {
            command: "unshare",
            args: ["--user", "--map-root-user", "--net", "--", command, ...args],
        };
    }
    return undefined;
}
export function createPlatformNoNetworkExecutor(platform = process.platform, runner = executeProcess) {
    if (!networkSandboxInvocation(platform, "probe", []))
        return undefined;
    return {
        network_isolation: "ENFORCED",
        execute: async (invocation) => {
            const wrapped = networkSandboxInvocation(platform, invocation.command, invocation.args);
            const result = await runner({ ...invocation, ...wrapped });
            if ((platform === "linux" && /^unshare: .*Operation not permitted/imu.test(result.stderr)) ||
                (platform === "darwin" && /sandbox-exec: .*not permitted/iu.test(result.stderr))) {
                return { ...result, infrastructure_error: "NETWORK_SANDBOX_UNAVAILABLE" };
            }
            return result;
        },
    };
}
export function sandboxEnvironment(workspace, source = process.env) {
    const environment = {};
    for (const key of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL"]) {
        if (source[key] !== undefined)
            environment[key] = source[key];
    }
    const offlineProxy = "http://127.0.0.1:9";
    return {
        ...environment,
        CI: "true",
        ARCHSYNC_NETWORK_POLICY: "deny",
        HTTP_PROXY: offlineProxy,
        HTTPS_PROXY: offlineProxy,
        ALL_PROXY: offlineProxy,
        http_proxy: offlineProxy,
        https_proxy: offlineProxy,
        all_proxy: offlineProxy,
        NO_PROXY: "",
        no_proxy: "",
        npm_config_offline: "true",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_cache: join(workspace, ".archsync-tmp", "npm-cache"),
        YARN_ENABLE_NETWORK: "0",
        XDG_CACHE_HOME: join(workspace, ".archsync-tmp", "cache"),
        XDG_CONFIG_HOME: join(workspace, ".archsync-tmp", "config"),
        TMPDIR: join(workspace, ".archsync-tmp"),
        TEMP: join(workspace, ".archsync-tmp"),
        TMP: join(workspace, ".archsync-tmp"),
    };
}
export function sanitizeVerificationLog(value, sandboxRoot, sensitiveValues = [], maximumBytes = defaultMaximumLogBytes) {
    let sanitized = value
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
        .replaceAll(sandboxRoot, "<SANDBOX>")
        .replaceAll(sandboxRoot.split(sep).join("/"), "<SANDBOX>")
        .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gu, "$1<REDACTED>@")
        .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/giu, "$1 <REDACTED>")
        .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s]+/giu, "$1=<REDACTED>");
    for (const secret of sensitiveValues.filter((item) => item.length >= 4)) {
        sanitized = sanitized.replaceAll(secret, "<REDACTED>");
    }
    const encoded = Buffer.from(sanitized, "utf8");
    return encoded.byteLength <= maximumBytes
        ? sanitized
        : `${encoded.subarray(0, maximumBytes).toString("utf8")}\n<LOG_TRUNCATED>`;
}
function commandIsAllowed(command, allowlist) {
    return command === basename(command) && allowlist.includes(command.toLowerCase());
}
export async function runSandboxCommand(sandbox, command, options = {}) {
    const started = Date.now();
    const allowlist = options.allowlist ?? defaultSandboxCommandAllowlist;
    if (!commandIsAllowed(command.command, allowlist)) {
        return {
            status: "INCONCLUSIVE",
            command: command.command,
            args: command.args,
            exit_code: null,
            duration_ms: Date.now() - started,
            stdout: "",
            stderr: "",
            reason: "COMMAND_NOT_ALLOWED",
        };
    }
    if (command.args.some((argument) => argument.includes("\0"))) {
        return {
            status: "INCONCLUSIVE",
            command: command.command,
            args: command.args,
            exit_code: null,
            duration_ms: Date.now() - started,
            stdout: "",
            stderr: "",
            reason: "INVALID_COMMAND_ARGUMENT",
        };
    }
    const executor = options.executor === undefined
        ? createPlatformNoNetworkExecutor()
        : options.executor;
    if (!executor) {
        return {
            status: "INCONCLUSIVE",
            command: command.command,
            args: command.args,
            exit_code: null,
            duration_ms: Date.now() - started,
            stdout: "",
            stderr: "",
            reason: "NETWORK_SANDBOX_UNAVAILABLE",
        };
    }
    const timeout = options.timeout_ms ?? defaultTestTimeoutMs;
    if (!Number.isInteger(timeout) || timeout <= 0 || timeout > maximumTestTimeoutMs) {
        return {
            status: "INCONCLUSIVE",
            command: command.command,
            args: command.args,
            exit_code: null,
            duration_ms: Date.now() - started,
            stdout: "",
            stderr: "",
            reason: "INVALID_TIMEOUT",
        };
    }
    await mkdir(join(sandbox.workspace, ".archsync-tmp"), { recursive: true });
    let result;
    try {
        result = await executor.execute({
            command: command.command,
            args: command.args,
            cwd: sandbox.workspace,
            env: sandboxEnvironment(sandbox.workspace),
            timeout_ms: timeout,
            max_output_bytes: defaultMaximumLogBytes,
        });
    }
    catch (error) {
        return {
            status: "INCONCLUSIVE",
            command: command.command,
            args: command.args,
            exit_code: null,
            duration_ms: Date.now() - started,
            stdout: "",
            stderr: sanitizeVerificationLog(error.message, sandbox.root, options.sensitive_values),
            reason: "COMMAND_EXECUTOR_FAILED",
        };
    }
    const output = {
        stdout: sanitizeVerificationLog(result.stdout, sandbox.root, options.sensitive_values),
        stderr: sanitizeVerificationLog(result.stderr, sandbox.root, options.sensitive_values),
    };
    const common = {
        command: command.command,
        args: command.args,
        exit_code: result.exit_code,
        duration_ms: Date.now() - started,
        ...output,
    };
    if (result.timed_out)
        return { status: "TIMEOUT", ...common, reason: "TEST_TIMEOUT" };
    if (result.infrastructure_error) {
        return { status: "INCONCLUSIVE", ...common, reason: result.infrastructure_error };
    }
    return result.exit_code === 0
        ? { status: "PASS", ...common }
        : { status: "FAIL", ...common, reason: "TEST_EXIT_NONZERO" };
}
async function exists(path) {
    return stat(path).then(() => true, () => false);
}
export async function detectProjectTestCommand(workspace) {
    const packagePath = join(workspace, "package.json");
    if (!(await exists(packagePath)))
        return undefined;
    let manifest;
    try {
        manifest = JSON.parse(await readFile(packagePath, "utf8"));
    }
    catch {
        return undefined;
    }
    if (!manifest.scripts?.test)
        return undefined;
    if (await exists(join(workspace, "pnpm-lock.yaml")))
        return { command: "pnpm", args: ["test"] };
    if (await exists(join(workspace, "yarn.lock")))
        return { command: "yarn", args: ["test"] };
    if (await exists(join(workspace, "bun.lock")) || await exists(join(workspace, "bun.lockb"))) {
        return { command: "bun", args: ["test"] };
    }
    return { command: "npm", args: ["test"] };
}
export async function runProjectTests(sandbox, options = {}) {
    const command = options.command ?? await detectProjectTestCommand(sandbox.workspace);
    if (!command) {
        return {
            status: "INCONCLUSIVE",
            command: "",
            args: [],
            exit_code: null,
            duration_ms: 0,
            stdout: "",
            stderr: "",
            reason: "TEST_COMMAND_NOT_FOUND",
        };
    }
    return runSandboxCommand(sandbox, command, options);
}
export function gitEnvironment(platform = process.platform) {
    return {
        PATH: process.env.PATH,
        PATHEXT: process.env.PATHEXT,
        SYSTEMROOT: process.env.SYSTEMROOT,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    };
}
export async function applyRepairCandidate(sandbox, candidate, runner = executeProcess) {
    const validation = validateRepairCandidate(candidate);
    if (!validation.ok) {
        return { status: "REJECTED", code: validation.code, message: validation.message, paths: [] };
    }
    const before = {};
    try {
        for (const expectation of candidate.files) {
            const actual = await fileSha256(sandbox.workspace, expectation.path);
            before[expectation.path] = actual;
            if (actual !== expectation.base_sha256) {
                return {
                    status: "REJECTED",
                    code: "DIRTY_WORKSPACE",
                    message: `Workspace content for '${expectation.path}' does not match its declared base hash`,
                    paths: validation.paths,
                };
            }
        }
    }
    catch (error) {
        const message = error.message;
        const code = message.startsWith("SYMLINK_PATH") ? "SYMLINK_PATH" : "DIRTY_WORKSPACE";
        return { status: "REJECTED", code, message, paths: validation.paths };
    }
    const patchFile = join(sandbox.root, "candidate.patch");
    await writeFile(patchFile, candidate.unified_diff, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
        const common = {
            command: "git",
            cwd: sandbox.workspace,
            env: gitEnvironment(),
            timeout_ms: 30_000,
            max_output_bytes: defaultMaximumLogBytes,
        };
        const deterministicGitConfig = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
        const checked = await runner({
            ...common,
            args: [...deterministicGitConfig, "apply", "--check", "--recount", "--whitespace=error-all", patchFile],
        });
        if (checked.timed_out || checked.infrastructure_error) {
            return {
                status: "INCONCLUSIVE",
                code: "GIT_UNAVAILABLE",
                message: "Git could not complete the patch preflight",
                paths: validation.paths,
            };
        }
        if (checked.exit_code !== 0) {
            return {
                status: "REJECTED",
                code: "PATCH_DOES_NOT_APPLY",
                message: "The unified diff does not apply cleanly to the declared base files",
                paths: validation.paths,
            };
        }
        const applied = await runner({
            ...common,
            args: [...deterministicGitConfig, "apply", "--recount", "--whitespace=error-all", patchFile],
        });
        if (applied.timed_out || applied.infrastructure_error) {
            return {
                status: "INCONCLUSIVE",
                code: "GIT_UNAVAILABLE",
                message: "Git could not complete the patch application",
                paths: validation.paths,
            };
        }
        if (applied.exit_code !== 0) {
            return {
                status: "REJECTED",
                code: "PATCH_APPLY_FAILED",
                message: "The workspace changed between patch preflight and application",
                paths: validation.paths,
            };
        }
        const after = {};
        for (const path of validation.paths)
            after[path] = await fileSha256(sandbox.workspace, path);
        if (validation.paths.some((path) => before[path] === after[path])) {
            return {
                status: "REJECTED",
                code: "PATCH_NO_EFFECT",
                message: "Every declared repair file must change",
                paths: validation.paths,
            };
        }
        return {
            status: "APPLIED",
            paths: validation.paths,
            before_sha256: before,
            after_sha256: after,
        };
    }
    finally {
        await rm(patchFile, { force: true });
    }
}
export function guardianFindingFingerprint(finding) {
    const source = finding.source_evidence
        .map(({ file, line, column, detector }) => `${file}:${line}:${column}:${detector}`)
        .sort()
        .join(",");
    return [
        finding.id,
        finding.rule_id ?? "",
        finding.edge?.key ?? "",
        finding.component ?? "",
        finding.change ?? "",
        source,
    ].map(encodeURIComponent).join("|");
}
export function guardianResultToRepairSnapshot(result) {
    const blockFindings = result.decision === "BLOCK"
        ? result.findings.filter(({ rule_id }) => rule_id !== undefined).map(guardianFindingFingerprint)
        : [];
    return {
        status: "COMPLETE",
        decision: result.decision,
        block_finding_fingerprints: [...new Set(blockFindings)].sort(),
    };
}
export function normalizeRepairConformanceSnapshot(snapshot) {
    if (snapshot.status === "ERROR")
        return snapshot;
    const values = snapshot.block_finding_fingerprints;
    if (values.some((value) => value.length === 0) ||
        (snapshot.decision === "BLOCK" ? values.length === 0 : values.length > 0)) {
        return { status: "ERROR", message: "ArchSync recheck returned an inconsistent BLOCK finding set" };
    }
    return { ...snapshot, block_finding_fingerprints: [...new Set(values)].sort() };
}
async function safeRecheck(recheck, workspace, stage, sensitiveValues) {
    try {
        return normalizeRepairConformanceSnapshot(await recheck(workspace, stage));
    }
    catch (error) {
        return {
            status: "ERROR",
            message: sanitizeVerificationLog(error.message, workspace, sensitiveValues),
        };
    }
}
export function compareRepairConformance(targets, baseline, candidate) {
    const baselineSet = new Set(baseline.block_finding_fingerprints);
    const candidateSet = new Set(candidate.block_finding_fingerprints);
    return {
        baseline_block_finding_fingerprints: [...baselineSet].sort(),
        candidate_block_finding_fingerprints: [...candidateSet].sort(),
        missing_target_finding_fingerprints: targets.filter((value) => !baselineSet.has(value)).sort(),
        remaining_target_finding_fingerprints: targets.filter((value) => candidateSet.has(value)).sort(),
        new_block_finding_fingerprints: [...candidateSet].filter((value) => !baselineSet.has(value)).sort(),
    };
}
export function decideRepairVerification(input) {
    if (input.patch_status === "REJECTED") {
        return { decision: "REJECT_UNSAFE", reason: "The candidate patch failed a safety or clean-apply gate" };
    }
    if (input.patch_status === "INCONCLUSIVE") {
        return { decision: "INCONCLUSIVE", reason: "Patch verification infrastructure did not complete" };
    }
    if (input.tests_status === "TIMEOUT" || input.tests_status === "INCONCLUSIVE" || input.tests_status === undefined) {
        return { decision: "INCONCLUSIVE", reason: "Project tests did not complete conclusively" };
    }
    if (input.tests_status === "FAIL") {
        return { decision: "REJECT_TEST", reason: "The candidate failed the project test command" };
    }
    if (!input.recheck_complete || input.missing_targets > 0) {
        return { decision: "INCONCLUSIVE", reason: "ArchSync could not establish a comparable target baseline" };
    }
    if (input.remaining_targets > 0 || input.new_blocks > 0) {
        return { decision: "REJECT_CONFORMANCE", reason: "Target or newly introduced BLOCK findings remain" };
    }
    return {
        decision: "ACCEPTABLE_FOR_REVIEW",
        reason: "The patch applied safely, tests passed, targets cleared, and no new BLOCK finding appeared",
    };
}
/**
 * Binds an offline verifier result to the canonical P4-103 candidate. This is
 * the only automated transition to VERIFIED_FOR_REVIEW; it never records a
 * human approval or changes the architecture decision.
 */
export function bindRepairVerificationResult(candidate, result) {
    if (validateProposedRepairCandidateShape(candidate).length > 0) {
        throw new Error("Only an unverified PROPOSED candidate can receive verifier evidence");
    }
    if (candidate.candidate_id !== result.candidate_id) {
        throw new Error("Repair verification candidate ID does not match");
    }
    const tests = result.tests?.status === "PASS"
        ? "pass"
        : result.tests?.status === "FAIL"
            ? "fail"
            : "not-run";
    const conformance = result.conformance === null
        ? "not-run"
        : result.conformance.missing_target_finding_fingerprints.length === 0 &&
            result.conformance.remaining_target_finding_fingerprints.length === 0 &&
            result.conformance.new_block_finding_fingerprints.length === 0
            ? "pass"
            : "fail";
    const verification = {
        decision: result.decision,
        tests,
        conformance,
        safe_apply: result.patch.status === "APPLIED",
        new_blocking_findings: result.conformance?.new_block_finding_fingerprints.length ?? 0,
    };
    const reviewable = result.decision === "ACCEPTABLE_FOR_REVIEW" &&
        verification.tests === "pass" && verification.conformance === "pass" && verification.safe_apply;
    return {
        ...candidate,
        status: reviewable ? "VERIFIED_FOR_REVIEW" : "PROPOSED",
        verification,
    };
}
function emptyPatchFailure(candidate, validation) {
    return {
        schema_version: repairVerificationSchemaVersion,
        candidate_id: candidate.candidate_id,
        decision: "REJECT_UNSAFE",
        reason: validation.message,
        patch: { status: "REJECTED", code: validation.code, message: validation.message, paths: [] },
        tests: null,
        conformance: null,
        sandbox_cleanup: "NOT_CREATED",
    };
}
export async function verifyRepairCandidate(options) {
    const validation = validateRepairCandidate(options.candidate);
    if (!validation.ok)
        return emptyPatchFailure(options.candidate, validation);
    let sandbox;
    try {
        const sandboxFactory = options.sandbox_factory ?? createRepairSandbox;
        sandbox = await sandboxFactory(options.source_root, {
            ...(options.temp_parent ? { temp_parent: options.temp_parent } : {}),
        });
    }
    catch (error) {
        return {
            schema_version: repairVerificationSchemaVersion,
            candidate_id: options.candidate.candidate_id,
            decision: "INCONCLUSIVE",
            reason: `Sandbox creation failed: ${error.message}`,
            patch: { status: "INCONCLUSIVE", code: "NOT_ATTEMPTED", message: "Sandbox was not created", paths: validation.paths },
            tests: null,
            conformance: null,
            sandbox_cleanup: "NOT_CREATED",
        };
    }
    let result;
    try {
        const baseline = await safeRecheck(options.recheck, sandbox.workspace, "BASELINE", options.sensitive_values ?? []);
        if (baseline.status === "ERROR") {
            result = {
                schema_version: repairVerificationSchemaVersion,
                candidate_id: options.candidate.candidate_id,
                decision: "INCONCLUSIVE",
                reason: baseline.message,
                patch: { status: "INCONCLUSIVE", code: "NOT_ATTEMPTED", message: "Baseline recheck did not complete", paths: validation.paths },
                tests: null,
                conformance: null,
                sandbox_cleanup: "COMPLETED",
            };
        }
        else {
            const missingTargets = options.candidate.target_block_finding_fingerprints
                .filter((value) => !baseline.block_finding_fingerprints.includes(value));
            if (missingTargets.length > 0) {
                const comparison = compareRepairConformance(options.candidate.target_block_finding_fingerprints, baseline, baseline);
                result = {
                    schema_version: repairVerificationSchemaVersion,
                    candidate_id: options.candidate.candidate_id,
                    decision: "INCONCLUSIVE",
                    reason: "One or more declared target BLOCK findings are absent from the baseline recheck",
                    patch: { status: "INCONCLUSIVE", code: "NOT_ATTEMPTED", message: "Target baseline mismatch", paths: validation.paths },
                    tests: null,
                    conformance: comparison,
                    sandbox_cleanup: "COMPLETED",
                };
            }
            else {
                const patch = await applyRepairCandidate(sandbox, options.candidate, options.process_runner ?? executeProcess);
                if (patch.status !== "APPLIED") {
                    const decision = decideRepairVerification({
                        patch_status: patch.status,
                        recheck_complete: true,
                        missing_targets: 0,
                        remaining_targets: 0,
                        new_blocks: 0,
                    });
                    result = {
                        schema_version: repairVerificationSchemaVersion,
                        candidate_id: options.candidate.candidate_id,
                        ...decision,
                        patch,
                        tests: null,
                        conformance: null,
                        sandbox_cleanup: "COMPLETED",
                    };
                }
                else {
                    const tests = await runProjectTests(sandbox, {
                        ...(options.test_command ? { command: options.test_command } : {}),
                        ...(options.command_executor !== undefined ? { executor: options.command_executor } : {}),
                        ...(options.timeout_ms !== undefined ? { timeout_ms: options.timeout_ms } : {}),
                        ...(options.sensitive_values ? { sensitive_values: options.sensitive_values } : {}),
                    });
                    const candidate = await safeRecheck(options.recheck, sandbox.workspace, "CANDIDATE", options.sensitive_values ?? []);
                    const comparison = candidate.status === "COMPLETE"
                        ? compareRepairConformance(options.candidate.target_block_finding_fingerprints, baseline, candidate)
                        : null;
                    const decision = decideRepairVerification({
                        patch_status: patch.status,
                        tests_status: tests.status,
                        recheck_complete: candidate.status === "COMPLETE",
                        missing_targets: 0,
                        remaining_targets: comparison?.remaining_target_finding_fingerprints.length ?? 0,
                        new_blocks: comparison?.new_block_finding_fingerprints.length ?? 0,
                    });
                    result = {
                        schema_version: repairVerificationSchemaVersion,
                        candidate_id: options.candidate.candidate_id,
                        ...decision,
                        patch,
                        tests,
                        conformance: comparison,
                        sandbox_cleanup: "COMPLETED",
                    };
                }
            }
        }
    }
    catch (error) {
        result = {
            schema_version: repairVerificationSchemaVersion,
            candidate_id: options.candidate.candidate_id,
            decision: "INCONCLUSIVE",
            reason: sanitizeVerificationLog(error.message, sandbox.root, options.sensitive_values),
            patch: { status: "INCONCLUSIVE", code: "GIT_UNAVAILABLE", message: "Verification pipeline failed", paths: validation.paths },
            tests: null,
            conformance: null,
            sandbox_cleanup: "COMPLETED",
        };
    }
    try {
        await sandbox.cleanup();
    }
    catch (error) {
        return {
            ...result,
            decision: "INCONCLUSIVE",
            reason: `Sandbox cleanup failed: ${error.message}`,
            sandbox_cleanup: "FAILED",
        };
    }
    return result;
}
//# sourceMappingURL=repair-verification.js.map