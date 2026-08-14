import { describe, expect, it } from "vitest";

import { formatDoctorResult, runDoctor } from "./doctor.js";

function gitResult(status: number, stdout = "git version 2.50.0\n") {
  return { stdout, status };
}

describe("ArchSync doctor", () => {
  it("passes a supported Windows/macOS/Linux toolchain and formats aligned output", () => {
    const result = runDoctor({
      nodeVersion: "22.16.0",
      platform: "darwin",
      architecture: "arm64",
      runGit: () => gitResult(0),
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
    });

    expect(result.ok).toBe(false);
    expect(result.checks.slice(0, 3).map(({ status }) => status)).toEqual(["FAIL", "FAIL", "FAIL"]);
    expect(formatDoctorResult(result)).toContain("[FAIL] Git");
    expect(formatDoctorResult(result)).toContain("NOT READY: Fix the failed checks");
  });
});
