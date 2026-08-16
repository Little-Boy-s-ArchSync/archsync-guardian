import { describe, expect, it } from "vitest";

import { archsyncLocator, formatDoctorResult, runDoctor } from "./doctor.js";

function gitResult(status: number, stdout = "git version 2.50.0\n") {
  return { stdout, status };
}

describe("ArchSync doctor", () => {
  it("selects the native command locator without a shell", () => {
    expect(archsyncLocator("win32")).toBe("where.exe");
    expect(archsyncLocator("linux")).toBe("which");
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
      runGit: () => gitResult(1, ""),
      locateArchSync: () => gitResult(1, ""),
    });

    expect(result.ok).toBe(false);
    expect(result.checks.slice(0, 3).map(({ status }) => status)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(result.checks.at(-1)?.status).toBe("WARN");
    expect(formatDoctorResult(result)).toContain("[FAIL] Git");
    expect(formatDoctorResult(result)).toContain("NOT READY: Fix the failed checks");
  });

  it("keeps source development usable while explaining a missing global PATH entry", () => {
    const result = runDoctor({
      nodeVersion: "22.16.0",
      platform: "win32",
      architecture: "x64",
      runGit: () => gitResult(0),
      locateArchSync: () => gitResult(1, ""),
    });

    expect(result.ok).toBe(true);
    expect(result.checks.at(-1)).toEqual({
      name: "CLI on PATH",
      status: "WARN",
      detail: "archsync is not discoverable; run 'pnpm setup', reopen the shell, then install the CLI",
    });
    expect(formatDoctorResult(result)).toContain("READY WITH WARNING");
  });
});
