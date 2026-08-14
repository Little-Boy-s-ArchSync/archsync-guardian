import { spawnSync } from "node:child_process";
export function runDoctor(environment = {
    nodeVersion: process.versions.node,
    platform: process.platform,
    architecture: process.arch,
    runGit: spawnSync,
}) {
    const nodeMajor = Number.parseInt(environment.nodeVersion.split(".")[0], 10);
    const supportedPlatform = ["win32", "darwin", "linux"].includes(environment.platform);
    const git = environment.runGit("git", ["--version"], {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
    });
    const checks = [
        {
            name: "Node.js",
            status: nodeMajor >= 22 ? "PASS" : "FAIL",
            detail: `${environment.nodeVersion} (required: >=22)`,
        },
        {
            name: "Operating system",
            status: supportedPlatform ? "PASS" : "FAIL",
            detail: `${environment.platform}/${environment.architecture} (supported: Windows, macOS, Linux)`,
        },
        {
            name: "Git",
            status: git.status === 0 ? "PASS" : "FAIL",
            detail: git.status === 0 ? git.stdout.trim() : "git executable was not found",
        },
        {
            name: "ArchSync Core",
            status: "PASS",
            detail: "Architecture Model v0.1 API loaded",
        },
        {
            name: "ArchSync Guardian",
            status: "PASS",
            detail: "Analyzer v0.2 and Git-diff gate v0.3 loaded",
        },
    ];
    return {
        ok: checks.every(({ status }) => status === "PASS"),
        platform: environment.platform,
        checks,
    };
}
export function formatDoctorResult(result) {
    const width = Math.max(...result.checks.map(({ name }) => name.length));
    return [
        "ARCHSYNC DOCTOR",
        "",
        ...result.checks.map(({ name, status, detail }) => `${status === "PASS" ? "[PASS]" : "[FAIL]"} ${name.padEnd(width)}  ${detail}`),
        "",
        result.ok
            ? "READY: This machine can run the ArchSync CLI."
            : "NOT READY: Fix the failed checks before running ArchSync.",
    ].join("\n");
}
//# sourceMappingURL=doctor.js.map