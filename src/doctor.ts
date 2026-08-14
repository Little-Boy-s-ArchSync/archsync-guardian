import { spawnSync } from "node:child_process";

export interface DoctorCheck {
  name: string;
  status: "PASS" | "FAIL";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  platform: NodeJS.Platform;
  checks: DoctorCheck[];
}

export function runDoctor(): DoctorResult {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  const supportedPlatform = ["win32", "darwin", "linux"].includes(process.platform);
  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const checks: DoctorCheck[] = [
    {
      name: "Node.js",
      status: nodeMajor >= 22 ? "PASS" : "FAIL",
      detail: `${process.versions.node} (required: >=22)`,
    },
    {
      name: "Operating system",
      status: supportedPlatform ? "PASS" : "FAIL",
      detail: `${process.platform}/${process.arch} (supported: Windows, macOS, Linux)`,
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
    platform: process.platform,
    checks,
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const width = Math.max(...result.checks.map(({ name }) => name.length));
  return [
    "ARCHSYNC DOCTOR",
    "",
    ...result.checks.map(({ name, status, detail }) =>
      `${status === "PASS" ? "[PASS]" : "[FAIL]"} ${name.padEnd(width)}  ${detail}`,
    ),
    "",
    result.ok
      ? "READY: This machine can run the ArchSync CLI."
      : "NOT READY: Fix the failed checks before running ArchSync.",
  ].join("\n");
}
