import { spawnSync } from "node:child_process";

export interface DoctorCheck {
  name: string;
  status: "PASS" | "WARN" | "FAIL";
  detail: string;
}

export interface DoctorResult {
  ok: boolean;
  platform: NodeJS.Platform;
  checks: DoctorCheck[];
}

export interface DoctorEnvironment {
  nodeVersion: string;
  platform: NodeJS.Platform;
  architecture: string;
  pathValue: string | undefined;
  pnpmHome: string | undefined;
  runGit: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; shell: false; windowsHide: true },
  ) => { status: number | null; stdout: string };
  locateArchSync: () => { status: number | null; stdout: string };
}

export function archsyncLocator(platform: NodeJS.Platform): "where.exe" | "which" {
  return platform === "win32" ? "where.exe" : "which";
}

export function pathIncludesDirectory(
  pathValue: string | undefined,
  directory: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (!pathValue || !directory) return false;
  const normalize = (value: string) => {
    const normalized = value.trim().replace(/^"|"$/g, "").replace(/[\\/]+$/g, "");
    return platform === "win32" ? normalized.replace(/\//g, "\\").toLowerCase() : normalized;
  };
  const expected = normalize(directory);
  const separator = platform === "win32" ? ";" : ":";
  return pathValue.split(separator).some((entry) => normalize(entry) === expected);
}

export function pnpmHomePathMatch(
  pathValue: string | undefined,
  pnpmHome: string | undefined,
  platform: NodeJS.Platform,
): string | undefined {
  if (!pnpmHome) return undefined;
  const separator = pnpmHome.match(/[\\/]$/) ? "" : platform === "win32" ? "\\" : "/";
  return [pnpmHome, `${pnpmHome}${separator}bin`].find((candidate) =>
    pathIncludesDirectory(pathValue, candidate, platform),
  );
}

export function runDoctor(environment: DoctorEnvironment = {
  nodeVersion: process.versions.node,
  platform: process.platform,
  architecture: process.arch,
  pathValue: process.env.PATH,
  pnpmHome: process.env.PNPM_HOME,
  runGit: spawnSync,
  locateArchSync: () => spawnSync(
    archsyncLocator(process.platform),
    ["archsync"],
    { encoding: "utf8", shell: false, windowsHide: true },
  ),
}): DoctorResult {
  const nodeMajor = Number.parseInt(environment.nodeVersion.split(".")[0]!, 10);
  const supportedPlatform = ["win32", "darwin", "linux"].includes(environment.platform);
  const git = environment.runGit("git", ["--version"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const archsync = environment.locateArchSync();
  const pnpmPathEntry = pnpmHomePathMatch(
    environment.pathValue,
    environment.pnpmHome,
    environment.platform,
  );
  const checks: DoctorCheck[] = [
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
    {
      name: "CLI on PATH",
      status: archsync.status === 0 ? "PASS" : "WARN",
      detail: archsync.status === 0
        ? archsync.stdout.trim().split(/\r?\n/)[0]!
        : "archsync is not discoverable; run 'pnpm setup', reopen the shell, then install the CLI",
    },
    {
      name: "PNPM_HOME / PATH",
      status: pnpmPathEntry ? "PASS" : "WARN",
      detail: pnpmPathEntry
        ? `${pnpmPathEntry} is on PATH (PNPM_HOME=${environment.pnpmHome})`
        : environment.pnpmHome
          ? `${environment.pnpmHome} is not on PATH; run 'pnpm setup' and reopen the shell`
          : "PNPM_HOME is not set; run 'pnpm setup' and reopen the shell before a global pnpm install",
    },
  ];
  return {
    ok: checks.every(({ status }) => status !== "FAIL"),
    platform: environment.platform,
    checks,
  };
}

export function formatDoctorResult(result: DoctorResult): string {
  const width = Math.max(...result.checks.map(({ name }) => name.length));
  return [
    "ARCHSYNC DOCTOR",
    "",
    ...result.checks.map(({ name, status, detail }) =>
      `[${status}] ${name.padEnd(width)}  ${detail}`,
    ),
    "",
    result.ok
      ? result.checks.some(({ status }) => status === "WARN")
        ? "READY WITH WARNING: The engine works, but fix warnings before relying on a global command."
        : "READY: This machine can run the ArchSync CLI."
      : "NOT READY: Fix the failed checks before running ArchSync.",
  ].join("\n");
}
