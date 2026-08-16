import { describe, expect, it } from "vitest";

import {
  archsyncLocator,
  formatDoctorResult,
  pathIncludesDirectory,
  pnpmHomePathMatch,
  runDoctor,
} from "./doctor.js";

function gitResult(status: number, stdout = "git version 2.50.0\n") {
  return { stdout, status };
}

describe("ArchSync doctor", () => {
  it("selects the native command locator without a shell", () => {
    expect(archsyncLocator("win32")).toBe("where.exe");
    expect(archsyncLocator("linux")).toBe("which");
  });

  it("matches PNPM_HOME against PATH with platform-aware normalization", () => {
    expect(pathIncludesDirectory("/usr/bin:/opt/pnpm/", "/opt/pnpm", "linux")).toBe(true);
    expect(pathIncludesDirectory("C:\\Windows;\"C:\\Users\\Me\\pnpm\\\"", "c:\\users\\me\\pnpm", "win32")).toBe(true);
    expect(pathIncludesDirectory("C:\\Windows;C:\\Users\\Me\\pnpm\\bin", "C:/Users/Me/pnpm/bin", "win32")).toBe(true);
    expect(pathIncludesDirectory(undefined, "/opt/pnpm", "linux")).toBe(false);
    expect(pathIncludesDirectory("/usr/bin", undefined, "linux")).toBe(false);
  });

  it("accepts both PNPM_HOME and its bin child as pnpm command directories", () => {
    expect(pnpmHomePathMatch(
      "C:\\Windows;C:\\Users\\Me\\pnpm\\bin",
      "C:\\Users\\Me\\pnpm",
      "win32",
    )).toBe("C:\\Users\\Me\\pnpm\\bin");
    expect(pnpmHomePathMatch(
      "/usr/bin:/home/me/.local/share/pnpm/bin",
      "/home/me/.local/share/pnpm/",
      "linux",
    )).toBe("/home/me/.local/share/pnpm/bin");
    expect(pnpmHomePathMatch(
      "/usr/bin:/home/me/.local/share/pnpm-other/bin",
      "/home/me/.local/share/pnpm",
      "linux",
    )).toBeUndefined();
  });

  it("passes the real Windows pnpm layout where PNPM_HOME/bin is on PATH", () => {
    const result = runDoctor({
      nodeVersion: "22.16.0",
      platform: "win32",
      architecture: "x64",
      pathValue: "C:\\Windows\\System32;C:\\Users\\test\\pnpm\\bin",
      pnpmHome: "C:\\Users\\test\\pnpm",
      runGit: () => gitResult(0),
      locateArchSync: () => gitResult(0, "C:\\Users\\test\\pnpm\\bin\\archsync.cmd\n"),
    });

    expect(result.checks.at(-1)).toEqual({
      name: "PNPM_HOME / PATH",
      status: "PASS",
      detail: "C:\\Users\\test\\pnpm\\bin is on PATH (PNPM_HOME=C:\\Users\\test\\pnpm)",
    });
    expect(formatDoctorResult(result)).toContain("READY: This machine can run the ArchSync CLI.");
  });

  it("runs the real non-shell environment probes", () => {
    const result = runDoctor();
    expect(result.platform).toBe(process.platform);
    expect(result.checks.find(({ name }) => name === "Git")?.status).toBe("PASS");
    expect(["PASS", "WARN"]).toContain(result.checks.find(({ name }) => name === "CLI on PATH")?.status);
  });

  it("passes a supported Windows/macOS/Linux toolchain and formats aligned output", () => {
    const result = runDoctor({
      nodeVersion: "22.16.0",
      platform: "darwin",
      architecture: "arm64",
      pathValue: "/usr/local/bin:/usr/bin",
      pnpmHome: "/usr/local/bin",
      runGit: () => gitResult(0),
      locateArchSync: () => gitResult(0, "/usr/local/bin/archsync\n"),
    });

    expect(result.ok).toBe(true);
    expect(result.platform).toBe("darwin");
    expect(formatDoctorResult(result)).toContain("READY: This machine can run the ArchSync CLI.");
    expect(formatDoctorResult(result)).toContain("[PASS] Operating system");
  });

  it("reports old Node, unsupported OS and a missing Git executable independently", () => {
    const result = runDoctor({
      nodeVersion: "invalid",
      platform: "aix",
      architecture: "ppc64",
      pathValue: "",
      pnpmHome: undefined,
      runGit: () => gitResult(1, ""),
      locateArchSync: () => gitResult(1, ""),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.slice(0, 3).map(({ status }) => status)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(result.checks.slice(-2).map(({ status }) => status)).toEqual(["WARN", "WARN"]);
    expect(formatDoctorResult(result)).toContain("[FAIL] Git");
    expect(formatDoctorResult(result)).toContain("NOT READY: Fix the failed checks");
  });

  it("keeps source development usable while explaining a missing global PATH entry", () => {
    const result = runDoctor({
      nodeVersion: "22.16.0",
      platform: "win32",
      architecture: "x64",
      pathValue: "C:\\Windows\\System32",
      pnpmHome: "C:\\Users\\test\\pnpm",
      runGit: () => gitResult(0),
      locateArchSync: () => gitResult(1, ""),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.at(-2)).toEqual({
      name: "CLI on PATH",
      status: "WARN",
      detail: "archsync is not discoverable; run 'pnpm setup', reopen the shell, then install the CLI",
    });
    expect(result.checks.at(-1)?.detail).toContain("is not on PATH");
    expect(formatDoctorResult(result)).toContain("READY WITH WARNING");
  });
});
